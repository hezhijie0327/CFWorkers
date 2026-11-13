// v1.0.0 - Deterministic local upstream (:8901) for reverse-proxy audit runs.
//
// Serves every protocol edge the reverse proxy must handle: HTML rewriting
// fixtures, GBK transcoding, gzip/brotli negotiation, redirects (abs+rel,
// 301/302/303/307/308), cookie namespacing, Range/206, ETag/304, SSE, raw
// WebSocket echo, git smart-HTTP via `git http-backend` (clone + push), cache
// hit counters, and an in-page shim assertion page (/shim-test).
//
// Plain Node.js, no dependencies: `node scripts/audit-upstream.mjs`.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

const PORT = 8901;
const ORIGIN = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// GBK encoder built by sampling TextDecoder("gbk") over the two-byte space;
// Node can decode GBK but cannot encode it.
function buildGbkEncoder() {
    const decoder = new TextDecoder("gbk");
    const map = new Map();
    for (let b1 = 0x81; b1 <= 0xfe; b1++) {
        for (let b2 = 0x40; b2 <= 0xfe; b2++) {
            if (b2 === 0x7f) {
                continue;
            }
            const decoded = decoder.decode(Buffer.from([b1, b2]));
            if (decoded.length === 1 && !map.has(decoded)) {
                map.set(decoded, Buffer.from([b1, b2]));
            }
        }
    }
    return (text) =>
        Buffer.concat([...text].flatMap((ch) => (map.has(ch) ? [map.get(ch)] : [...Buffer.from(ch, "utf8")])));
}

const gbk = buildGbkEncoder();
const GBK_SENTINEL = "中文代理转码测试通过";

const INDEX_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>rewrite fixture</title>
  <link rel="preconnect" href="https://fonts.example.com">
  <link rel="dns-prefetch" href="https://static.example.com">
  <link rel="stylesheet" href="/css">
  <style>
    .hero { background: url("/css-target.png") no-repeat; }
    .ext { background: url("${ORIGIN}/css-target.png") no-repeat; }
    @import url("/imported.css");
  </style>
</head>
<body>
  <a href="/echo?link=rel">relative link</a>
  <a href="${ORIGIN}/echo?link=abs">absolute link</a>
  <a href="https://other-site.example/x">external link</a>
  <img src="/bytes" srcset="/bytes 1x, ${ORIGIN}/range 2x">
  <script src="${ORIGIN}/plain"></script>
  <form action="${ORIGIN}/form-target" method="post"><input name="q"></form>
  <div style="background: url('${ORIGIN}/css-target.png')">styled</div>
</body>
</html>`;

const META_REFRESH_HTML = `<!doctype html><html><head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0; url=${ORIGIN}/echo?src=meta-refresh">
</head><body>refreshing</body></html>`;

const WORKER_JS = "self.onmessage = function (e) { postMessage('worker-ok:' + e.data); };";

const SHIM_TEST_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>shim-test</title></head>
<body>
<h1>shim-test</h1>
<ul id="results"></ul>
<iframe name="hidden-frame" style="display:none"></iframe>
<script>
var R = [], W = location.origin, T = location.pathname.slice(1) + location.search;
var abs = "${ORIGIN}";
function render() {
  document.getElementById("results").innerHTML = R.map(function (r) {
    return '<li class="' + (r[1] ? "pass" : "fail") + '">' + r[0] + ": " + (r[1] ? "PASS" : "FAIL " + r[2]) + "</li>";
  }).join("");
  document.title = R.length + " checked, " + R.filter(function (r) { return !r[1]; }).length + " failed";
}
function t(name, ok, info) { R.push([name, !!ok, String(info == null ? "" : info)]); render(); }
function jfetch(u) { return fetch(u).then(function (r) { return r.json(); }); }

// 1. relative fetch resolves against the proxied document URL
jfetch("/echo?src=rel").then(function (j) {
  t("fetch-relative", j.query.src === "rel" && j.url.indexOf("src=rel") >= 0, j.url);
}).catch(function (e) { t("fetch-relative", false, e); });

// 2. absolute fetch goes through the proxy (CORS trio is worker-added)
fetch(abs + "/echo?src=abs").then(function (r) {
  t("fetch-absolute-cors", r.headers.get("access-control-allow-origin") === "*", r.status);
  return r.json();
}).then(function (j) {
  t("fetch-absolute-url", j.url.indexOf(abs + "/echo") === 0 && j.query.src === "abs", j.url);
}).catch(function (e) { t("fetch-absolute-url", false, e); });

// 3. fetch(new Request(absolute)) - Request inputs must be proxified too
fetch(new Request(abs + "/echo?src=request-ctor")).then(function (r) {
  return r.json();
}).then(function (j) {
  t("fetch-request-input", j.query.src === "request-ctor" && j.url.indexOf(abs) === 0, j.url);
}).catch(function (e) { t("fetch-request-input", false, e); });

// 4. XHR with absolute URL
(function () {
  var x = new XMLHttpRequest();
  x.open("GET", abs + "/echo?src=xhr");
  x.onload = function () {
    var j = null;
    try { j = JSON.parse(x.responseText); } catch (e) {}
    t("xhr-absolute", !!j && j.query.src === "xhr" && x.getResponseHeader("access-control-allow-origin") === "*", x.status);
  };
  x.onerror = function () { t("xhr-absolute", false, "network error"); };
  x.send();
})();

// 5. EventSource with absolute URL
(function () {
  try {
    var es = new EventSource(abs + "/sse");
    var done = false;
    es.onmessage = function (ev) {
      if (done) return;
      done = true;
      t("eventsource-absolute", ev.data === "sse-ok", ev.data);
      es.close();
    };
    es.onerror = function () {
      if (!done) { done = true; t("eventsource-absolute", false, "error"); }
    };
  } catch (e) { t("eventsource-absolute", false, e); }
})();

// 6. sendBeacon with absolute URL
(function () {
  try {
    var ok = navigator.sendBeacon(abs + "/beacon", "beacon-payload");
    if (!ok) { t("send-beacon", false, "queued=false"); return; }
    setTimeout(function () {
      jfetch("/beacon/list").then(function (j) {
        t("send-beacon", j.entries.indexOf("beacon-payload") >= 0, JSON.stringify(j.entries));
      }).catch(function (e) { t("send-beacon", false, e); });
    }, 300);
  } catch (e) { t("send-beacon", false, e); }
})();

// 7. Web Worker from absolute URL
(function () {
  try {
    var w = new Worker(abs + "/worker.js");
    w.onmessage = function (ev) { t("worker-absolute", ev.data === "worker-ok:hi", ev.data); w.terminate(); };
    w.onerror = function (e) { t("worker-absolute", false, e.message); };
    w.postMessage("hi");
  } catch (e) { t("worker-absolute", false, e); }
})();

// 8. pushState/replaceState keep navigation inside the proxy URL space
(function () {
  try {
    var orig = "/" + T;
    history.pushState(null, "", "/pushed-state");
    var okPush = location.pathname.slice(-"/pushed-state".length) === "/pushed-state";
    history.replaceState(null, "", orig);
    t("push-state", okPush && location.pathname + location.search === orig, location.pathname + location.search + " vs " + orig);
  } catch (e) { t("push-state", false, e); }
})();

// 9. document.cookie stays namespaced but reads/writes transparently
(function () {
  try {
    document.cookie = "flavor=audit";
    var seen = document.cookie;
    t("cookie-local", seen.indexOf("flavor=audit") >= 0 && seen.indexOf("hidden") < 0, seen);
    jfetch("/cookies/echo").then(function (j) {
      t("cookie-upstream", (j.cookie || "").indexOf("flavor=audit") >= 0, j.cookie);
    }).catch(function (e) { t("cookie-upstream", false, e); });
  } catch (e) { t("cookie-local", false, e); }
})();

// 10. img.src property setter
(function () {
  var img = new Image();
  img.src = abs + "/bytes";
  t("img-src-property", img.src.indexOf(W + "/") === 0, img.src);
})();

// 11. setAttribute srcset with absolute candidates
(function () {
  var img = document.createElement("img");
  img.setAttribute("srcset", abs + "/bytes 1x, " + abs + "/range 2x");
  var v = img.getAttribute("srcset");
  t("srcset-attribute", v.split(",").filter(function (p) { return p.trim().indexOf(W + "/") === 0; }).length === 2, v);
})();

// 12. runtime insertRule url() rewriting
(function () {
  try {
    var s = document.createElement("style");
    document.head.appendChild(s);
    s.sheet.insertRule('.probe { background: url("' + abs + '/bytes"); }', 0);
    t("css-insert-rule", s.sheet.cssRules[0].cssText.indexOf(W + "/") >= 0, s.sheet.cssRules[0].cssText);
  } catch (e) { t("css-insert-rule", false, e); }
})();

// 13. form.submit() direct call (no submit event) retargets action
(function () {
  try {
    var f = document.createElement("form");
    f.action = abs + "/form-target";
    f.method = "POST";
    f.target = "hidden-frame";
    var input = document.createElement("input");
    input.name = "src";
    input.value = "form-submit";
    f.appendChild(input);
    f.style.display = "none";
    document.body.appendChild(f);
    f.submit();
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var body = "";
      try { body = window.frames["hidden-frame"].document.body.textContent; } catch (e) {}
      if (body.indexOf("form-post-ok") >= 0) {
        clearInterval(iv);
        t("form-submit-direct", body.indexOf("src=form-submit") >= 0, body.slice(0, 80));
      } else if (tries > 40) {
        clearInterval(iv);
        t("form-submit-direct", false, body.slice(0, 80));
      }
    }, 100);
  } catch (e) { t("form-submit-direct", false, e); }
})();

// 14. WebSocket with absolute ws:// URL through the relay
(function () {
  try {
    var ws = new WebSocket("ws://127.0.0.1:${PORT}/ws");
    var done = false;
    ws.onopen = function () { ws.send("ping"); };
    ws.onmessage = function (ev) {
      if (done) return;
      done = true;
      t("websocket-relay", ev.data === "pong:ping", ev.data);
      ws.close();
    };
    ws.onerror = function () { if (!done) { done = true; t("websocket-relay", false, "error"); } };
    setTimeout(function () { if (!done) { done = true; t("websocket-relay", false, "timeout"); } }, 5000);
  } catch (e) { t("websocket-relay", false, e); }
})();

// Final: a relative navigation lands inside the proxy URL space via the
// referer fallback (absolute location.href assignments are unforgeable and
// escape the proxy - documented boundary in AUDIT.md).
setTimeout(function () {
  t("done-marker", true);
  render();
  location.href = "/nav-target";
}, 4000);
</script>
</body>
</html>`;

const NAV_TARGET_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>nav-target</title></head>
<body><p id="marker">NAV-TARGET-OK</p><p id="path"></p>
<script>document.getElementById("path").textContent = "PATH:" + location.pathname;</script>
</body></html>`;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const hits = new Map();
const beacons = [];

function recordHit(path) {
    hits.set(path, (hits.get(path) || 0) + 1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function binaryBytes(seed, length) {
    const buf = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
        buf[i] = (i * 7 + seed) % 256;
    }
    return buf;
}

// ---------------------------------------------------------------------------
// Git smart-HTTP via `git http-backend`
// ---------------------------------------------------------------------------

const GIT_ROOT = join(tmpdir(), "cloudflare-workers-audit-git");

function setupGitRepo() {
    // Rebuild from scratch every start: a reused seed dir has nothing to
    // commit and `git commit` would exit non-zero.
    rmSync(GIT_ROOT, { recursive: true, force: true });
    mkdirSync(GIT_ROOT, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main", "--bare", join(GIT_ROOT, "repo.git")]);
    const work = join(GIT_ROOT, "seed");
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["-C", work, "config", "user.email", "audit@example.com"]);
    execFileSync("git", ["-C", work, "config", "user.name", "audit"]);
    writeFileSync(join(work, "README.md"), "# audit repo\nhello through proxy\n");
    execFileSync("git", ["-C", work, "add", "."]);
    execFileSync("git", ["-C", work, "commit", "-qm", "seed commit"]);
    execFileSync("git", ["-C", work, "push", "-q", `file://${join(GIT_ROOT, "repo.git")}`, "main"]);
    // Allow anonymous push through http-backend for the push-path test.
    execFileSync("git", ["-C", join(GIT_ROOT, "repo.git"), "config", "http.receivepack", "true"]);
}

function handleGit(req, res, body) {
    const url = new URL(req.url, ORIGIN);
    const child = spawn("git", ["http-backend"], {
        env: {
            ...process.env,
            GIT_PROJECT_ROOT: GIT_ROOT,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method,
            CONTENT_TYPE: req.headers["content-type"] || "",
            CONTENT_LENGTH: body.length ? String(body.length) : "",
            REMOTE_ADDR: req.socket.remoteAddress || "127.0.0.1",
        },
    });
    let headerBlock = "";
    let headerBytes = Buffer.alloc(0);
    let headersDone = false;
    child.stdout.on("data", (chunk) => {
        if (headersDone) {
            res.write(chunk);
            return;
        }
        headerBytes = Buffer.concat([headerBytes, chunk]);
        const split = headerBytes.indexOf("\r\n\r\n");
        if (split < 0) {
            return;
        }
        headersDone = true;
        headerBlock = headerBytes.subarray(0, split).toString("latin1");
        const statusLine = /Status: (\d+)/.exec(headerBlock);
        const contentType = /Content-Type: (.+)/.exec(headerBlock);
        res.writeHead(statusLine ? Number(statusLine[1]) : 200, {
            "Content-Type": contentType ? contentType[1].trim() : "text/plain",
        });
        const rest = headerBytes.subarray(split + 4);
        if (rest.length) {
            res.write(rest);
        }
    });
    child.stdout.on("end", () => res.end());
    child.on("error", () => {
        if (!res.headersSent) {
            res.writeHead(500);
        }
        res.end("git http-backend failed");
    });
    child.stdin.end(body);
}

// ---------------------------------------------------------------------------
// Minimal WebSocket echo (RFC 6455 handshake + text/ping/close frames)
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function handleWebSocket(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
        socket.destroy();
        return;
    }
    const accept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
            const frame = parseFrame(buf);
            if (!frame) {
                break;
            }
            buf = buf.subarray(frame.length);
            if (frame.opcode === 0x1 || frame.opcode === 0x2) {
                socket.write(encodeFrame(0x1, Buffer.from(`pong:${frame.payload.toString()}`)));
            } else if (frame.opcode === 0x8) {
                socket.write(encodeFrame(0x8, Buffer.alloc(0)));
                socket.end();
            } else if (frame.opcode === 0x9) {
                socket.write(encodeFrame(0xa, frame.payload));
            }
        }
    });
    socket.on("error", () => {});
}

function parseFrame(buf) {
    if (buf.length < 2) {
        return null;
    }
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
        if (buf.length < 4) {
            return null;
        }
        length = buf.readUInt16BE(2);
        offset = 4;
    } else if (length === 127) {
        if (buf.length < 10) {
            return null;
        }
        length = Number(buf.readBigUInt64BE(2));
        offset = 10;
    }
    const maskOffset = offset;
    if (masked) {
        offset += 4;
    }
    if (buf.length < offset + length) {
        return null;
    }
    let payload = buf.subarray(offset, offset + length);
    if (masked) {
        const mask = buf.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i % 4];
        }
    }
    return { opcode, payload, length: offset + length };
}

function encodeFrame(opcode, payload) {
    const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
    header[0] = 0x80 | opcode;
    if (payload.length < 126) {
        header[1] = payload.length;
    } else {
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    }
    return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        const body = Buffer.concat(chunks);
        try {
            route(req, res, body);
        } catch (error) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`harness error: ${error instanceof Error && error.stack ? error.stack : error}`);
        }
    });
});

server.on("upgrade", (req, socket) => {
    recordHit("/ws");
    handleWebSocket(req, socket);
});

function route(req, res, body) {
    const url = new URL(req.url, ORIGIN);
    const path = url.pathname;
    recordHit(path);
    const query = Object.fromEntries(url.searchParams);
    const text = (status, value, headers = {}) => {
        res.writeHead(status, headers);
        res.end(value);
    };

    if (path.startsWith("/repo.git/")) {
        handleGit(req, res, body);
        return;
    }

    switch (path) {
        case "/":
            return text(200, INDEX_HTML, { "Content-Type": "text/html; charset=utf-8" });
        case "/shim-test":
            return text(200, SHIM_TEST_HTML, { "Content-Type": "text/html; charset=utf-8" });
        case "/nav-target":
            return text(200, NAV_TARGET_HTML, { "Content-Type": "text/html; charset=utf-8" });
        case "/meta-refresh":
            return text(200, META_REFRESH_HTML, { "Content-Type": "text/html; charset=utf-8" });
        case "/worker.js":
            return text(200, WORKER_JS, { "Content-Type": "application/javascript" });
        case "/echo": {
            const payload = JSON.stringify(
                {
                    method: req.method,
                    url: ORIGIN + req.url,
                    path,
                    query,
                    headers: req.headers,
                    cookie: req.headers.cookie || null,
                    body: body.length ? body.toString("utf8") : null,
                },
                null,
                2,
            );
            return text(200, payload, { "Content-Type": "application/json; charset=utf-8" });
        }
        case "/css":
            return text(
                200,
                `.relative { background: url("/css-target.png"); }
.absolute { background: url("${ORIGIN}/css-target.png"); }
@import url("${ORIGIN}/imported.css");`,
                { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=120" },
            );
        case "/css-target.png":
        case "/imported.css":
            return text(200, "/* css asset */", { "Content-Type": "text/css", "Cache-Control": "public, max-age=120" });
        case "/gbk.html": {
            const buf = Buffer.concat([
                Buffer.from('<!doctype html><html><head><meta charset="gbk"><title>', "latin1"),
                gbk(GBK_SENTINEL),
                Buffer.from("</title></head><body><p>", "latin1"),
                gbk(GBK_SENTINEL),
                Buffer.from("</p></body></html>", "latin1"),
            ]);
            return text(200, buf, { "Content-Type": "text/html" });
        }
        case "/gzip":
        case "/br": {
            const payload = Buffer.from(`${path}-body-ok`);
            const ae = req.headers["accept-encoding"] || "";
            if (path === "/gzip" && ae.includes("gzip")) {
                return text(200, zlib.gzipSync(payload), { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
            }
            if (path === "/br" && ae.includes("br")) {
                return text(200, zlib.brotliCompressSync(payload), {
                    "Content-Type": "text/plain",
                    "Content-Encoding": "br",
                });
            }
            return text(200, payload, { "Content-Type": "text/plain" });
        }
        case "/redirect": {
            const code = Number(query.code || 301);
            const target = query.mode === "rel" ? "/echo?src=redirect" : `${ORIGIN}/echo?src=redirect`;
            return text(code, null, { Location: target });
        }
        case "/cookies/set":
            res.writeHead(200, [
                ["Content-Type", "text/plain"],
                ["Set-Cookie", "first=one; Domain=example.com; Path=/deprecated"],
                ["Set-Cookie", "second=two; Secure"],
            ]);
            return res.end("cookies set");
        case "/cookies/echo":
            return text(200, JSON.stringify({ cookie: req.headers.cookie || null }), {
                "Content-Type": "application/json",
            });
        case "/range": {
            const data = binaryBytes(3, 8192);
            const range = req.headers.range;
            const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;
            if (m) {
                const start = Number(m[1]);
                const end = m[2] ? Number(m[2]) : data.length - 1;
                return text(206, data.subarray(start, end + 1), {
                    "Content-Type": "application/octet-stream",
                    "Content-Range": `bytes ${start}-${end}/${data.length}`,
                });
            }
            return text(200, data, { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" });
        }
        case "/etag": {
            const etag = '"etag-v1"';
            if (req.headers["if-none-match"] === etag) {
                return text(304, null, { ETag: etag });
            }
            return text(200, "etag-body", { "Content-Type": "text/plain", ETag: etag });
        }
        case "/bytes":
            return text(200, binaryBytes(1, 65536), {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=120",
            });
        case "/big.png":
            return text(200, binaryBytes(9, 2 * 1024 * 1024), {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=60",
            });
        case "/img-nostore.png":
            return text(200, "n", { "Content-Type": "image/png", "Cache-Control": "no-store" });
        case "/img-vary.png":
            return text(200, "v", {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=120",
                Vary: "User-Agent",
            });
        case "/img-setcookie.png":
            res.writeHead(200, [
                ["Content-Type", "image/png"],
                ["Cache-Control", "public, max-age=120"],
                ["Set-Cookie", "leak=attempt; Path=/"],
            ]);
            return res.end("s");
        case "/img-plain.png":
            return text(200, "p", { "Content-Type": "image/png" });
        case "/api.json":
            return text(200, JSON.stringify({ dynamic: Date.now() }), {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=120",
            });
        case "/plain":
            return text(200, "plain-body", { "Content-Type": "text/plain" });
        case "/sse": {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
            res.write("data: sse-ok\n\n");
            res.write("data: sse-done\n\n");
            setTimeout(() => res.end(), 500);
            return undefined;
        }
        case "/beacon":
            beacons.push(body.toString("utf8"));
            return text(204, null);
        case "/beacon/list":
            return text(200, JSON.stringify({ entries: beacons }), { "Content-Type": "application/json" });
        case "/hits":
            return text(200, JSON.stringify(Object.fromEntries(hits), null, 2), { "Content-Type": "application/json" });
        case "/form-target":
            return text(200, `form-post-ok method=${req.method} ${body.toString("utf8")}`, {
                "Content-Type": "text/html; charset=utf-8",
            });
        case "/auth401": {
            if (
                req.headers.authorization === "Bearer audit-secret" ||
                req.headers.authorization === "Basic dXNlcjpwYXNz"
            ) {
                return text(200, "secret-ok", {
                    "Content-Type": "text/plain",
                    "Cache-Control": "public, max-age=120",
                });
            }
            return text(401, "unauthorized", {
                "Content-Type": "text/plain",
                "WWW-Authenticate": 'Bearer realm="audit"',
            });
        }
        default:
            return text(404, `not found: ${path}`, { "Content-Type": "text/plain" });
    }
}

setupGitRepo();
server.listen(PORT, "127.0.0.1", () => {
    console.log(`audit upstream listening on ${ORIGIN} (git root: ${GIT_ROOT})`);
});
