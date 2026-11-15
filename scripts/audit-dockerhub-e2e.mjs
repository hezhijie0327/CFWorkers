// v1.0.0 - Full-chain E2E for workers/container-proxy against REAL Docker Hub,
// through scripts/dev-via-proxy.mjs (workerd ignores proxy env, so the audit
// runner routes outbound fetch() through Node where NODE_USE_ENV_PROXY applies).
//
// Prerequisites:
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://10.192.7.1:7890 \
//     node scripts/dev-via-proxy.mjs workers/container-proxy 8786 &
//   node scripts/audit-dockerhub-e2e.mjs
//
// Optional authenticated section (never commit credentials - pass via env):
//   DOCKER_ID=hezhijie0327 DOCKER_PAT=<token> node scripts/audit-dockerhub-e2e.mjs
//
// Plain Node.js, no dependencies. Exit 1 on failure; auth section is skipped
// (visible) when DOCKER_ID/DOCKER_PAT are unset.

// Host-header routing via node:http (fetch() forbids overriding Host).
import http from "node:http";

const DOCKER_HOST = "docker.localhost";
const MANIFEST_ACCEPT =
    "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, " +
    "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, condition, detail = "") {
    if (condition) {
        passed += 1;
        console.log(`  ok   ${name}`);
    } else {
        failed += 1;
        console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
    }
}

/** @param {string} path @param {{headers?: Record<string,string>, method?: string}} opts */
function request(path, opts = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: 8786,
                path,
                method: opts.method || "GET",
                headers: { Host: DOCKER_HOST, ...(opts.headers || {}) },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const body = Buffer.concat(chunks);
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        // body as text helper
                        async text() {
                            return body.toString("utf8");
                        },
                        async json() {
                            return JSON.parse(body.toString("utf8"));
                        },
                        get body() {
                            return null;
                        },
                        bytes: body.length,
                    });
                });
            },
        );
        req.on("error", reject);
        req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
        req.end();
    });
}

async function reachable() {
    try {
        const res = await fetch("http://127.0.0.1:8786/", { signal: AbortSignal.timeout(3_000) });
        return res.status > 0;
    } catch {
        return false;
    }
}

console.log("container-proxy Docker Hub full-chain E2E (via dev-via-proxy runner)");

if (!(await reachable())) {
    console.log(
        "  skip ALL :: runner not on :8786 - start with NODE_USE_ENV_PROXY=1 HTTPS_PROXY=... node scripts/dev-via-proxy.mjs workers/container-proxy 8786",
    );
    process.exit(1);
}

// 1. routing + preflight
{
    const bad = await request("/", { headers: { Host: "foo.localhost" } });
    check("unknown-subdomain-400", bad.status === 400, `${bad.status}`);
    const pre = await request("/v2/", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } });
    check("preflight-204", pre.status === 204, `${pre.status}`);
}

// 2. anonymous dance: challenge -> token -> tag manifest -> digest -> blob
{
    const challenge = await request("/v2/");
    const realm = challenge.headers["www-authenticate"] || "";
    check("challenge-401", challenge.status === 401, `${challenge.status}`);
    check("realm-rewritten", realm.includes(`realm="http://${DOCKER_HOST}/token"`), realm);

    const tokenRes = await request("/token?service=registry.docker.io&scope=repository:library/alpine:pull");
    const tokenJson = await tokenRes.json();
    const anonJwt = tokenJson.token || tokenJson.access_token;
    check(
        "anon-token-200",
        tokenRes.status === 200 && typeof anonJwt === "string" && anonJwt.length > 100,
        `${tokenRes.status}`,
    );
    check(
        "anon-token-ttl",
        (tokenRes.headers["cache-control"] || "").includes("max-age="),
        tokenRes.headers["cache-control"],
    );

    const tag = await request("/v2/library/alpine/manifests/latest", {
        headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${anonJwt}` },
    });
    const index = await tag.json();
    check("tag-manifest-200", tag.status === 200 && Array.isArray(index.manifests), `${tag.status}`);
    check(
        "tag-manifest-no-store",
        (tag.headers["cache-control"] || "").includes("no-store"),
        tag.headers["cache-control"],
    );
    const amd64 = index.manifests?.find((m) => m.platform?.architecture === "amd64");
    check("index-has-amd64", amd64 !== undefined);

    const digest = amd64?.digest;
    const leaf1 = await request(`/v2/library/alpine/manifests/${digest}`, {
        headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${anonJwt}` },
    });
    const leaf2 = await request(`/v2/library/alpine/manifests/${digest}`, {
        headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${anonJwt}` },
    });
    const leafBody = await leaf1.json();
    check(
        "digest-manifest-200-immutable",
        leaf1.status === 200 && leaf1.headers["cache-control"] === "public, max-age=604800",
        `${leaf1.status} ${leaf1.headers["cache-control"]}`,
    );
    check("digest-manifest-cached", leaf2.status === 200 && (await leaf2.text()) === (await leaf1.text()));
    const blobDigest = leafBody.config?.digest;

    if (blobDigest) {
        const blob1 = await request(`/v2/library/alpine/blobs/${blobDigest}`, {
            headers: { Authorization: `Bearer ${anonJwt}` },
        });
        const blob2 = await request(`/v2/library/alpine/blobs/${blobDigest}`, {
            headers: { Authorization: `Bearer ${anonJwt}` },
        });
        check("blob-followed-200", blob1.status === 200 && blob1.bytes > 100, `${blob1.status} len=${blob1.bytes}`);
        check("blob-cached-identical", blob2.status === 200 && blob2.bytes === blob1.bytes);
        const head = await request(`/v2/library/alpine/blobs/${blobDigest}`, {
            method: "HEAD",
            headers: { Authorization: `Bearer ${anonJwt}` },
        });
        check("head-blob-no-body", head.status === 200 && head.bytes === 0, `${head.status}`);
    } else {
        skipped += 1;
        console.log("  skip blob-dance :: no config digest in leaf manifest");
    }
}

// 3. authenticated section (credentials via env only)
if (process.env.DOCKER_ID && process.env.DOCKER_PAT) {
    const basic = Buffer.from(`${process.env.DOCKER_ID}:${process.env.DOCKER_PAT}`).toString("base64");
    const tokenRes = await request("/token?service=registry.docker.io&scope=repository:library/alpine:pull,push", {
        headers: { Authorization: `Basic ${basic}` },
    });
    const tokenJson = await tokenRes.json();
    const jwt = tokenJson.token || tokenJson.access_token;
    check(
        "auth-token-200",
        tokenRes.status === 200 && typeof jwt === "string" && jwt.length > 100,
        `${tokenRes.status}`,
    );
    check(
        "auth-token-no-store",
        (tokenRes.headers["cache-control"] || "").includes("no-store"),
        tokenRes.headers["cache-control"],
    );

    const tag = await request("/v2/library/alpine/manifests/latest", {
        headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${jwt}` },
    });
    check(
        "auth-pull-attributed-to-account",
        tag.status === 200 && (tag.headers["docker-ratelimit-source"] || "") === process.env.DOCKER_ID,
        `${tag.status} source=${tag.headers["docker-ratelimit-source"]}`,
    );
} else {
    skipped += 1;
    console.log("  skip authenticated section :: set DOCKER_ID + DOCKER_PAT to run");
}

console.log(`container-proxy Docker Hub E2E: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
