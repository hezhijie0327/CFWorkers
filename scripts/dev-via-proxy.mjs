// v1.0.0 - Boot a worker under miniflare with every outbound fetch() routed
// through this Node process, so HTTPS_PROXY/NODE_USE_ENV_PROXY applies.
//
// Why: workerd ignores proxy environment entirely (no proxy flags in the
// binary, HTTPS_PROXY/ALL_PROXY env ignored - verified 2026-11 against
// wrangler 4.162 / workerd 1.20261110), which blocked full-chain local audits
// of the Docker Hub and github.com paths that are unreachable from CN
// networks. miniflare's outboundService hook runs in Node, where native fetch
// honors proxy env under NODE_USE_ENV_PROXY=1 (Node >= 24).
//
// Usage:
//   NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://10.192.7.1:7890 \
//     node scripts/dev-via-proxy.mjs workers/container-proxy 8786
//   (without proxy env the same runner egresses directly)
//
// Harness-only downgrade: miniflare 4's bundled workerd supports compat dates
// up to 2026-08-06; the audited workers use only long-stable APIs (Cache API,
// HTMLRewriter, WebSocketPair), so running under the harness cap is safe here.
// WebSocket relays are still audited under `wrangler dev` (node:http has no
// Upgrade passthrough here).
//
// Secrets: bindings come from the worker's wrangler.jsonc vars plus
// GITHUB_TOKEN from the environment when set (gh-mirror authenticated tests).

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Miniflare } from "miniflare";

const [dir, portArg] = process.argv.slice(2);
if (!dir) {
    console.error("usage: node scripts/dev-via-proxy.mjs <worker-dir> [port]");
    process.exit(2);
}
const port = Number(portArg || 8786);

// Minimal JSONC parse for wrangler configs (line/block comments only).
const config = JSON.parse(
    readFileSync(join(dir, "wrangler.jsonc"), "utf8")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, ""),
);

const bindings = { ...(config.vars || {}) };
if (process.env.GITHUB_TOKEN) {
    bindings.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
}

const scriptPath = join(dir, "worker.js");
const script = readFileSync(scriptPath, "utf8");

const mf = new Miniflare({
    // Pass the source rather than scriptPath: workerd's sandbox refuses paths
    // that leave the starting directory (auditing workers from other repos).
    script,
    // ES-module workers (export default) vs the deprecated service-worker
    // format - workerd rejects `export` when booted as a classic script.
    modules: /export\s+default/.test(script),
    compatibilityDate: "2026-08-06",
    cache: true,
    ...(Object.keys(bindings).length ? { bindings } : {}),
    outboundService(request) {
        // Node-context fetch: honors NODE_USE_ENV_PROXY + HTTPS_PROXY.
        return globalThis.fetch(request.url, request);
    },
});

const server = createServer(async (req, res) => {
    // Preserve the caller's Host header in the URL so Host-based subdomain
    // routing (container-proxy) resolves exactly like under `wrangler dev`.
    const url = `http://${req.headers.host}${req.url}`;
    const headers = [];
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) {
            continue;
        }
        headers.push([key, Array.isArray(value) ? value.join("; ") : value]);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
        const upstream = await mf.dispatchFetch(url, {
            method: req.method,
            headers,
            body: hasBody ? Readable.toWeb(req) : undefined,
            // redirect: workers handle Location themselves; never auto-follow.
            redirect: "manual",
            ...(hasBody ? { duplex: "half" } : {}),
        });
        const responseHeaders = {};
        for (const [key, value] of upstream.headers) {
            if (key.toLowerCase() !== "set-cookie") {
                responseHeaders[key] = value;
            }
        }
        // appendHeader must run before writeHead (Node semantics).
        const setCookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
        for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
        }
        res.writeHead(upstream.status, responseHeaders);
        if (upstream.body) {
            for await (const chunk of upstream.body) {
                res.write(chunk);
            }
        }
        res.end();
    } catch (error) {
        if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
});

server.on("clientError", (_err, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

await mf.ready;
server.on("error", (error) => {
    console.error(`runner failed to listen on :${port} - ${error.message}`);
    process.exit(2);
});

server.listen(port, "127.0.0.1", () => {
    const egress = process.env.NODE_USE_ENV_PROXY
        ? `proxied via ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY}`
        : "direct (set NODE_USE_ENV_PROXY=1 + HTTPS_PROXY to egress via proxy)";
    console.log(`${config.name} ready on http://127.0.0.1:${port} - outbound ${egress}`);
});

const shutdown = async () => {
    server.close();
    await mf.dispose();
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
