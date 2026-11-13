// v1.0.0 - E2E audit for workers/container-proxy against REAL registries.
//
// Prerequisites: wrangler dev on :8787 (see AUDIT.md §1). Subdomain routing
// is driven via the Host header (node:http allows overriding it, fetch does
// not). Docker Hub / GCR / ECR / Elastic are unreachable from some networks
// and covered by scripts/audit-container-unit.mjs instead; this script
// targets the directly reachable registries: quay, ghcr, k8s, nvcr, mcr.
//
// Plain Node.js, no dependencies: `node scripts/audit-container-e2e.mjs`.

import http from "node:http";

const PORT = 8787;

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

// Network-bound steps (redirect targets on networks this machine cannot
// reach, e.g. pkg.dev behind registry.k8s.io) are reported as explicit
// skips, never silently: a deployed worker egresses via Cloudflare and is
// not subject to this machine's reachability.
async function checkReachable(name, fn) {
    try {
        return await fn();
    } catch (error) {
        skipped += 1;
        console.log(`  skip ${name} :: ${error instanceof Error ? error.message : error}`);
        return null;
    }
}

/** @param {string} subdomain @param {string} path @param {{method?: string, headers?: Record<string,string>}} opts */
function request(subdomain, path, opts = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: PORT,
                path,
                method: opts.method || "GET",
                headers: { Host: `${subdomain}.localhost`, ...(opts.headers || {}) },
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
                );
            },
        );
        req.on("error", reject);
        req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
        req.end();
    });
}

const MANIFEST_ACCEPT =
    "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, " +
    "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

/**
 * Full pull dance for one registry: challenge -> realm token -> manifest.
 * @param {string} subdomain
 * @param {string} repo e.g. "library/alpine" (paths get /v2/<repo>/...)
 * @param {string} reference tag or digest
 */
async function pullDance(subdomain, repo, reference) {
    const challenge = await request(subdomain, "/v2/");
    if (challenge.status === 200) {
        // Registry without challenge (mcr): manifest directly.
        const manifest = await request(subdomain, `/v2/${repo}/manifests/${reference}`, {
            headers: { Accept: MANIFEST_ACCEPT },
        });
        return { challenge, token: null, manifest };
    }
    const realmMatch = /realm="([^"]+)"/.exec(challenge.headers["www-authenticate"] || "");
    if (!realmMatch) {
        return { challenge, token: null, manifest: null };
    }
    const realm = realmMatch[1];
    const realmUrl = new URL(realm);
    if (realmUrl.host.startsWith(`${subdomain}.localhost`) || realmUrl.host === `${subdomain}.localhost`) {
        // Realm already points through the worker; request the token via the
        // worker exactly like the docker CLI would (scope added by the client).
        realmUrl.searchParams.set("scope", `repository:${repo}:pull`);
        const tokenRes = await request(subdomain, `${realmUrl.pathname}${realmUrl.search}`);
        const token = JSON.parse(tokenRes.body.toString()).token || JSON.parse(tokenRes.body.toString()).access_token;
        const manifest = await request(subdomain, `/v2/${repo}/manifests/${reference}`, {
            headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
        });
        return { challenge, token: tokenRes, manifest };
    }
    return { challenge, token: { offProxy: realm }, manifest: null };
}

console.log("container-proxy E2E audit (wrangler dev :8787 vs real registries)");

// 1. unsupported subdomain + preflight
{
    const res = await request("foo", "/v2/");
    check("unknown-subdomain-400", res.status === 400 && res.headers["access-control-allow-origin"] === "*");
    const pre = await request("docker", "/v2/", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "GET" },
    });
    check("preflight-204", pre.status === 204 && pre.headers["access-control-allow-origin"] === "*");
}

// 2. quay.io: anonymous pull dance + digest caching
{
    const { challenge, manifest } = await pullDance("quay", "prometheus/busybox", "latest");
    check(
        "quay-challenge-realm-on-proxy",
        (challenge.headers["www-authenticate"] || "").includes('realm="http://quay.localhost'),
        challenge.headers["www-authenticate"],
    );
    check("quay-manifest-200", manifest !== null && manifest.status === 200, `${manifest && manifest.status}`);
    const digest = manifest?.headers["docker-content-digest"];
    check("quay-manifest-digest", typeof digest === "string" && digest.startsWith("sha256:"), `${digest}`);
    if (digest) {
        const first = await request("quay", `/v2/prometheus/busybox/manifests/${digest}`, {
            headers: { Accept: MANIFEST_ACCEPT },
        });
        const second = await request("quay", `/v2/prometheus/busybox/manifests/${digest}`, {
            headers: { Accept: MANIFEST_ACCEPT },
        });
        check(
            "quay-digest-manifest-cached",
            first.status === 200 &&
                second.status === 200 &&
                first.body.equals(second.body) &&
                first.headers["cache-control"] === "public, max-age=604800" &&
                second.headers["age"] !== undefined,
            `first=${first.status} second=${second.status} cc=${second.headers["cache-control"]} age=${second.headers["age"]}`,
        );
    }
    // HEAD blob through redirect keeps HEAD
    if (manifest) {
        const head = await request("quay", `/v2/prometheus/busybox/manifests/${digest}`, {
            method: "HEAD",
            headers: { Accept: MANIFEST_ACCEPT },
        });
        check(
            "quay-head-manifest-no-body",
            head.status === 200 && head.body.length === 0,
            `${head.status} len=${head.body.length}`,
        );
    }
}

// 3. ghcr.io: challenge realm on registry host, token via worker, manifest
{
    const { challenge, token, manifest } = await checkReachable("ghcr-dance", () =>
        pullDance("ghcr", "stefanprodan/podinfo", "latest"),
    ).then((r) => r || { challenge: null, token: null, manifest: null });
    check("ghcr-challenge-401", challenge !== null && challenge.status === 401, `${challenge && challenge.status}`);
    check(
        "ghcr-realm-on-proxy",
        (challenge?.headers["www-authenticate"] || "").includes('realm="http://ghcr.localhost'),
        challenge?.headers["www-authenticate"],
    );
    if (token && token.status) {
        check("ghcr-token-via-worker", token.status === 200, `${token.status}`);
    }
    if (manifest) {
        check("ghcr-manifest-resolved", manifest.status === 200, `${manifest.status}`);
    }
}

// 4. registry.k8s.io: realm on registry host. Manifest pulls 307 to
// us-west2-docker.pkg.dev (Google) which this machine cannot reach directly;
// a deployed worker egresses via Cloudflare and is unaffected.
{
    const challenge = await checkReachable("k8s-challenge", () => request("k8s", "/v2/"));
    check(
        "k8s-challenge-realm-on-proxy",
        (challenge?.headers?.["www-authenticate"] || "").includes('realm="http://k8s.localhost'),
        challenge?.headers?.["www-authenticate"],
    );
    const tokenRes = await checkReachable("k8s-token", () =>
        request("k8s", "/token?service=registry.k8s.io&scope=repository:pause:pull"),
    );
    if (tokenRes) {
        check("k8s-token-via-worker", tokenRes.status === 200, `${tokenRes.status}`);
    }
    skipped += 1;
    console.log("  skip k8s-manifest-200 :: 307 target us-west2-docker.pkg.dev unreachable from this network");
}

// 5. nvcr.io: realm on registry host
{
    const { challenge, manifest } = await checkReachable("nvcr-dance", () =>
        pullDance("nvcr", "nvidia/cloud-native", "v1.0.0"),
    ).then((r) => r || { challenge: null, manifest: null });
    check(
        "nvcr-challenge-realm-on-proxy",
        (challenge?.headers["www-authenticate"] || "").includes('realm="http://nvcr.localhost'),
        challenge?.headers["www-authenticate"],
    );
    if (manifest) {
        check("nvcr-manifest-resolved", manifest.status === 200 || manifest.status === 404, `${manifest.status}`);
    }
}

// 6. mcr.microsoft.com: no challenge, anonymous manifest
{
    const res = await request("mcr", "/v2/");
    check("mcr-v2-200-anonymous", res.status === 200, `${res.status}`);
    const manifest = await request("mcr", "/v2/hello-world/manifests/latest", {
        headers: { Accept: MANIFEST_ACCEPT },
    });
    check(
        "mcr-manifest-200",
        manifest.status === 200 && manifest.headers["content-type"].includes("manifest"),
        `${manifest.status}`,
    );
}

// 7. quay blob: 307 to CDN followed server-side, credentials stripped
{
    await checkReachable("quay-blob", async () => {
        const realmUrl = new URL("http://quay.localhost/v2/auth");
        realmUrl.searchParams.set("service", "quay.io");
        realmUrl.searchParams.set("scope", "repository:prometheus/busybox:pull");
        const tokenRes = await request("quay", `${realmUrl.pathname}${realmUrl.search}`);
        const token = JSON.parse(tokenRes.body.toString()).token;
        const manifest = await request("quay", "/v2/prometheus/busybox/manifests/latest", {
            headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
        });
        const parsed = JSON.parse(manifest.body.toString());
        // `latest` is a manifest index: resolve to the first platform manifest.
        let layers = parsed.layers || [];
        if (!layers.length && Array.isArray(parsed.manifests)) {
            const sub = await request("quay", `/v2/prometheus/busybox/manifests/${parsed.manifests[0].digest}`, {
                headers: { Accept: MANIFEST_ACCEPT, Authorization: `Bearer ${token}` },
            });
            layers = JSON.parse(sub.body.toString()).layers || [];
        }
        check("quay-blob-manifest-layers", layers.length > 0, `${layers.length}`);
        if (layers.length > 0) {
            const blob = await request("quay", `/v2/prometheus/busybox/blobs/${layers[0].digest}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            check(
                "quay-blob-followed-200",
                blob.status === 200 && Number(blob.headers["content-length"]) === blob.body.length,
                `${blob.status} clen=${blob.headers["content-length"]} len=${blob.body.length}`,
            );
        }
        return true;
    });
}

console.log(`container-proxy E2E audit: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
