// v1.0.0 - Unit-level audit for workers/container-proxy/worker.js.
//
// Docker Hub and docker.elastic.co are unreachable from some networks (the
// very reason the worker exists), so their full protocol paths are exercised
// here with a mocked fetch implementing the verified upstream shapes (probed
// live 2026-11): 401 challenge + realm, token endpoint, 307 blob redirect to
// a signed CDN, 202 upload-session Location, off-host elastic auth.
// Everything else (mcr/quay/ghcr/k8s/nvcr) is smoke-tested against the real
// registries through `wrangler dev` - see AUDIT.md §4.
//
// Plain Node.js, no dependencies: `node scripts/audit-container-unit.mjs`.

import { pathToFileURL } from "node:url";

const WORKER = new URL("../workers/container-proxy/worker.js", import.meta.url).pathname;
const WORKER_ORIGIN = "https://docker.a.test";

// ---------------------------------------------------------------------------
// Test doubles: addEventListener capture, memory Cache API, mocked fetch
// ---------------------------------------------------------------------------

const handlers = {};
globalThis.addEventListener = (type, handler) => {
    handlers[type] = handler;
};

const cacheStore = new Map();
globalThis.caches = {
    default: {
        async match(key) {
            return cacheStore.get(key.url);
        },
        async put(key, response) {
            cacheStore.set(key.url, response);
        },
    },
};

const upstreamCalls = [];
const upstreamCounts = {};

function record(call) {
    upstreamCalls.push(call);
    const name = `${call.method} ${call.host}${call.path}`;
    upstreamCounts[name] = (upstreamCounts[name] || 0) + 1;
}

const DIGEST = `sha256:${"a1".repeat(32)}`;
const BLOB_DIGEST = `sha256:${"b2".repeat(32)}`;
const CDN_BODY = "BLOB-BYTES-v1";

globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const call = {
        host: url.host,
        path: url.pathname + url.search,
        method: request.method,
        headers: Object.fromEntries(request.headers),
    };
    record(call);
    const json = (body, init2) => new Response(JSON.stringify(body), init2);

    if (call.host === "auth.docker.io") {
        return json(
            { token: call.headers.authorization ? "tok-auth" : "tok-anon", expires_in: 300 },
            { status: 200, headers: { "Content-Type": "application/json" } },
        );
    }
    if (call.host === "docker-auth.elastic.co") {
        return json({ token: "elastic-tok", expires_in: 300 }, { status: 200 });
    }
    if (call.host === "production.cloudfront.docker.com") {
        if (call.method === "HEAD") {
            return new Response(null, { status: 200, headers: { "Content-Length": String(CDN_BODY.length) } });
        }
        return new Response(CDN_BODY, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    if (call.host === "registry-1.docker.io") {
        if (call.path === "/v2/") {
            return new Response(null, {
                status: 401,
                headers: {
                    "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
                },
            });
        }
        if (call.path.startsWith(`/v2/library/alpine/blobs/${BLOB_DIGEST}`)) {
            return new Response(null, {
                status: 307,
                headers: { Location: "https://production.cloudfront.docker.com/registry-v2/blob?sig=1" },
            });
        }
        if (call.path.startsWith("/v2/library/alpine/manifests/")) {
            const headers = { "Content-Type": "application/vnd.docker.distribution.manifest.v2+json" };
            if (call.path.includes("/latest")) {
                return json({ schemaVersion: 2, tag: "latest" }, { status: 200, headers });
            }
            headers["Docker-Content-Digest"] = DIGEST;
            return json({ schemaVersion: 2 }, { status: 200, headers });
        }
        if (call.path.startsWith("/v2/library/push-demo/blobs/uploads/") && call.method === "POST") {
            return new Response(null, {
                status: 202,
                headers: {
                    Location: "https://registry-1.docker.io/v2/library/push-demo/blobs/uploads/uuid-1?state=abc",
                },
            });
        }
        if (call.path.startsWith("/v2/library/push-demo/blobs/uploads/") && call.method === "PATCH") {
            return new Response(null, {
                status: 204,
                headers: {
                    Location: "https://registry-1.docker.io/v2/library/push-demo/blobs/uploads/uuid-1?state=next",
                    Range: "0-3",
                },
            });
        }
    }
    if (call.host === "docker.elastic.co" && call.path === "/v2/") {
        return new Response(null, {
            status: 401,
            headers: {
                "WWW-Authenticate": 'Bearer realm="https://docker-auth.elastic.co/auth",service="token-service"',
            },
        });
    }
    return new Response("mock 404", { status: 404 });
};

await import(pathToFileURL(WORKER).href);

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function run(request) {
    let resolveResponse;
    const responded = new Promise((resolve) => {
        resolveResponse = resolve;
    });
    const pending = [];
    handlers.fetch({
        request,
        respondWith: (promise) => resolveResponse(Promise.resolve(promise)),
        waitUntil: (promise) => pending.push(Promise.resolve(promise).catch(() => {})),
    });
    const response = await responded;
    await Promise.all(pending);
    return response;
}

const get = (path, headers = {}) => new Request(`${WORKER_ORIGIN}${path}`, { method: "GET", headers });

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

const count = (name) => upstreamCounts[name] || 0;

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

console.log("container-proxy unit audit");

// 1. unsupported subdomain -> 400 JSON with CORS
{
    const res = await run(new Request("https://foo.a.test/v2/"));
    const body = await res.json();
    check("unknown-subdomain-400", res.status === 400 && body.error === "Unsupported domain");
    check("error-cors", res.headers.get("access-control-allow-origin") === "*");
}

// 2. CORS preflight answered locally
{
    const res = await run(
        new Request(`${WORKER_ORIGIN}/v2/`, {
            method: "OPTIONS",
            headers: { "Access-Control-Request-Method": "GET" },
        }),
    );
    check("preflight-204", res.status === 204 && res.headers.get("access-control-allow-origin") === "*");
}

// 3. /v2/ challenge: realm rewritten into the worker origin
{
    const res = await run(get("/v2/", { "User-Agent": "docker/27.0 unit" }));
    const realm = res.headers.get("www-authenticate") || "";
    check("challenge-401", res.status === 401);
    check("realm-rewritten", realm.includes(`realm="${WORKER_ORIGIN}/token"`), realm);
}

// 4. anonymous token: cached at the edge, upstream hit once
{
    const first = await run(get("/token?service=registry.docker.io&scope=repository:library/alpine:pull"));
    const firstBody = await first.json();
    const second = await run(get("/token?service=registry.docker.io&scope=repository:library/alpine:pull"));
    check("token-200", first.status === 200 && firstBody.token === "tok-anon");
    check(
        "token-ttl",
        (first.headers.get("cache-control") || "").includes("max-age=240"),
        first.headers.get("cache-control"),
    );
    check("token-served-from-cache", (await second.json()).token === "tok-anon");
    check(
        "token-upstream-once",
        count(`GET auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull`) === 1,
    );
}

// 5. authenticated token requests are never cached
{
    await run(
        get("/token?service=registry.docker.io&scope=repository:library/x:pull,push", { Authorization: "Basic dTpw" }),
    );
    await run(
        get("/token?service=registry.docker.io&scope=repository:library/x:pull,push", { Authorization: "Basic dTpw" }),
    );
    check(
        "auth-token-not-cached",
        count(`GET auth.docker.io/token?service=registry.docker.io&scope=repository:library/x:pull,push`) === 2,
    );
}

// 6. digest manifest: edge-cached, immutable Cache-Control, no auth upstream
{
    const first = await run(
        get(`/v2/library/alpine/manifests/${DIGEST}`, {
            Accept: "application/vnd.docker.distribution.manifest.v2+json",
            Authorization: "Bearer tok-anon",
        }),
    );
    const second = await run(
        get(`/v2/library/alpine/manifests/${DIGEST}`, {
            Accept: "application/vnd.docker.distribution.manifest.v2+json",
            Authorization: "Bearer tok-anon",
        }),
    );
    check("digest-manifest-200", first.status === 200);
    check(
        "digest-manifest-immutable-cc",
        first.headers.get("cache-control") === "public, max-age=604800",
        first.headers.get("cache-control"),
    );
    check("digest-manifest-served-from-cache", (await second.json()).schemaVersion === 2);
    check(
        "digest-manifest-upstream-once",
        count(`GET registry-1.docker.io/v2/library/alpine/manifests/${DIGEST}`) === 1,
    );
    const upstream = upstreamCalls.find((c) => c.path.startsWith("/v2/library/alpine/manifests/"));
    check(
        "upstream-no-cf-headers",
        !Object.keys(upstream.headers).some((k) => k.startsWith("cf-") || k === "host" || k === "accept-encoding"),
    );
    check(
        "upstream-keeps-auth-accept",
        upstream.headers.authorization === "Bearer tok-anon" && upstream.headers.accept !== undefined,
    );
}

// 7. tag manifest: never cached (tags are mutable)
{
    await run(get("/v2/library/alpine/manifests/latest"));
    await run(get("/v2/library/alpine/manifests/latest"));
    check(
        "tag-manifest-no-store",
        (await run(get("/v2/library/alpine/manifests/latest"))).headers.get("cache-control") === "no-store",
    );
    check("tag-manifest-not-cached", count("GET registry-1.docker.io/v2/library/alpine/manifests/latest") === 3);
}

// 8. blob: 307 followed server-side, CDN gets no credentials, edge-cached
{
    const blobHeaders = { Authorization: "Bearer tok-anon", "User-Agent": "docker/27.0 unit" };
    const first = await run(get(`/v2/library/alpine/blobs/${BLOB_DIGEST}`, blobHeaders));
    const body = await first.text();
    const second = await run(get(`/v2/library/alpine/blobs/${BLOB_DIGEST}`, blobHeaders));
    check("blob-followed-200", first.status === 200 && body === CDN_BODY, `${first.status} ${body}`);
    check("blob-served-from-cache", (await second.text()) === CDN_BODY);
    check("blob-registry-once", count(`GET registry-1.docker.io/v2/library/alpine/blobs/${BLOB_DIGEST}`) === 1);
    check("blob-cdn-once", count("GET production.cloudfront.docker.com/registry-v2/blob?sig=1") === 1);
    const cdn = upstreamCalls.find((c) => c.host === "production.cloudfront.docker.com");
    check("cdn-no-authorization", cdn.headers.authorization === undefined);
    check("cdn-keeps-user-agent", cdn.headers["user-agent"] === "docker/27.0 unit");
}

// 9. HEAD blob: 307 replayed as HEAD, response has no body
{
    const res = await run(
        new Request(`${WORKER_ORIGIN}/v2/library/alpine/blobs/${BLOB_DIGEST}`, {
            method: "HEAD",
            headers: { "User-Agent": "docker/27.0 unit" },
        }),
    );
    check("head-blob-no-body", res.status === 200 && res.body === null);
    check("head-replayed-as-head", count("HEAD production.cloudfront.docker.com/registry-v2/blob?sig=1") >= 1);
}

// 10. upload session: 202 Location rewritten back to the worker, not followed
{
    const res = await run(
        new Request(`${WORKER_ORIGIN}/v2/library/push-demo/blobs/uploads/`, {
            method: "POST",
            headers: { Authorization: "Bearer tok-auth" },
        }),
    );
    const location = res.headers.get("location");
    check("upload-202", res.status === 202);
    check(
        "upload-location-rewritten",
        location === `${WORKER_ORIGIN}/v2/library/push-demo/blobs/uploads/uuid-1?state=abc`,
        location,
    );
    check(
        "upload-not-followed",
        count("GET registry-1.docker.io/v2/library/push-demo/blobs/uploads/uuid-1?state=abc") === 0,
    );
    // Client continues through the proxy: PATCH the rewritten URL.
    const patch = await run(new Request(location, { method: "PATCH", body: "data" }));
    check(
        "upload-patch-location",
        patch.headers.get("location") === `${WORKER_ORIGIN}/v2/library/push-demo/blobs/uploads/uuid-1?state=next`,
        patch.headers.get("location"),
    );
}

// 11. elastic: off-host realm routes to docker-auth.elastic.co/auth
{
    const challenge = await run(new Request("https://elastic.a.test/v2/"));
    const realm = challenge.headers.get("www-authenticate") || "";
    check("elastic-realm-rewritten", realm.includes('realm="https://elastic.a.test/auth"'), realm);
    const token = await run(
        new Request(
            "https://elastic.a.test/auth?service=token-service&scope=repository:elasticsearch/elasticsearch:pull",
        ),
    );
    const body = await token.json();
    check(
        "elastic-auth-routed",
        count(
            "GET docker-auth.elastic.co/auth?service=token-service&scope=repository:elasticsearch/elasticsearch:pull",
        ) === 1,
    );
    check("elastic-token-200", token.status === 200 && body.token === "elastic-tok");
}

console.log(`container-proxy unit audit: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
