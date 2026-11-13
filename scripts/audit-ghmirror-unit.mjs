// v1.0.0 - Unit audit for the gh-mirror worker.
//
// The worker's source of truth lives in the blog repo
// (../blog/workers/gh-mirror/worker.js); this repo owns the audit tooling, so
// the suite imports the worker from there (override via argv[2]) and drives
// its default.fetch() against a mocked upstream implementing GitHub's raw /
// git smart-HTTP shapes (verified live 2026-11). The full-chain E2E runs the
// worker under scripts/dev-via-proxy.mjs instead - see AUDIT.md.
//
// Plain Node.js, no dependencies: `node scripts/audit-ghmirror-unit.mjs`.

import { pathToFileURL } from "node:url";

const DEFAULT_WORKER = new URL("../../blog/workers/gh-mirror/worker.js", import.meta.url).pathname;
const WORKER_PATH = process.argv[2] || DEFAULT_WORKER;

// ---------------------------------------------------------------------------
// Upstream mock
// ---------------------------------------------------------------------------

const upstreamCalls = [];
const RAW_SENTINEL = "raw-file-body";
const upstream = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method || "GET";
    const headers = Object.fromEntries(new Headers(init?.headers || {}));
    const body = init?.body ? await new Response(init.body).text() : null;
    const call = { origin: url.origin, path: url.pathname + url.search, method, headers, body };
    upstreamCalls.push(call);

    if (url.origin === "https://raw.githubusercontent.com") {
        if (url.pathname.endsWith("missing.txt")) {
            return new Response("404: Not Found", { status: 404 });
        }
        if (url.pathname.endsWith("ratelimited.txt")) {
            return new Response("slow down", { status: 429 });
        }
        if (url.pathname.endsWith("ranged.txt")) {
            return new Response("RANGE-SLICE", {
                status: 206,
                headers: { "Content-Range": "bytes 0-9/100", "Cache-Control": "max-age=300" },
            });
        }
        const headers = { "Cache-Control": "max-age=300", ETag: '"abc123"' };
        if (method === "HEAD") {
            return new Response(null, { status: 200, headers });
        }
        const body = url.pathname.endsWith(".txt") ? RAW_SENTINEL : `body-for:${url.pathname}`;
        return new Response(body, { status: 200, headers });
    }
    if (url.origin === "https://github.com") {
        if (url.pathname.endsWith("/git-receive-pack")) {
            return new Response("no", { status: 403 });
        }
        return new Response("git-advertisement", {
            status: 200,
            headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
        });
    }
    return new Response("mock 404", { status: 404 });
};
globalThis.fetch = upstream;

const { default: worker } = await import(pathToFileURL(WORKER_PATH).href);

const call = (pattern) => upstreamCalls.findLast((c) => c.path.includes(pattern));

async function run(path, { headers, method, body } = {}) {
    return worker.fetch(new Request(`https://mirror.test${path}`, { method: method || "GET", headers, body }), {});
}

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

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

console.log("gh-mirror unit audit");

// 1. path resolution: owner optional, view segment dropped, hotlink marker removed
{
    upstreamCalls.length = 0;
    await run("/Trackerslist/main/file.txt");
    await run("/hezhijie0327/Trackerslist/main/file.txt");
    await run("/hezhijie0327/blob/Trackerslist/main/file.txt");
    await run("/Trackerslist/main/hotlink-ok/file.txt");
    check("owner-optional", call("main/file.txt") !== undefined);
    const paths = upstreamCalls.filter((c) => c.origin.includes("raw")).map((c) => c.path);
    check(
        "path-resolution-matrix",
        paths.filter((p) => p === "/hezhijie0327/Trackerslist/main/file.txt").length === 4 &&
            paths.every((p) => p.startsWith("/hezhijie0327/")),
        JSON.stringify(paths),
    );
}

// 2. known extension: content-type from the table, upstream cache headers kept
{
    const res = await run("/Trackerslist/main/file.txt");
    check("known-ext-200", res.status === 200 && (await res.text()) === RAW_SENTINEL);
    check(
        "known-ext-content-type",
        res.headers.get("content-type") === "text/plain;charset=UTF-8",
        res.headers.get("content-type"),
    );
    check(
        "known-ext-cache-control-preserved",
        res.headers.get("cache-control") === "max-age=300",
        res.headers.get("cache-control"),
    );
    check("known-ext-etag-preserved", res.headers.get("etag") === '"abc123"');
    check("acao-wildcard", res.headers.get("access-control-allow-origin") === "*");
}

// 3. unknown extension: upstream headers pass through verbatim
{
    const res = await run("/Trackerslist/main/README.md");
    check("unknown-ext-200", res.status === 200);
    check(
        "unknown-ext-upstream-ct",
        (res.headers.get("content-type") || "").includes("plain"),
        res.headers.get("content-type"),
    );
}

// 4. upstream error statuses pass through (only plain 404 is masked)
{
    const missing = await run("/Trackerslist/main/missing.txt");
    check("upstream-404-masked", missing.status === 404 && (await missing.text()) === "404 Not Found");
    const limited = await run("/Trackerslist/main/ratelimited.txt");
    check(
        "upstream-429-passthrough",
        limited.status === 429 && (await limited.text()) === "slow down",
        `${limited.status}`,
    );
}

// 5. auth header: injected only when the binding exists
{
    upstreamCalls.length = 0;
    await worker.fetch(new Request("https://mirror.test/Trackerslist/main/file.txt"), { GITHUB_TOKEN: "ghs_test" });
    await worker.fetch(new Request("https://mirror.test/Trackerslist/main/file.txt"), {});
    const authed = upstreamCalls[0];
    const anon = upstreamCalls[1];
    check("token-injected", authed.headers.authorization === "token ghs_test", authed.headers.authorization);
    check("anonymous-omits-authorization", anon.headers.authorization === undefined);
}

// 6. Range forwarded; 206 passthrough with Content-Range
{
    const res = await run("/Trackerslist/main/ranged.txt", { headers: { Range: "bytes=0-9" } });
    check("range-forwarded", call("ranged.txt").headers.range === "bytes=0-9");
    check(
        "range-206-passthrough",
        res.status === 206 && res.headers.get("content-range") === "bytes 0-9/100",
        `${res.status}`,
    );
}

// 7. HEAD stays HEAD and returns no body
{
    const res = await run("/Trackerslist/main/file.txt", { method: "HEAD" });
    check("head-replayed", call("file.txt").method === "HEAD");
    check("head-no-body", res.status === 200 && res.body === null);
}

// 8. git: owner restored for github.com (both URL forms), read-only
{
    await run("/Trackerslist.git/info/refs?service=git-upload-pack", { headers: { "User-Agent": "git/2.50 unit" } });
    await run("/hezhijie0327/Trackerslist.git/info/refs?service=git-upload-pack");
    const gitCalls = upstreamCalls.filter((c) => c.origin === "https://github.com");
    check(
        "git-owner-restored",
        gitCalls.length === 2 &&
            gitCalls.every((c) => c.path === "/hezhijie0327/Trackerslist.git/info/refs?service=git-upload-pack"),
        JSON.stringify(gitCalls.map((c) => c.path)),
    );
    check("git-ua-forwarded", gitCalls[0].headers["user-agent"] === "git/2.50 unit");

    const push = await run("/Trackerslist.git/git-receive-pack", {
        method: "POST",
        body: "packdata",
        headers: { "Content-Type": "application/x-git-receive-pack-request" },
    });
    check("push-rejected-403", push.status === 403, `${push.status}`);

    const upload = await run("/Trackerslist.git/git-upload-pack", {
        method: "POST",
        body: "want-lines",
        headers: { Authorization: "Basic dTpw", "Content-Type": "application/x-git-upload-pack-request" },
    });
    const uploadCall = upstreamCalls.filter((c) => c.origin === "https://github.com").at(-1);
    check(
        "upload-pack-relayed",
        upload.status === 200 && uploadCall.method === "POST" && uploadCall.body === "want-lines",
        `${upload.status}`,
    );
    check("git-auth-forwarded", uploadCall.headers.authorization === "Basic dTpw");
    check("git-ct-forwarded", uploadCall.headers["content-type"] === "application/x-git-upload-pack-request");
}

// 9. CORS preflight answered locally (no upstream hit)
{
    const before = upstreamCalls.length;
    const res = await run("/Trackerslist/main/file.txt", {
        method: "OPTIONS",
        headers: { "Access-Control-Request-Method": "GET" },
    });
    check(
        "preflight-204",
        res.status === 204 && res.headers.get("access-control-allow-origin") === "*",
        `${res.status}`,
    );
    check("preflight-no-upstream", upstreamCalls.length === before, `${before} -> ${upstreamCalls.length}`);
}

console.log(`gh-mirror unit audit: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
