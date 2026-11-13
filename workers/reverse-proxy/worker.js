// Description: Using Cloudflare Workers to Reverse Proxy everything.
// Version: 2.2 - upstream Accept-Encoding no longer forwarded (fixes brotli
//          corruption), edge caching for static assets, upstream Cache-Control
//          passthrough, CORS preflight answers, WebSocket error propagation,
//          wider SPA shim (EventSource/sendBeacon/Worker/form.submit/location).
//
// Usage:
//   https://worker/https://example.com/page
//   git clone https://worker/https://github.com/user/repo.git
//   new WebSocket("wss://worker/wss://example.com/ws")

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Hop-by-hop, worker-owned, and compression-negotiating request headers that
// must not reach the upstream. accept-encoding stays out so the runtime
// negotiates gzip itself and transparently decompresses - forwarding the
// client's brotli preference would return a compressed body that the dropped
// Content-Encoding header then turns into garbage at the browser.
const REQUEST_SKIP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "expect",
    "cookie",
    "host",
    "content-length",
    "accept-encoding",
]);

// Security and encoding headers that would break or re-compress the rewritten
// response. Referrer-Policy must go too: a `no-referrer` policy would starve
// the referer-based fallback that keeps unpatched relative requests proxied.
const RESPONSE_DROP_HEADERS = [
    "Content-Encoding",
    "Content-Length",
    "Content-Security-Policy",
    "Content-Security-Policy-Report-Only",
    "X-Frame-Options",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Embedder-Policy",
    "Cross-Origin-Resource-Policy",
    "Referrer-Policy",
];

const CORS_HEADERS = {
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Origin": "*",
};

// Git smart-HTTP endpoints are passed through byte-for-byte, never rewritten.
const GIT_PATH_PATTERN = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

// URL-bearing attributes rewritten on every proxied HTML element.
const REWRITE_ATTRS = ["href", "src", "srcset", "action", "formaction", "data", "poster", "style"];

// Universal selector: url-bearing attributes (style! formaction!) appear on
// arbitrary elements, not just the classic URL-carrying set.
const REWRITE_ELEMENTS = "*";

// Content types eligible for edge caching: immutable-ish static payloads whose
// URL fully identifies the content. Rewritten HTML/CSS handling lives in
// serveHtml/serveCss; APIs and HTML are never edge-cached.
const CACHEABLE_TYPES = [
    "image/",
    "font/",
    "video/",
    "audio/",
    "text/css",
    "application/javascript",
    "text/javascript",
    "application/x-javascript",
    "application/wasm",
    "application/octet-stream",
    "application/pdf",
    "model/",
];

// Requests that must bypass the shared edge cache: byte ranges, conditional
// revalidation, and anything personalized (auth, cookies).
const REQUEST_CACHE_BYPASS_HEADERS = ["range", "if-none-match", "if-modified-since", "authorization", "cookie"];

// When upstream allows caching only via "public" without max-age.
const DEFAULT_PUBLIC_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// Entry point and request pipeline
// ---------------------------------------------------------------------------

/** @param {any} e */
addEventListener("fetch", /** @param {any} e */ (e) => e.respondWith(fetchHandler(e)));

/** @param {any} e */
async function fetchHandler(e) {
    try {
        const req = e.request;
        const urlObj = new URL(req.url);

        if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
            return corsPreflight();
        }

        if (urlObj.pathname === "/" && !urlObj.search) {
            return usagePage(urlObj.origin);
        }

        const targetUrl = extractTarget(urlObj, req);
        if (!targetUrl) {
            return jsonError(`Missing or invalid target URL. Usage: ${urlObj.origin}/https://example.com/`, 400);
        }

        if ((req.headers.get("upgrade") || "").toLowerCase() === "websocket") {
            return await proxyWebSocket(req, targetUrl);
        }

        return await proxyHttp(req, targetUrl, urlObj, e);
    } catch (error) {
        console.error("reverse-proxy error:", error);
        return jsonError(error instanceof Error ? error.message : String(error), 500);
    }
}

/** @param {Request} req @param {string} targetUrl @param {URL} urlObj @param {any} event */
async function proxyHttp(req, targetUrl, urlObj, event) {
    const git = isGitTarget(targetUrl, req);
    const cacheKey = !git && cacheCandidate(req) ? new Request(req.url) : null;
    if (cacheKey) {
        const hit = await caches.default.match(cacheKey);
        if (hit) {
            return cachedResponse(hit);
        }
    }

    // URL userinfo (https://user:pass@host/) becomes a Basic Authorization
    // header; fetch() rejects URLs that still carry credentials.
    const target = new URL(targetUrl);
    let urlAuthorization = null;
    if (target.username) {
        urlAuthorization = `Basic ${btoa(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`)}`;
        target.username = "";
        target.password = "";
        targetUrl = target.href;
    }

    // GET/HEAD requests must not carry a body or fetch() throws.
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const res = await fetch(targetUrl, {
        body: hasBody ? req.body : undefined,
        headers: filterRequestHeaders(req, targetUrl, urlObj, urlAuthorization),
        method: req.method,
        redirect: "manual",
    });

    const contentType = (res.headers.get("Content-Type") || "").toLowerCase();
    // 204/304 have no body to re-wrap; git payloads must stay byte-for-byte.
    if (res.body && res.status !== 204 && res.status !== 304 && !git) {
        if (contentType.includes("text/html")) {
            return serveHtml(res, targetUrl, urlObj);
        }
        if (contentType.includes("text/css")) {
            return serveCss(res, targetUrl, urlObj, cacheKey);
        }
    }

    const headers = buildResponseHeaders(res, targetUrl, urlObj, { git });
    if (cacheKey && !git && streamCacheEligible(res, contentType)) {
        return await cacheAndStream(res, headers, cacheKey, event);
    }
    return streamResponse(res, headers);
}

/** @param {URL} urlObj @param {Request} req */
function extractTarget(urlObj, req) {
    const raw = urlObj.href
        .slice(urlObj.origin.length + 1)
        .replace(/^(https?):\/+/i, "$1://")
        .replace(/^(wss?):\/+/i, "$1://")
        .replace(/^\/\//, "https://");

    if (/^(https?|wss?):\/\//i.test(raw)) {
        try {
            return /^wss/i.test(raw) ? raw : new URL(raw).href;
        } catch {
            return null;
        }
    }
    return resolveViaReferer(urlObj, req);
}

// JS-driven navigations can land on a bare worker path; resolve them against
// the target embedded in the referer of the proxied page.
/** @param {URL} urlObj @param {Request} req */
function resolveViaReferer(urlObj, req) {
    const referer = req.headers.get("referer");
    if (!referer) {
        return null;
    }
    try {
        const ref = new URL(referer);
        if (ref.origin !== urlObj.origin) {
            return null;
        }
        const refTarget = ref.href.slice(ref.origin.length + 1);
        if (!/^https?:\/\//i.test(refTarget)) {
            return null;
        }
        return new URL(urlObj.pathname + urlObj.search, refTarget).href;
    } catch {
        return null;
    }
}

/** @param {string} targetUrl @param {Request} req */
function isGitTarget(targetUrl, req) {
    if (req.headers.get("git-protocol")) {
        return true;
    }
    try {
        return GIT_PATH_PATTERN.test(new URL(targetUrl).pathname);
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Request header handling
// ---------------------------------------------------------------------------

/** @param {Request} req @param {string} targetUrl @param {URL} urlObj @param {string | null} urlAuthorization */
function filterRequestHeaders(req, targetUrl, urlObj, urlAuthorization) {
    const out = new Headers();
    req.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!lowerKey.startsWith("cf-") && !REQUEST_SKIP_HEADERS.has(lowerKey)) {
            out.set(key, value);
        }
    });

    retargetSelfReferences(out, urlObj.origin, new URL(targetUrl).origin);

    const cookie = translateRequestCookie(req.headers.get("cookie"), hostTag(new URL(targetUrl).host));
    if (cookie) {
        out.set("cookie", cookie);
    }
    // Credentials embedded in the proxied URL override the client's header.
    if (urlAuthorization) {
        out.set("authorization", urlAuthorization);
    }
    return out;
}

// The browser saw the worker origin; the upstream expects its own.
/** @param {Headers} headers @param {string} workerOrigin @param {string} targetOrigin */
function retargetSelfReferences(headers, workerOrigin, targetOrigin) {
    const referer = headers.get("referer");
    if (referer?.startsWith(`${workerOrigin}/`)) {
        const inner = referer.slice(workerOrigin.length + 1);
        if (/^https?:\/\//i.test(inner)) {
            headers.set("referer", inner);
        } else {
            headers.delete("referer");
        }
    }
    if (headers.get("origin") === workerOrigin) {
        headers.set("origin", targetOrigin);
    }
}

// Un-prefix the namespaced cookies of the current target host; cookies of other
// target sites and worker-managed cookies never reach the upstream.
/** @param {string | null} header @param {string} tag */
function translateRequestCookie(header, tag) {
    if (!header) {
        return null;
    }
    const keep = /** @type {string[]} */ ([]);
    header.split(";").forEach((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 1) {
            return;
        }
        const name = pair.slice(0, eq).trim();
        if (name.startsWith(tag)) {
            keep.push(`${name.slice(tag.length)}=${pair.slice(eq + 1).trim()}`);
        }
    });
    return keep.length ? keep.join("; ") : null;
}

// ---------------------------------------------------------------------------
// Response header handling
// ---------------------------------------------------------------------------

/** @param {Response} res @param {string} targetUrl @param {URL} urlObj @param {{ git?: boolean }} opts */
function buildResponseHeaders(res, targetUrl, urlObj, opts) {
    const out = new Headers(res.headers);
    RESPONSE_DROP_HEADERS.forEach((name) => {
        out.delete(name);
    });
    if (!opts.git) {
        Object.entries(CORS_HEADERS).forEach(([key, value]) => {
            out.set(key, value);
        });
    }
    rewriteLocationHeader(out, targetUrl, urlObj.origin);
    if (!opts.git) {
        rewriteSetCookieHeaders(out, targetUrl);
    }
    return out;
}

/** @param {Headers} headers @param {string} targetUrl @param {string} workerOrigin */
function rewriteLocationHeader(headers, targetUrl, workerOrigin) {
    const location = headers.get("Location");
    if (!location) {
        return;
    }
    try {
        const abs = new URL(location, targetUrl);
        if (/^(https?|wss?):/i.test(abs.protocol)) {
            headers.set("Location", `${workerOrigin}/${abs.href}`);
        }
    } catch {
        // keep the original Location when it cannot be parsed
    }
}

/** @param {Headers} headers @param {string} targetUrl */
function rewriteSetCookieHeaders(headers, targetUrl) {
    if (typeof headers.getSetCookie !== "function") {
        return;
    }
    const cookies = headers.getSetCookie();
    if (!cookies.length) {
        return;
    }
    headers.delete("Set-Cookie");
    const tag = hostTag(new URL(targetUrl).host);
    cookies.forEach((cookie) => {
        headers.append("Set-Cookie", rewriteSetCookie(cookie, tag));
    });
}

// Scope every upstream cookie to the worker origin: drop Domain, pin Path=/,
// prefix the name with a per-target-host tag so sites cannot collide.
// __Host-/__Secure- prefixes lose their semantics once renamed (strip them),
// and SameSite=None without Secure is rejected by browsers, so force Secure.
/** @param {string} cookie @param {string} tag */
function rewriteSetCookie(cookie, tag) {
    const parts = cookie.split(";");
    const eq = parts[0].indexOf("=");
    if (eq > 0) {
        const name = parts[0]
            .slice(0, eq)
            .trim()
            .replace(/^__(?:Host|Secure)-/i, "");
        if (name && !name.startsWith(tag)) {
            parts[0] = `${tag}${name}=${parts[0].slice(eq + 1).trim()}`;
        }
    }
    const kept = parts.slice(1).filter((attr) => {
        const attrName = attr.trim().split("=")[0].toLowerCase();
        return attrName !== "domain" && attrName !== "path";
    });
    kept.push(" Path=/");
    const attrs = kept.map((attr) => attr.trim().toLowerCase());
    if (attrs.some((attr) => attr.startsWith("samesite=none")) && !attrs.includes("secure")) {
        kept.push(" Secure");
    }
    return [parts[0], ...kept].join(";");
}

/** @param {string} host */
function hostTag(host) {
    let hash = 5381;
    for (let i = 0; i < host.length; i++) {
        hash = ((hash << 5) + hash + host.charCodeAt(i)) >>> 0;
    }
    return `p${hash.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Edge caching
// ---------------------------------------------------------------------------

/** @param {Request} req */
function cacheCandidate(req) {
    if (req.method !== "GET") {
        return false;
    }
    return !REQUEST_CACHE_BYPASS_HEADERS.some((name) => req.headers.has(name));
}

/** @param {Response} res @param {string} contentType */
function streamCacheEligible(res, contentType) {
    return (
        res.status === 200 &&
        res.body !== null &&
        !res.headers.has("Set-Cookie") &&
        varyAllowsCaching(res.headers.get("Vary")) &&
        CACHEABLE_TYPES.some((prefix) => contentType.startsWith(prefix)) &&
        upstreamCacheTtl(res.headers.get("Cache-Control")) > 0
    );
}

// Vary must be absent or limited to content we already normalized away.
/** @param {string | null} vary */
function varyAllowsCaching(vary) {
    if (!vary) {
        return true;
    }
    return vary.split(",").every((name) => name.trim().toLowerCase() === "accept-encoding" || name.trim() === "*");
}

// Only cache when the upstream explicitly allows sharing: no no-store/no-cache/
// private, and either an explicit max-age or a public directive.
/** @param {string | null} cacheControl */
function upstreamCacheTtl(cacheControl) {
    if (!cacheControl) {
        return 0;
    }
    const directives = cacheControl.split(",").map((directive) => directive.trim().toLowerCase());
    if (
        directives.some((directive) => /^no-store|^no-cache|^private/.test(directive)) ||
        !directives.some((directive) => /^max-age=|^s-maxage=|^public$/.test(directive))
    ) {
        return 0;
    }
    for (const directive of directives) {
        const match = /^s-maxage=(\d+)/.exec(directive);
        if (match) {
            return Number(match[1]);
        }
    }
    for (const directive of directives) {
        const match = /^max-age=(\d+)/.exec(directive);
        if (match) {
            return Number(match[1]);
        }
    }
    return DEFAULT_PUBLIC_TTL_SECONDS;
}

/** @param {Response} hit */
function cachedResponse(hit) {
    const headers = new Headers(hit.headers);
    return new Response(hit.body, { status: hit.status, headers });
}

// Cache-eligible bodies up to this size are fully read and put inline
// (deterministic write); anything larger streams into the cache via
// waitUntil instead, keeping big-file TTFB streaming.
const MAX_BUFFERED_CACHE_BYTES = 8 * 1024 * 1024;

/** @param {Response} res @param {Headers} headers @param {Request} cacheKey @param {any} event */
async function cacheAndStream(res, headers, cacheKey, event) {
    const ttl = upstreamCacheTtl(res.headers.get("Cache-Control"));
    if (!res.body) {
        return streamResponse(res, headers);
    }
    headers.set("Cache-Control", `public, max-age=${ttl}`);
    const [clientBody, cacheBody] = res.body.tee();
    const storedHeaders = new Headers(headers);
    const length = Number(res.headers.get("Content-Length"));
    if (!Number.isFinite(length) || length <= MAX_BUFFERED_CACHE_BYTES) {
        // Inline await: local workerd drops waitUntil cache writes once the
        // handler has issued subrequests; production is unaffected either way.
        const buf = await new Response(cacheBody).arrayBuffer();
        await caches.default
            .put(cacheKey, new Response(buf, { status: 200, headers: storedHeaders }))
            .catch((error) => console.error("stream cache put failed:", error));
    } else {
        event.waitUntil(
            caches.default
                .put(cacheKey, new Response(cacheBody, { status: 200, headers: storedHeaders }))
                .catch((error) => console.error("stream cache put failed:", error)),
        );
    }
    return new Response(clientBody, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// URL rewriting context and text rewriting
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RewriteCtx
 * @property {string} workerOrigin
 * @property {string} targetUrl
 * @property {(value: string) => string} proxify
 */

/** @param {string} targetUrl @param {URL} urlObj @returns {RewriteCtx} */
function makeCtx(targetUrl, urlObj) {
    const workerOrigin = urlObj.origin;
    return {
        workerOrigin,
        targetUrl,
        proxify(value) {
            if (value == null) {
                return value;
            }
            const v = String(value).trim();
            if (!v || v.startsWith("#") || /^(data|blob|javascript|mailto|tel|sms|about):/i.test(v)) {
                return value;
            }
            if (/^wss?:\/\//i.test(v)) {
                return `${workerOrigin}/${v}`;
            }
            let abs;
            try {
                abs = new URL(v, targetUrl).href;
            } catch {
                return value;
            }
            if (abs.startsWith(`${workerOrigin}/`)) {
                return abs;
            }
            if (!/^https?:\/\//i.test(abs)) {
                return value;
            }
            return `${workerOrigin}/${abs}`;
        },
    };
}

/** @param {string} value @param {RewriteCtx} ctx */
function rewriteSrcset(value, ctx) {
    return value
        .split(",")
        .map((part) => {
            const trimmed = part.trim();
            if (!trimmed) {
                return part;
            }
            const m = /^(\S+)(\s[\s\S]*)?$/.exec(trimmed);
            return m ? ctx.proxify(m[1]) + (m[2] || "") : part;
        })
        .join(", ");
}

/** @param {string} css @param {RewriteCtx} ctx */
function rewriteCssText(css, ctx) {
    return css
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, quote, url) => `url(${quote}${ctx.proxify(url)}${quote})`)
        .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, quote, url) => `@import ${quote}${ctx.proxify(url)}${quote}`);
}

// ---------------------------------------------------------------------------
// Charset handling
// ---------------------------------------------------------------------------

/** @param {string | null} contentType @param {ArrayBuffer} buf */
function detectCharset(contentType, buf) {
    const fromHeader = /charset=([\w-]+)/i.exec(contentType || "");
    if (fromHeader) {
        return fromHeader[1];
    }
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    const fromMeta = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
    return fromMeta ? fromMeta[1] : "utf-8";
}

/** @param {ArrayBuffer} buf @param {string} charset */
function decodeBody(buf, charset) {
    try {
        return new TextDecoder(charset).decode(buf);
    } catch {
        return new TextDecoder("utf-8").decode(buf);
    }
}

// ---------------------------------------------------------------------------
// HTML rewriting
// ---------------------------------------------------------------------------

// Per HTML semantics, `&amp;` inside an attribute value IS `&`. Some runtime
// builds return the raw (still entity-encoded) attribute text from
// getAttribute instead of the decoded value; decoding here makes both behave
// identically - otherwise the entity's semicolon later gets percent-encoded
// (`&amp;` -> `&amp%3B`) and the upstream receives broken query parameters.
/** @param {string} value */
function decodeAttributeValue(value) {
    return value.replace(/&amp;/gi, "&");
}

class AttrRewriter {
    /** @param {RewriteCtx} ctx */
    constructor(ctx) {
        this.ctx = ctx;
    }

    /** @param {any} el */
    element(el) {
        if (el.tagName === "link") {
            const rel = (el.getAttribute("rel") || "").toLowerCase();
            if (rel === "preconnect" || rel === "dns-prefetch") {
                el.removeAttribute("href");
                return;
            }
        }
        for (const name of REWRITE_ATTRS) {
            const raw = el.getAttribute(name);
            if (raw == null || raw === "") {
                continue;
            }
            const value = decodeAttributeValue(raw);
            let next;
            if (name === "srcset") {
                next = rewriteSrcset(value, this.ctx);
            } else if (name === "style") {
                next = rewriteCssText(value, this.ctx);
            } else {
                next = this.ctx.proxify(value);
            }
            if (next !== value) {
                el.setAttribute(name, next);
            }
        }
    }
}

class MetaRefreshRewriter {
    /** @param {RewriteCtx} ctx */
    constructor(ctx) {
        this.ctx = ctx;
    }

    /** @param {any} el */
    element(el) {
        if ((el.getAttribute("http-equiv") || "").toLowerCase() !== "refresh") {
            return;
        }
        const content = el.getAttribute("content");
        if (!content) {
            return;
        }
        const m = /^\s*(.*?;\s*url\s*=\s*)([\s\S]+)$/i.exec(decodeAttributeValue(content));
        if (!m) {
            return;
        }
        const url = m[2].trim().replace(/^['"]|['"]$/g, "");
        el.setAttribute("content", m[1] + this.ctx.proxify(url));
    }
}

// <style> text arrives in chunks; buffer until the last chunk, then rewrite once.
class StyleTextRewriter {
    /** @param {RewriteCtx} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.buf = "";
    }

    /** @param {any} chunk */
    text(chunk) {
        this.buf += chunk.text;
        if (chunk.lastInTextNode) {
            chunk.replace(rewriteCssText(this.buf, this.ctx), { html: false });
            this.buf = "";
        } else {
            chunk.remove();
        }
    }
}

// The shim must run before any page script: prepend to <head>, falling back
// to <body> for documents without one (shared flag prevents double injection).
class ShimInjector {
    /** @param {string} scriptHtml @param {{ injected: boolean }} state */
    constructor(scriptHtml, state) {
        this.scriptHtml = scriptHtml;
        this.state = state;
    }

    /** @param {any} el */
    element(el) {
        if (this.state.injected) {
            return;
        }
        this.state.injected = true;
        el.prepend(this.scriptHtml, { html: true });
    }
}

/** @param {Response} res @param {string} targetUrl @param {URL} urlObj */
async function serveHtml(res, targetUrl, urlObj) {
    const buf = await res.arrayBuffer();
    const html = decodeBody(buf, detectCharset(res.headers.get("Content-Type"), buf));

    const headers = buildResponseHeaders(res, targetUrl, urlObj, {});
    headers.set("Content-Type", "text/html; charset=utf-8");
    // Rewritten pages embed the shim and per-worker origins; never cache.
    headers.set("Cache-Control", "no-store");

    const ctx = makeCtx(targetUrl, urlObj);
    const shim = clientShim(hostTag(new URL(targetUrl).host));
    const injectorState = { injected: false };
    return new HTMLRewriter()
        .on(REWRITE_ELEMENTS, new AttrRewriter(ctx))
        .on("meta", new MetaRefreshRewriter(ctx))
        .on("style", new StyleTextRewriter(ctx))
        .on("head", new ShimInjector(shim, injectorState))
        .on("body", new ShimInjector(shim, injectorState))
        .transform(new Response(html, { status: res.status, statusText: res.statusText, headers }));
}

/** @param {Response} res @param {string} targetUrl @param {URL} urlObj @param {Request | null} cacheKey */
async function serveCss(res, targetUrl, urlObj, cacheKey) {
    const buf = await res.arrayBuffer();
    const css = rewriteCssText(
        decodeBody(buf, detectCharset(res.headers.get("Content-Type"), buf)),
        makeCtx(targetUrl, urlObj),
    );

    const headers = buildResponseHeaders(res, targetUrl, urlObj, {});
    headers.set("Content-Type", "text/css; charset=utf-8");
    // The rewrite is deterministic per target URL, so the upstream policy can
    // be honored - but never cache private/non-cacheable payloads.
    const ttl = upstreamCacheTtl(res.headers.get("Cache-Control"));
    headers.set("Cache-Control", ttl > 0 ? `public, max-age=${ttl}` : "no-store");
    if (cacheKey && ttl > 0) {
        // Inline await: tiny body, and local dev drops waitUntil cache writes
        // once the handler has issued subrequests.
        await caches.default
            .put(cacheKey, new Response(css, { status: 200, headers: new Headers(headers) }))
            .catch((error) => console.error("css cache put failed:", error));
    }
    return new Response(css, { status: res.status, headers });
}

// ---------------------------------------------------------------------------
// WebSocket relay
// ---------------------------------------------------------------------------

/** @param {WebSocket} ws @param {any} event */
function closeWebSocket(ws, event) {
    try {
        // close() throws on oversized/invalid reasons; fall back to a bare close.
        ws.close(event.code, event.reason);
    } catch {
        try {
            ws.close();
        } catch {
            // already closed
        }
    }
}

/** @param {Request} req @param {string} targetUrl */
async function proxyWebSocket(req, targetUrl) {
    const upstreamUrl = targetUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
    const headers = new Headers({ Upgrade: "websocket" });
    const protocol = req.headers.get("sec-websocket-protocol");
    if (protocol) {
        headers.set("Sec-WebSocket-Protocol", protocol);
    }
    // Cookie-gated WS endpoints need the namespaced cookies translated too.
    const cookie = translateRequestCookie(req.headers.get("cookie"), hostTag(new URL(targetUrl).host));
    if (cookie) {
        headers.set("Cookie", cookie);
    }

    const res = await fetch(upstreamUrl, { headers });
    if (!res.webSocket) {
        return jsonError("Upstream did not accept the WebSocket upgrade", 502);
    }

    const upstream = res.webSocket;
    upstream.accept();
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    // RFC 6455: the handshake response must echo the upstream-selected
    // subprotocol or clients that offered one abort the connection.
    const selectedProtocol = res.headers.get("sec-websocket-protocol");

    server.addEventListener("message", (event) => {
        try {
            upstream.send(event.data);
        } catch {
            // upstream already closed
        }
    });
    upstream.addEventListener("message", (event) => {
        try {
            server.send(event.data);
        } catch {
            // client already closed
        }
    });
    server.addEventListener("close", (event) => {
        closeWebSocket(upstream, event);
    });
    upstream.addEventListener("close", (event) => {
        closeWebSocket(server, event);
    });
    // Errors (abnormal closures) must propagate to the other side or the peer
    // hangs until its own timeout.
    server.addEventListener("error", () => {
        try {
            upstream.close();
        } catch {
            // already closed
        }
    });
    upstream.addEventListener("error", () => {
        try {
            server.close();
        } catch {
            // already closed
        }
    });

    return new Response(null, {
        status: 101,
        headers: selectedProtocol ? { "Sec-WebSocket-Protocol": selectedProtocol } : undefined,
        webSocket: pair[0],
    });
}

// ---------------------------------------------------------------------------
// Small responses
// ---------------------------------------------------------------------------

/** @param {Response} res @param {Headers} headers */
function streamResponse(res, headers) {
    return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
    });
}

function corsPreflight() {
    return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400", "Cache-Control": "no-store" },
    });
}

/** @param {string} message @param {number} status */
function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS },
    });
}

/** @param {string} workerOrigin */
function usagePage(workerOrigin) {
    const body = [
        "<!doctype html><html><head><meta charset='utf-8'><title>Reverse Proxy</title></head><body>",
        "<h1>Reverse Proxy</h1>",
        "<ul>",
        `<li>Page: <code>${workerOrigin}/https://example.com/page</code></li>`,
        `<li>Git: <code>git clone ${workerOrigin}/https://github.com/user/repo.git</code></li>`,
        `<li>WebSocket: <code>new WebSocket("${workerOrigin}/wss://example.com/ws")</code></li>`,
        "</ul>",
        "</body></html>",
    ].join("");
    return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
}

// ---------------------------------------------------------------------------
// Injected client shim
// ---------------------------------------------------------------------------

// Injected into every proxied HTML page. Rewrites runtime-generated URLs
// (fetch/XHR/EventSource/sendBeacon/Worker/pushState/location/WebSocket/
// setAttribute/src-srcset properties, clicks, form submits including direct
// form.submit() calls), namespaces document.cookie per target host, rewrites
// runtime-inserted CSS url() rules, and blocks the target site's own service
// workers from taking over the proxy origin.
// String.raw keeps the regex backslashes literal inside the template literal.
/** @param {string} tag */
function clientShim(tag) {
    const code = String.raw`(function () {
  var TAG = "${tag}", W = location.origin;
  var T = location.pathname.slice(1) + location.search;
  var ABS = /^[a-z][a-z0-9+.-]*:/i;
  var SKIP = /^(?:data|blob|javascript|mailto|tel|about):/i;

  function abs(u) {
    // path-only proxy URLs ("/http://target/...") are already proxied;
    // resolving them against the target would double the prefix
    if (/^\/(?:https?|wss):\/\//i.test(u)) return W + u;
    try { return new URL(u, T).href; } catch (e) { return null; }
  }
  function px(u) {
    if (u == null) return u;
    u = String(u);
    if (!u || u.charAt(0) === "#" || SKIP.test(u)) return u;
    if (u.indexOf(W + "/") === 0) return u;
    var a = ABS.test(u) ? u : abs(u);
    if (!a) return u;
    if (/^wss?:\/\//i.test(a)) return W + "/" + a;
    if (!/^https?:\/\//i.test(a)) return u;
    return W + "/" + a;
  }
  function pxSet(v) {
    return v.split(",").map(function (part) {
      var t = part.trim();
      if (!t) return part;
      var m = t.match(/^(\S+)(\s[\s\S]*)?$/);
      return m ? px(m[1]) + (m[2] || "") : part;
    }).join(", ");
  }
  function fixState(u) {
    if (u == null) return u;
    var s = String(u);
    if (s.charAt(0) === "#" || s.indexOf(W + "/") === 0) return s;
    return px(ABS.test(s) ? s : abs(s));
  }
  function rwCss(s) {
    return String(s).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (m, q, u) {
      return "url(" + q + px(u) + q + ")";
    });
  }

  var hp = history.pushState, hr = history.replaceState;
  history.pushState = function (s, t, u) {
    return hp.call(history, s, t, u == null ? u : fixState(u));
  };
  history.replaceState = function (s, t, u) {
    return hr.call(history, s, t, u == null ? u : fixState(u));
  };

  var of = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === "string" || input instanceof URL) input = px(String(input));
      else if (input && typeof input.url === "string") input = new Request(px(input.url), input);
    } catch (e) {}
    return of.call(this, input, init);
  };

  // Request inputs constructed directly (fetch(new Request(abs)) is covered
  // above, but Request objects also flow through caches/other APIs).
  var REQ = window.Request;
  if (REQ) {
    var REQW = function (u, i) {
      try { if (typeof u === "string") u = px(u); } catch (e) {}
      return i === undefined ? new REQ(u) : new REQ(u, i);
    };
    REQW.prototype = REQ.prototype;
    window.Request = REQW;
  }

  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var rest = [].slice.call(arguments, 2);
    try { url = px(url); } catch (e) {}
    return xo.apply(this, [method, url].concat(rest));
  };

  var ws = window.WebSocket;
  window.WebSocket = function (u, p) { return new ws(px(u), p); };
  window.WebSocket.prototype = ws.prototype;
  window.WebSocket.CONNECTING = 0;
  window.WebSocket.OPEN = 1;
  window.WebSocket.CLOSING = 2;
  window.WebSocket.CLOSED = 3;

  var ES = window.EventSource;
  if (ES) {
    var ESW = function (u, c) { return new ES(px(u), c); };
    ESW.prototype = ES.prototype;
    ESW.CONNECTING = 0; ESW.OPEN = 1; ESW.CLOSED = 2;
    window.EventSource = ESW;
  }

  if (navigator.sendBeacon) {
    var sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) {
      try { u = px(u); } catch (e) {}
      return sb(u, d);
    };
  }

  var WK = window.Worker;
  if (WK) {
    var WKW = function (u, o) { return new WK(px(u), o); };
    WKW.prototype = WK.prototype;
    window.Worker = WKW;
  }

  // SharedWorker script fetches go through the proxy; fetches made inside a
  // worker realm are a documented boundary (shim only patches this realm).
  var SWK = window.SharedWorker;
  if (SWK) {
    var SWKW = function (u, o) { return new SWK(px(u), o); };
    SWKW.prototype = SWK.prototype;
    window.SharedWorker = SWKW;
  }

  var ow = window.open;
  window.open = function (u, n, f) {
    try { u = px(u); } catch (e) {}
    return ow.call(window, u, n, f);
  };

  var sat = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    try {
      var l = String(name).toLowerCase();
      if (l === "srcset") value = pxSet(value);
      else if (l === "src" || l === "href" || l === "action" || l === "formaction" || l === "poster" || l === "data") value = px(value);
    } catch (e) {}
    return sat.call(this, name, value);
  };

  var ir = CSSStyleSheet.prototype.insertRule;
  if (ir) {
    CSSStyleSheet.prototype.insertRule = function (rule, idx) {
      try { rule = rwCss(rule); } catch (e) {}
      return ir.call(this, rule, idx);
    };
  }

  function patch(ctor, prop) {
    if (!ctor) return;
    var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    if (!d || !d.set) return;
    Object.defineProperty(ctor.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set: function (v) {
        try { v = prop === "srcset" ? pxSet(String(v)) : px(v); } catch (e) {}
        d.set.call(this, v);
      },
    });
  }
  [window.HTMLImageElement, window.HTMLScriptElement, window.HTMLIFrameElement,
   window.HTMLMediaElement, window.HTMLSourceElement, window.HTMLLinkElement,
   window.HTMLFormElement, window.HTMLEmbedElement, window.HTMLTrackElement,
   window.HTMLInputElement, window.HTMLAnchorElement].forEach(function (ctor) {
    if (!ctor) return;
    patch(ctor, "src");
    patch(ctor, "href");
    patch(ctor, "srcset");
    patch(ctor, "action");
    patch(ctor, "poster");
  });

  // Direct form.submit() calls skip the submit event; retarget first.
  var fsubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    try {
      var a = this.getAttribute("action");
      if (a) {
        var n = px(a);
        if (n !== a) sat.call(this, "action", n);
      }
    } catch (e) {}
    return fsubmit.call(this);
  };

  // JS-driven absolute navigations must stay on the proxy. Location members
  // are [LegacyUnforgeable] in most engines, so these patches may no-op; the
  // known boundary (absolute location.href escapes the proxy) is documented
  // in AUDIT.md, relative navigations resolve inside the proxy URL space.
  try {
    ["assign", "replace"].forEach(function (m) {
      var orig = Location.prototype[m];
      if (!orig) return;
      Location.prototype[m] = function (u) {
        try { u = px(String(u)); } catch (e) {}
        return orig.call(this, u);
      };
    });
    var lhd = Object.getOwnPropertyDescriptor(Location.prototype, "href");
    if (lhd && lhd.set) {
      Object.defineProperty(Location.prototype, "href", {
        configurable: true,
        enumerable: lhd.enumerable,
        get: function () { return lhd.get.call(this); },
        set: function (v) {
          try { v = px(String(v)); } catch (e) {}
          lhd.set.call(this, v);
        },
      });
    }
  } catch (e) {}

  if (navigator.serviceWorker) {
    try {
      navigator.serviceWorker.register = function () {
        return Promise.reject(new Error("ServiceWorker is disabled behind this proxy"));
      };
    } catch (e) {}
  }

  var cd = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  if (cd && cd.set) {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: function () {
        var out = [];
        cd.get.call(document).split(/;\s*/).forEach(function (pair) {
          var eq = pair.indexOf("=");
          if (eq < 1) return;
          var name = pair.slice(0, eq);
          if (name.indexOf(TAG) === 0) out.push(pair.slice(TAG.length));
        });
        return out.join("; ");
      },
      set: function (v) {
        if (typeof v !== "string") { cd.set.call(document, v); return; }
        var eq = v.indexOf("=");
        if (eq < 1) { cd.set.call(document, v); return; }
        var name = v.slice(0, eq).trim();
        if (name.indexOf(TAG) === 0) { cd.set.call(document, v); return; }
        cd.set.call(document, TAG + name + v.slice(eq));
      },
    });
  }

  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    var el = t && t.closest ? t.closest("a[href],area[href]") : null;
    if (!el) return;
    var h = el.getAttribute("href");
    if (h && h.charAt(0) !== "#") {
      var n = px(h);
      if (n !== h) sat.call(el, "href", n);
    }
  }, true);
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM" || e.defaultPrevented) return;
    var a = f.getAttribute("action");
    if (a) {
      var n = px(a);
      if (n !== a) sat.call(f, "action", n);
    }
  }, true);
})();
`;
    return `<script>${code}</script>`;
}
