// Description: Using Cloudflare Workers to speed up container repo visiting.
// Version: 1.2 - off-host auth realm routing, upload-session Location rewrite,
//          redirect replay keeps HEAD, edge caching for anonymous tokens and
//          digest-addressed blobs/manifests, CORS preflight.
//
// Usage: docker.<worker-host>/v2/... proxies Docker Hub, ghcr.<worker-host>/...
// proxies GHCR, etc. Auth challenges are rewritten so `docker login` and pulls
// negotiate their tokens through the proxy as well.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Worker subdomain -> upstream registry host.
const DOMAIN_MAPPING = /** @type {{ [key: string]: string }} */ ({
    docker: "registry-1.docker.io",
    ecr: "public.ecr.aws",
    elastic: "docker.elastic.co",
    gcr: "gcr.io",
    ghcr: "ghcr.io",
    k8s: "registry.k8s.io",
    mcr: "mcr.microsoft.com",
    nvcr: "nvcr.io",
    quay: "quay.io",
});

const DOCKER_HUB_HOST = DOMAIN_MAPPING.docker;

// Auth realms that live on a different host than the registry. Their realm
// host is rewritten into the worker host (REALM_ALIAS_HOSTS below) and the
// auth path is routed back to the real auth host here, so token negotiation
// never leaves the proxy. Paths verified against each registry 2026-11.
const REGISTRY_AUTH = /** @type {{ [host: string]: { host: string, path: string } }} */ ({
    [DOCKER_HUB_HOST]: { host: "auth.docker.io", path: "/token" },
    "docker.elastic.co": { host: "docker-auth.elastic.co", path: "/auth" },
});

// Additional realm hosts (regex-escaped fragments) rewritten into the worker
// host; registries otherwise host their realm on the registry host itself.
/** @type {{ [host: string]: string[] }} */
const REALM_ALIAS_HOSTS = {
    "docker.elastic.co": ["docker-auth\\.elastic\\.co"],
};

const CORS_HEADERS = {
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    "Access-Control-Allow-Origin": "*",
};

// Digest-addressed blobs/manifests are immutable; anonymous pulls of them can
// be shared at the edge across clients (repeat pulls stop hitting upstream
// rate limits). Tag manifests and authenticated content stay no-store.
const IMMUTABLE_PATH_PATTERN = /\/v2\/.+\/(blobs|manifests)\/sha256[:-][0-9a-f]{64}$/i;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=604800";
const MAX_CACHEABLE_BYTES = 400 * 1024 * 1024; // Cloudflare edge objects cap at ~512MB
const MAX_BUFFERED_CACHE_BYTES = 8 * 1024 * 1024; // buffer puts up to this size, stream larger

// Hop-by-hop, edge-injected, and compression-negotiating headers that must
// not reach the upstream; accept-encoding stays out so cached payloads are
// always identity-encoded regardless of the client's preference.
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
    "host",
    "content-length",
    "accept-encoding",
]);

// ---------------------------------------------------------------------------
// Entry point and request pipeline
// ---------------------------------------------------------------------------

/** @param {any} e */
addEventListener("fetch", /** @param {any} e */ (e) => e.respondWith(fetchHandler(e)));

/** @param {any} e */
async function fetchHandler(e) {
    try {
        const request = e.request;
        const url = new URL(request.url);
        if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
            return corsPreflight();
        }
        const subdomain = url.hostname.split(".")[0];
        if (!Object.hasOwn(DOMAIN_MAPPING, subdomain)) {
            return jsonError("Unsupported domain", 400);
        }
        const workerOrigin = url.origin;
        // Registries are https-only in practice; keeping the ingress scheme
        // (http in local/plain-http setups) would redirect to https and the
        // followed redirect bypasses the WWW-Authenticate realm rewrite.
        url.protocol = "https:";
        url.hostname = DOMAIN_MAPPING[subdomain];
        // A custom ingress port (local dev, plain-http setups) must not leak
        // into the upstream URL - URL.hostname assignment keeps url.port.
        url.port = "";
        const upstreamHost = url.hostname;
        const isDockerHub = upstreamHost === DOCKER_HUB_HOST;

        // Off-host auth realms (auth.docker.io, docker-auth.elastic.co) are
        // rewritten into the worker host; route those paths to the real auth
        // host so `docker login` and token requests stay on the proxy.
        const auth = REGISTRY_AUTH[upstreamHost];
        if (auth && url.pathname === auth.path) {
            return proxyAuthEndpoint(request, url, auth);
        }

        const immutable = isImmutableContent(url, request);
        if (immutable) {
            const hit = await caches.default.match(cacheKey(request));
            if (hit) {
                return cachedResponse(hit);
            }
        }

        const response = await fetch(upstreamRequest(request, url));

        // Only true 3xx redirects are followed server-side; 2xx responses
        // carrying Location (blob upload sessions) are rewritten for the
        // client instead - following them would consume the session.
        if (response.status >= 300 && response.status < 400 && response.headers.has("Location")) {
            return followUpstreamRedirect(response, request, url, immutable, e);
        }

        const headers = new Headers(response.headers);
        applyCors(headers);
        if (immutable && response.status === 200 && response.body) {
            headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
            return await cacheAndStream(response, headers, request, e);
        }
        headers.set("Cache-Control", "no-store");
        rewriteAuthRealm(headers, upstreamHost, workerOrigin, isDockerHub);
        rewriteSessionLocation(headers, url, workerOrigin);
        return new Response(response.body, { status: response.status, headers });
    } catch (error) {
        console.error("container-proxy error:", error);
        return jsonError(error instanceof Error ? error.message : String(error), 500);
    }
}

// ---------------------------------------------------------------------------
// Upstream request construction
// ---------------------------------------------------------------------------

/** @param {Request} request @param {URL} url */
function upstreamRequest(request, url) {
    const headers = new Headers();
    request.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        if (!lowerKey.startsWith("cf-") && !REQUEST_SKIP_HEADERS.has(lowerKey)) {
            headers.set(key, value);
        }
    });
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    // duplex is required for streaming bodies in spec-compliant runtimes (the
    // Node unit audit) and accepted by workerd; workers-types lacks the field.
    const init = /** @type {any} */ ({
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual",
    });
    if (hasBody) {
        init.duplex = "half";
    }
    return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Auth endpoint proxying (off-host realms)
// ---------------------------------------------------------------------------

/** @param {Request} request @param {URL} url @param {{ host: string, path: string }} auth */
async function proxyAuthEndpoint(request, url, auth) {
    const upstream = `https://${auth.host}${url.pathname}${url.search}`;
    // Anonymous tokens carry no identity, so they can be shared at the edge
    // keyed by the full scope URL; authenticated logins stay private.
    const cacheable = request.method === "GET" && !request.headers.has("authorization");
    const key = cacheable ? cacheKey(request) : null;
    if (key) {
        const hit = await caches.default.match(key);
        if (hit) {
            return cachedResponse(hit);
        }
    }

    const response = await fetch(upstreamRequest(request, new URL(upstream)));
    const headers = new Headers(response.headers);
    applyCors(headers);
    headers.set("Cache-Control", "no-store");
    if (!key || response.status !== 200) {
        return new Response(response.body, { status: response.status, headers });
    }

    // Token payloads are tiny JSON; buffer to read expires_in for the TTL.
    const buf = await response.arrayBuffer();
    const ttl = tokenTtlSeconds(buf);
    if (!ttl) {
        return new Response(buf, { status: response.status, headers });
    }
    headers.set("Cache-Control", `public, max-age=${ttl}`);
    // Inline await: local workerd drops waitUntil cache writes once the
    // handler has issued subrequests; production is unaffected either way.
    await caches.default
        .put(key, new Response(buf, { status: 200, headers: new Headers(headers) }))
        .catch((error) => console.error("token cache put failed:", error));
    return new Response(buf, { status: response.status, headers });
}

/** @param {ArrayBuffer} buf */
function tokenTtlSeconds(buf) {
    try {
        const { expires_in: expiresIn } = /** @type {{ expires_in?: number }} */ (
            JSON.parse(new TextDecoder().decode(buf))
        );
        if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
            return 0;
        }
        // Leave a safety margin under the token lifetime, capped for rotation.
        return Math.max(30, Math.min(Math.floor(expiresIn) - 60, 240));
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Redirects and upload sessions
// ---------------------------------------------------------------------------

// Registries redirect layer pulls to CDNs; follow server-side so the client
// sees a single response. The CDN is a different host with a signed URL, so
// credentials are never forwarded. 307/308 and HEAD keep the original method;
// 301/302/303 rewrite to GET per HTTP semantics.
/** @param {Response} response @param {Request} request @param {URL} upstreamUrl @param {boolean} immutable @param {any} event */
async function followUpstreamRedirect(response, request, upstreamUrl, immutable, event) {
    const location = response.headers.get("Location");
    // Unreachable in practice: callers check headers.has("Location") first.
    if (!location) {
        return jsonError("Upstream redirect missing Location", 500);
    }
    let target;
    try {
        target = new URL(location, upstreamUrl);
    } catch {
        return jsonError(`Upstream redirect has invalid Location: ${location}`, 502);
    }
    const keepMethod = request.method === "HEAD" || response.status === 307 || response.status === 308;
    const headers = new Headers();
    const userAgent = request.headers.get("user-agent");
    if (userAgent) {
        headers.set("User-Agent", userAgent);
    }
    const res = await fetch(
        new Request(target, { method: keepMethod ? request.method : "GET", headers, redirect: "follow" }),
    );

    const outHeaders = new Headers(res.headers);
    applyCors(outHeaders);
    // The signed CDN URL is a poor cache key; when the *original* request was
    // digest-addressed, store the payload under the worker URL instead.
    if (immutable && res.status === 200 && res.body) {
        outHeaders.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
        const [clientBody, cacheBody] = res.body.tee();
        const storedHeaders = new Headers(outHeaders);
        const length = Number(res.headers.get("Content-Length"));
        if (!Number.isFinite(length) || length <= MAX_BUFFERED_CACHE_BYTES) {
            // Inline await keeps small-layer writes deterministic in local dev.
            await bufferOrStreamCachePut(cacheBody, storedHeaders, cacheKey(request)).catch((error) =>
                console.error("blob cache put failed:", error),
            );
        } else {
            event.waitUntil(bufferOrStreamCachePut(cacheBody, storedHeaders, cacheKey(request)).catch(() => {}));
        }
        return new Response(clientBody, { status: res.status, headers: outHeaders });
    }
    return new Response(res.body, { status: res.status, headers: outHeaders });
}

// Blob upload sessions answer 202 with a Location the client must PATCH/PUT
// through the proxy; point it back at the worker host. Cross-host locations
// stay untouched (the client follows them directly).
/** @param {Headers} headers @param {URL} upstreamUrl @param {string} workerOrigin */
function rewriteSessionLocation(headers, upstreamUrl, workerOrigin) {
    const location = headers.get("Location");
    if (!location) {
        return;
    }
    try {
        const abs = new URL(location, upstreamUrl);
        if (abs.host === upstreamUrl.host) {
            headers.set("Location", `${workerOrigin}${abs.pathname}${abs.search}`);
        }
    } catch {
        // keep the original Location when it cannot be parsed
    }
}

// ---------------------------------------------------------------------------
// Edge caching helpers
// ---------------------------------------------------------------------------

/** @param {Request} request */
function cacheKey(request) {
    return new Request(request.url);
}

/** @param {URL} url @param {Request} request */
function isImmutableContent(url, request) {
    // Authorization is deliberately NOT a gate here: anonymous docker pulls
    // also send Bearer tokens, so gating on it would disable caching for
    // essentially every pull. Digest-addressed URLs are capability URLs - the
    // 64-hex digest identifies immutable content, private manifests included -
    // so the accepted tradeoff (documented in AUDIT.md) is that anyone holding
    // a private digest could read it from this worker's cache.
    return request.method === "GET" && IMMUTABLE_PATH_PATTERN.test(url.pathname);
}

/** @param {Response} hit */
function cachedResponse(hit) {
    const headers = new Headers(hit.headers);
    return new Response(hit.body, { status: hit.status, headers });
}

/** @param {Response} response @param {Headers} headers @param {Request} request @param {any} event */
async function cacheAndStream(response, headers, request, event) {
    const length = Number(response.headers.get("Content-Length"));
    if (!response.body || (Number.isFinite(length) && length > MAX_CACHEABLE_BYTES)) {
        return new Response(response.body, { status: response.status, headers });
    }
    const [clientBody, cacheBody] = response.body.tee();
    const storedHeaders = new Headers(headers);
    if (!Number.isFinite(length) || length <= MAX_BUFFERED_CACHE_BYTES) {
        // Inline await keeps small-manifest writes deterministic in local dev.
        await bufferOrStreamCachePut(cacheBody, storedHeaders, cacheKey(request)).catch((error) =>
            console.error("blob cache put failed:", error),
        );
    } else {
        event.waitUntil(
            bufferOrStreamCachePut(cacheBody, storedHeaders, cacheKey(request)).catch((error) =>
                console.error("blob cache put failed:", error),
            ),
        );
    }
    return new Response(clientBody, { status: response.status, headers });
}

// Bodies up to MAX_BUFFERED_CACHE_BYTES are read fully before the put
// (deterministic cache writes); larger layers stream into the cache while
// they download, bounding worker memory.
/** @param {ReadableStream} cacheBody @param {Headers} storedHeaders @param {Request} key */
function bufferOrStreamCachePut(cacheBody, storedHeaders, key) {
    const length = Number(storedHeaders.get("Content-Length"));
    const buffered =
        !Number.isFinite(length) || length <= MAX_BUFFERED_CACHE_BYTES
            ? new Response(cacheBody)
                  .arrayBuffer()
                  .then((buf) => new Response(buf, { status: 200, headers: storedHeaders }))
            : Promise.resolve(new Response(cacheBody, { status: 200, headers: storedHeaders }));
    return buffered.then((stored) => caches.default.put(key, stored));
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

/** @param {Headers} headers */
function applyCors(headers) {
    Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        headers.set(key, value);
    });
}

function corsPreflight() {
    return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "Access-Control-Max-Age": "86400", "Cache-Control": "no-store" },
    });
}

// Point the auth realm in WWW-Authenticate at the worker host so the Docker
// CLI sends its token requests through the proxy too. Docker Hub realms use
// auth.docker.io / auth.ipv6.docker.com; other registries may have aliases
// (REALM_ALIAS_HOSTS) or host the realm on the registry host itself.
/** @param {Headers} headers @param {string} upstreamHost @param {string} workerOrigin @param {boolean} isDockerHub */
function rewriteAuthRealm(headers, upstreamHost, workerOrigin, isDockerHub) {
    if (!headers.has("WWW-Authenticate")) {
        return;
    }
    const escaped = upstreamHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hosts = [escaped];
    if (isDockerHub) {
        hosts.push("auth\\.docker\\.io", "auth\\.ipv6\\.docker\\.com");
    }
    const aliases = REALM_ALIAS_HOSTS[upstreamHost];
    if (aliases) {
        hosts.push(...aliases);
    }
    const authHeader = headers.get("WWW-Authenticate");
    if (authHeader !== null) {
        headers.set(
            "WWW-Authenticate",
            authHeader.replace(new RegExp(`https://(?:${hosts.join("|")})`, "g"), workerOrigin),
        );
    }
}

/** @param {string} message @param {number} status */
function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS_HEADERS },
    });
}
