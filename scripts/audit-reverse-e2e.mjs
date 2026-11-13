// v1.0.0 - E2E audit for workers/reverse-proxy against the local harness.
//
// Prerequisites (see AUDIT.md §1/§5):
//   node scripts/audit-upstream.mjs                          (:8901 harness)
//   pnpm exec wrangler dev --config workers/reverse-proxy/wrangler.jsonc --port 8788
// Then: node scripts/audit-reverse-e2e.mjs
//
// Plain Node.js, no dependencies. Exit code 1 on any failure.

const WORKER = "http://127.0.0.1:8788";
const UPSTREAM = "http://127.0.0.1:8901";
const PROXIED = (path) => `${WORKER}/${UPSTREAM}${path}`;

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
    }
}

/** @param {string} url @param {RequestInit} init */
async function req(url, init = {}) {
    const res = await fetch(url, { redirect: "manual", ...init });
    return res;
}

async function hits(path) {
    const res = await req(`${PROXIED("/hits")}`);
    const counts = await res.json();
    return counts[path] || 0;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

console.log("reverse-proxy E2E audit (wrangler dev :8788 vs harness :8901)");

// 1. usage page
{
    const res = await req(`${WORKER}/`);
    check("usage-page", res.status === 200 && (res.headers.get("content-type") || "").includes("text/html"));
}

// 2. header filtering + referer/origin retargeting + POST body
{
    const res = await req(PROXIED("/echo?src=header-filter"), {
        method: "POST",
        body: "body-payload",
        headers: {
            Referer: `${WORKER}/${UPSTREAM}/page`,
            Origin: WORKER,
            "X-Custom": "kept",
            "User-Agent": "audit-e2e/1.0",
        },
    });
    const j = await res.json();
    check("echo-status", res.status === 200);
    // workerd dev adds its own artifacts (cf-worker header, protocol host and
    // content-length); only our filter's responsibilities are asserted here.
    const forbidden = [
        "accept-encoding",
        "connection",
        "cookie",
        "transfer-encoding",
        "keep-alive",
        "upgrade",
        "expect",
        "proxy-connection",
    ];
    check(
        "hop-headers-stripped",
        !Object.keys(j.headers).some((k) => forbidden.includes(k)),
        JSON.stringify(Object.keys(j.headers)),
    );
    check("host-retargeted", j.headers.host === "127.0.0.1:8901", j.headers.host);
    check("referer-retargeted", j.headers.referer === `${UPSTREAM}/page`, j.headers.referer);
    check("origin-retargeted", j.headers.origin === UPSTREAM, j.headers.origin);
    check("custom-header-kept", j.headers["x-custom"] === "kept");
    check("post-body-passthrough", j.body === "body-payload", j.body);
}

// 3. HTML rewriting fixture
{
    const res = await req(PROXIED("/"));
    const html = await res.text();
    check("html-ct-utf8", (res.headers.get("content-type") || "") === "text/html; charset=utf-8");
    check("html-no-store", res.headers.get("cache-control") === "no-store");
    check("abs-link-rewritten", html.includes(`href="${WORKER}/${UPSTREAM}/echo?link=abs"`));
    check("rel-link-rewritten", html.includes(`href="${WORKER}/${UPSTREAM}/echo?link=rel"`));
    check("external-link-proxied", html.includes(`href="${WORKER}/https://other-site.example/x"`));
    check("preconnect-removed", !html.includes("fonts.example.com") && !html.includes("static.example.com"));
    check("srcset-rewritten", html.includes(`srcset="${WORKER}/${UPSTREAM}/bytes 1x, ${WORKER}/${UPSTREAM}/range 2x"`));
    check("style-attr-rewritten", html.includes(`style="background: url('${WORKER}/${UPSTREAM}/css-target.png')`));
    check("style-block-rewritten", html.includes(`url("${WORKER}/${UPSTREAM}/css-target.png")`));
    check("css-import-rewritten", html.includes(`@import url("${WORKER}/${UPSTREAM}/imported.css")`));
    check("script-rewritten", html.includes(`src="${WORKER}/${UPSTREAM}/plain"`));
    check("form-action-rewritten", html.includes(`action="${WORKER}/${UPSTREAM}/form-target"`));
    check("img-src-rewritten", html.includes(`src="${WORKER}/${UPSTREAM}/bytes"`));
    const shimPos = html.indexOf('var TAG = "p');
    const firstHeadEl = html.indexOf('<link rel="stylesheet"');
    check("shim-injected-once", html.split('var TAG = "p').length === 2);
    check("shim-before-page-scripts", shimPos > 0 && shimPos < firstHeadEl, `${shimPos} vs ${firstHeadEl}`);
}

// Cacheability is asserted via upstream hit-count deltas (/hits): a cached
// second request must not reach the harness, whichever layer serves it.

// 4. CSS rewriting + edge caching of the rewritten form
{
    const before = await hits("/css");
    const first = await req(PROXIED("/css"));
    const css1 = await first.text();
    const second = await req(PROXIED("/css"));
    const css2 = await second.text();
    const after = await hits("/css");
    check("css-ct", (first.headers.get("content-type") || "") === "text/css; charset=utf-8");
    check("css-url-rel-rewritten", css1.includes(`url("${WORKER}/${UPSTREAM}/css-target.png")`));
    check("css-import-rewritten", css1.includes(`@import url("${WORKER}/${UPSTREAM}/imported.css")`));
    check(
        "css-cache-control",
        first.headers.get("cache-control") === "public, max-age=120",
        first.headers.get("cache-control"),
    );
    check("css-cached-after-first", after - before === 1, `${before} -> ${after}`);
    check("css-hit-still-rewritten", css2 === css1 && css2.length > 0 && css2.includes(WORKER), `len=${css2.length}`);
}

// 5. GBK transcoding
{
    const res = await req(PROXIED("/gbk.html"));
    const body = await res.text();
    check("gbk-ct-utf8", (res.headers.get("content-type") || "") === "text/html; charset=utf-8");
    check("gbk-decoded", body.includes("中文代理转码测试通过"), body.slice(0, 120));
}

// 6. compression: AE must not leak upstream, body always decodes. (The dev
// runtime may re-compress the client leg per the client's own Accept-Encoding;
// that is transport-level and transparent, only body integrity is asserted.)
{
    const gzipRes = await req(PROXIED("/gzip"), { headers: { "Accept-Encoding": "gzip" } });
    const gzipBody = await gzipRes.text();
    check("gzip-plain", gzipBody === "/gzip-body-ok", `${gzipBody}`);
    const brRes = await req(PROXIED("/br"), { headers: { "Accept-Encoding": "br, zstd" } });
    const brBody = await brRes.text();
    check("br-plain", brBody === "/br-body-ok", `${brBody}`);
}

// 7. redirect matrix (status preserved, Location rewritten)
{
    for (const code of [301, 302, 303, 307, 308]) {
        for (const mode of ["abs", "rel"]) {
            const res = await req(`${PROXIED("/redirect")}?code=${code}&mode=${mode}`);
            const location = res.headers.get("location") || "";
            check(
                `redirect-${code}-${mode}`,
                res.status === code && location === `${WORKER}/${UPSTREAM}/echo?src=redirect`,
                `${res.status} ${location}`,
            );
        }
    }
}

// 8. cookie namespacing round trip
{
    const set = await req(PROXIED("/cookies/set"));
    const cookies = set.headers.getSetCookie();
    const tag = cookies.length ? cookies[0].split("=")[0] || "" : "";
    check("cookies-prefixed", cookies.length === 2 && /^p[a-z0-9]+$/.test(tag), JSON.stringify(cookies));
    check(
        "cookie-domain-dropped",
        cookies.every((c) => !/domain=/i.test(c)),
        JSON.stringify(cookies),
    );
    check(
        "cookie-path-pinned",
        cookies.every((c) => /Path=\//.test(c)),
        JSON.stringify(cookies),
    );
    const echo = await req(PROXIED("/cookies/echo"), {
        headers: { Cookie: cookies.map((c) => c.split(";")[0]).join("; ") },
    });
    const j = await echo.json();
    check("cookie-unprefixed-upstream", j.cookie === "first=one; second=two", j.cookie);
    const foreign = await req(PROXIED("/cookies/echo"), { headers: { Cookie: "potherhostfirst=one" } });
    const fj = await foreign.json();
    check("foreign-tag-dropped", fj.cookie === null, fj.cookie);
}

// 9. Range + conditional requests
{
    const range = await req(PROXIED("/range"), { headers: { Range: "bytes=100-199" } });
    const body = await range.arrayBuffer();
    check("range-206", range.status === 206 && body.byteLength === 100, `${range.status} ${body.byteLength}`);
    check("range-content-range", (range.headers.get("content-range") || "").startsWith("bytes 100-199/8192"));
    const etagRes = await req(PROXIED("/etag"));
    const etag = etagRes.headers.get("etag");
    const reval = await req(PROXIED("/etag"), { headers: { "If-None-Match": etag || "" } });
    check("etag-200", etagRes.status === 200 && etag !== null);
    check("revalidate-304", reval.status === 304);
}

// 10. edge caching matrix
{
    // cacheable static asset
    const before = await hits("/bytes");
    const a = await req(PROXIED("/bytes"));
    const b = await req(PROXIED("/bytes"));
    const after = await hits("/bytes");
    check("bytes-upstream-once", after - before === 1, `${before} -> ${after}`);
    check("bytes-cc-normalized", b.headers.get("cache-control") === "public, max-age=120");
    check("bytes-size", (await b.arrayBuffer()).byteLength === 65536);
    check("bytes-bodies-identical", (await a.arrayBuffer()).byteLength === 65536);

    // big streamed asset
    const big = await req(PROXIED("/big.png"));
    check("big-bytes", (await big.arrayBuffer()).byteLength === 2 * 1024 * 1024);

    // non-cacheable variants
    for (const [name, path, expectCached] of [
        ["api-json-type", "/api.json", false],
        ["img-nostore", "/img-nostore.png", false],
        ["img-vary", "/img-vary.png", false],
        ["img-setcookie", "/img-setcookie.png", false],
        ["img-no-cc", "/img-plain.png", false],
    ]) {
        const start = await hits(path);
        await req(PROXIED(path));
        await req(PROXIED(path));
        const end = await hits(path);
        const cached = end - start === 1;
        check(`cache-gate-${name}`, cached === expectCached, `upstream hits ${end - start}, cached=${cached}`);
    }
    const setcookieRes = await req(PROXIED("/img-setcookie.png"));
    check(
        "setcookie-response-rewritten",
        setcookieRes.headers.getSetCookie().every((c) => /^p[a-z0-9]+leak=/.test(c)),
        JSON.stringify(setcookieRes.headers.getSetCookie()),
    );
}

// 11. authorization bypasses cache; userinfo in URL becomes Basic auth
{
    const start = await hits("/auth401");
    const anon = await req(PROXIED("/auth401"));
    const authed = await req(PROXIED("/auth401"), { headers: { Authorization: "Bearer audit-secret" } });
    const anonAgain = await req(PROXIED("/auth401"));
    const end = await hits("/auth401");
    check("auth-401-passthrough", anon.status === 401);
    check("auth-bearer-forwarded", authed.status === 200 && (await authed.text()) === "secret-ok");
    check(
        "auth-response-not-cached",
        anonAgain.status === 401 && end - start === 3,
        `${anonAgain.status} hits=${end - start}`,
    );
    const userinfo = await req(`${WORKER}/http://user:pass@127.0.0.1:8901/auth401`);
    check("userinfo-basic-auth", userinfo.status === 200, `${userinfo.status}`);
}

// 12. CORS preflight answered locally (no upstream hit)
{
    const start = await hits("/echo");
    const res = await req(`${WORKER}/${UPSTREAM}/echo`, {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    const end = await hits("/echo");
    check("preflight-204", res.status === 204);
    check(
        "preflight-cors",
        res.headers.get("access-control-allow-origin") === "*" &&
            res.headers.get("access-control-allow-methods") === "*",
    );
    check("preflight-no-upstream", end === start, `${start} -> ${end}`);
}

// 13. target URL edge cases
{
    const missing = await req(`${WORKER}/no-scheme-here`);
    check("missing-target-400", missing.status === 400);
    const err = await missing.json();
    check(
        "error-json-cors",
        missing.headers.get("access-control-allow-origin") === "*" && typeof err.error === "string",
    );
    const upper = await req(`${WORKER}/HTTP://127.0.0.1:8901/echo?src=upper`);
    const j = await upper.json();
    check("uppercase-scheme", upper.status === 200 && j.query.src === "upper", `${upper.status}`);
    // Bare worker path resolves against the referer's embedded target
    // (absolute pathname semantics: /bytes -> target origin /bytes).
    const referer = await req(`${WORKER}/bytes`, { headers: { Referer: `${WORKER}/${UPSTREAM}/echo` } });
    check(
        "referer-fallback",
        referer.status === 200 && (referer.headers.get("content-type") || "").startsWith("image/png"),
        `${referer.status}`,
    );
}

// 14. meta refresh rewriting + SSE passthrough
{
    const res = await req(PROXIED("/meta-refresh"));
    const html = await res.text();
    check(
        "meta-refresh-rewritten",
        html.includes(`url=${WORKER}/${UPSTREAM}/echo?src=meta-refresh`) ||
            html.includes(`url='${WORKER}/${UPSTREAM}/echo?src=meta-refresh'`),
        html.slice(0, 200),
    );
    const sse = await req(PROXIED("/sse"));
    check("sse-ct", (sse.headers.get("content-type") || "").includes("text/event-stream"));
    const reader = sse.body.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    check("sse-first-event", new TextDecoder().decode(value).includes("sse-ok"));
}

console.log(`reverse-proxy E2E audit: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
