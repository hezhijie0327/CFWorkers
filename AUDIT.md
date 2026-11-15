# AUDIT.md — Cloudflare Workers audit playbook

Audit playbook for this repository (two workers: container-proxy + reverse-proxy), structure referencing ZJBlog AUDIT.md: **audit round by round until a round produces no new findings**. Per-round flow:
environment prep → gates → local-deploy empirical matrix (unit / E2E / browser / git / real sites) → performance/proxy-capability/security dimension scans → fixes → regression → doc sync. New lessons are appended to the corresponding sections of this file and AGENTS.md; never audit the same mistake twice.

Key differences from ZJBlog: this project has no build, no unit-test framework, no browser-side product code — **all correctness verification relies on local deployment (wrangler dev) + protocol-level empirical matrices**; the two workers are network proxies, so the audit core is "protocol correctness + proxy capability + performance (caching/streaming) + security (credential/header leakage)".

## 1. Environment preparation

```sh
pnpm install                    # single lockfile (pnpm); wrangler also in devDependencies
pnpm run ci                     # biome check + tsc --noEmit (run to green at the start of every round)
node scripts/audit-upstream.mjs # local test upstream :8901 (deterministic target for the protocol matrix)
pnpm wrangler dev --config workers/reverse-proxy/wrangler.jsonc   --port 8788  # generic reverse proxy
pnpm wrangler dev --config workers/container-proxy/wrangler.jsonc --port 8787  # container proxy
# Full-chain verification of blocked upstreams (Docker Hub, github.com) goes through the proxy runner (see the §10 runner entry):
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://10.192.7.1:7890 \
  node scripts/dev-via-proxy.mjs workers/container-proxy 8786
```

Audit scripts (`node scripts/audit-*.mjs`, all zero-dependency, exit 1 = failures present):

| Script | Prerequisites | Coverage |
| ------ | ------------- | -------- |
| `audit-container-unit.mjs` | none (mock fetch + in-memory cache) | Docker Hub / elastic full-protocol paths (fallback for blocked networks): 202 Location, realm routing, token/manifest/blob caching, HEAD replay, cf-\*/AE header filtering |
| `audit-container-e2e.mjs` | container wrangler dev :8787 | Real quay/ghcr/k8s/nvcr/mcr: challenge→token→manifest→blob full dance + digest caching |
| `audit-dockerhub-e2e.mjs` | dev-via-proxy runner :8786 (proxy egress) | **Real Docker Hub full chain**: realm rewrite→anonymous token→tag/digest manifest→blob 307 follow→HEAD; auth segment (`DOCKER_ID`/`DOCKER_PAT` env, never written to disk) verifies Basic→JWT exchange + account rate-limit attribution |
| `audit-reverse-e2e.mjs` | reverse wrangler dev :8788 + harness | §5 full matrix (header filtering/rewriting/GBK/compression/redirects/cookies/Range/304/cache gating/preflight/userinfo/referer fallback/SSE) |

- International network (GitHub, overseas registries, wrangler downloads): `HTTP_PROXY=http://10.192.7.1:7890 HTTPS_PROXY=http://10.192.7.1:7890 NO_PROXY=localhost,127.0.0.1`.
- Local workerd routes subdomains by **Host header**: `curl -H "Host: quay.localhost" http://127.0.0.1:8787/v2/`. Node's fetch doesn't allow changing the Host header; Host routing uses `node:http` (audit-container-e2e does exactly this).
- Local Cache API / CDN-layer cache persists with `.wrangler/` state: **before asserting cache behavior, clear `workers/*/.wrangler` and restart dev fresh** (see §10 hot-reload traps).

## 2. Quality gates (every round)

```sh
pnpm run lint        # biome check zero errors (same as CI; biome must exclude **/.wrangler)
pnpm run typecheck   # tsc strict + checkJs zero errors
```

- After modifying either worker: gates green → re-run that worker's impact-surface matrix (§4/§5).
- `wrangler dev` hot reload takes effect immediately, but **hot reload poisons local cache behavior** (§10) — cache assertions always run on freshly restarted instances.

## 3. Dependency updates (every round)

```sh
pnpm outdated; pnpm update   # devDependencies: biome / typescript / workers-types / wrangler
pnpm run bump-compat         # align compatibility_date with the latest wrangler release date, review git diff
```

- After a wrangler upgrade, smoke-start both devs locally; **validate wrangler.jsonc field names against `node_modules/wrangler/config-schema.json`** — `observability.issue_detection` was once an invalid field (the current schema is `observability.issues.enabled`).
- When `@cloudflare/workers-types` skips versions, watch for field gaps like RequestInit.duplex (container-proxy works around it with `@type {any}`, registered in a comment).

## 4. container-proxy empirical matrix

Unit level (`audit-container-unit.mjs`, mock upstream covers the blocked Docker Hub/elastic full protocol) + real registries (`audit-container-e2e.mjs`, quay/ghcr/k8s/nvcr/mcr; explicit skip when k8s's 307 target is unreachable).

| Face | Operation | Expected |
| ---- | --------- | -------- |
| Subdomain routing | `curl -H "Host: <sub>.localhost" :8787/v2/` | 401 + realm rewritten to worker origin (`http://<sub>.localhost/...`, local http as-is) |
| Unknown subdomain | `Host: foo.localhost` | 400 JSON + CORS trio |
| Preflight | `OPTIONS` + `Access-Control-Request-Method` | 204 + CORS, no upstream hit |
| Off-host auth routing | docker `/token`, elastic `/auth` | Forwarded to auth.docker.io / docker-auth.elastic.co respectively (REGISTRY_AUTH table) |
| Anonymous token | `/token?service=…&scope=…` ×2 | 200; second hits cache (upstream count doesn't rise); with Authorization not cached |
| Token TTL | parse `expires_in` | `max-age=min(expires_in-60, 240)` |
| Tag manifest | `/v2/<repo>/manifests/latest` | 200 but no-store (tags mutable, not cached) |
| Digest manifest | `…/manifests/sha256:<64hex>` ×2 | 200 + `public, max-age=604800`; second time upstream count doesn't rise |
| Blob 307 | `…/blobs/sha256:…` | Server-side follows CDN; CDN side **no Authorization**, UA preserved; cached by worker URL |
| HEAD blob | same as above, HEAD | 307 replay keeps HEAD, response has no body |
| **Push 202** | `POST /v2/<n>/blobs/uploads/` | Must **not** follow 202; Location rewritten back to worker origin for PATCH/PUT continuation (PATCH's 204 Location likewise rewritten) |
| Header filtering | what the upstream receives | No `cf-*`/host/accept-encoding/hop-by-hop; Authorization/Accept preserved |
| Real dance | quay/ghcr/nvcr/mcr: challenge→token(with scope)→manifest | All 200; mcr has no challenge, direct |

- **Auth realm mapping is based on empirical measurement** (2026-11 probing): docker.io→auth.docker.io`/token`, elastic→docker-auth.elastic.co`/auth` (off-host, requires (1) realm alias rewrite (2) path routing — missing either breaks it); ecr/ghcr/k8s/nvcr/quay/mcr realms all live on the registry itself (gcr=`/v2/token`, quay=`/v2/auth`, ecr=`/token/` with **trailing slash**). When adding a registry, first probe with `curl -sI https://<registry>/v2/ | grep -i www-authenticate`, then register.
- k8s manifest/blob 307s to `us-west2-docker.pkg.dev` (Google) — unreachable from the local network, E2E explicitly skips; deployed workers go through Cloudflare egress, unaffected.
- Full-chain `docker pull docker.<host>/library/alpine` (optional, requires a domain that can directly reach the worker).

## 5. reverse-proxy empirical matrix

E2E: `audit-reverse-e2e.mjs` + browser shim assertion page (harness `/shim-test`) + git + real sites.

| Face | URL / operation | Expected |
| ---- | --------------- | -------- |
| Usage page | `GET /` | HTML 200 |
| Header filtering | POST `/…/echo` | Upstream has no accept-encoding/cookie/hop-by-hop/cf-\* (host is a protocol-layer artifact); Referer/Origin restored from the worker domain; body as-is |
| HTML rewriting | harness `/` | abs/rel links, srcset, style attributes (**any element**), `<style>` blocks, @import, script, form action all rewritten; preconnect/dns-prefetch removed; shim **injected at the very top of head** and only once |
| CSS | `/css` ×2 | url()/@import rewritten; CT utf-8; CC passed through as `public, max-age`; second hits cache and **still rewritten content** |
| GBK | `/gbk.html` | Transcoded to readable UTF-8 (meta sniff when no header charset) |
| Compression | `/gzip` `/br` (client sends AE) | Upstream receives identity (AE stripped); body plaintext. Response-leg Content-Encoding is the runtime's transparent re-compression per client AE, not asserted |
| Redirects | 301/302/303/307/308 × abs/rel | Status preserved + Location rewritten to worker prefix |
| Cookies | set→echo | Response: `p<tag>name=value; attrs…; Path=/` (**semicolon-separated**, no Domain, __Host-/__Secure- prefixes stripped, SameSite=None gets Secure added); request: prefixes removed, other-site tags dropped |
| Range | `Range: bytes=100-199` | 206 passthrough, bypasses cache |
| 304 | `If-None-Match` | 304 passthrough |
| Edge cache | static types ×2 + /hits counter | Only fully gated responses enter cache (type whitelist + upstream CC allows + no Set-Cookie/Vary restrictions + request has no range/conditional/auth/cookie); HTML always no-store |
| Preflight | OPTIONS + ACRM | 204 + CORS, no upstream hit |
| Userinfo | `/http://user:pass@…/auth401` | URL credentials converted to Basic header, URL sanitized |
| Referer fallback | `GET /bytes` + proxied-page Referer | Resolves to target domain (absolute-path semantics), served through the proxy |
| Git | `clone`/`push`/`re-clone` | Byte-level passthrough, pushed commits visible in a fresh clone |
| WebSocket | shim page ws echo | Send/receive echo + close propagates both ways; subprotocol negotiation echoed (RFC 6455); upgrade carries translated cookies |
| Shim (browser) | in-page assertions on harness `/shim-test` | fetch(rel/abs/Request), XHR, EventSource, sendBeacon, Worker, pushState/replaceState (including idempotence), cookie read/write, img.src, srcset, insertRule, direct form.submit() call, WS — all through the proxy |
| Real sites | example.com, raw.githubusercontent.com | Pages render correctly (including multilingual charsets), raw fetch 200 |

- The shim assertion page is provided by the harness; the final relative navigation `/nav-target` also verifies referer fallback (absolute `location.href` assignment is a registered boundary, see §8).

## 6. Protocol-correctness scan checklist (walk every item each round)

1. **Redirect semantics**: only 3xx followed server-side; 2xx `Location` (upload sessions) rewritten back to the proxy.
2. **Credentials don't cross origins**: server-side follows of cross-origin redirects carry only UA; Authorization never reaches the CDN.
3. **Accept-Encoding**: not passed through (upstream zstd/br compression coming back + us stripping the CE header = garbled; HTML rewriting also needs plaintext); the runtime negotiates gzip itself and transparently decompresses.
4. **Conditional requests**: If-None-Match/If-Modified-Since passed through, 304 passed through.
5. **Method preservation**: 307/308/HEAD replays keep the original method; 204/304 have no body; GET/HEAD fetches sent without a body.
6. **Cookie namespace**: request prefix removal and response prefix addition are inverse operations; attribute-semantics fixes see §5.
7. **Charset**: meta sniff + transcoded output utf-8.
8. **hop-by-hop / cf-\* / Referrer-Policy**: stripped on the request side; CSP/XFO/COOP/COEP/CORP/RP stripped on the response side.
9. **CORS**: proxy responses and error JSON carry the `*` trio; OPTIONS preflight answered locally with 204.
10. **Streaming**: everything streamed except HTML/CSS (must buffer for rewriting) and ≤8MB cache writes.
11. **WS**: subprotocol echo, cookie translation, error/close bidirectional propagation, fallback for invalid close codes.

## 7. Performance audit dimensions

- **Edge cache gating** (consistent across both workers): 200 GET, no Set-Cookie, type/immutability gating (container: digest-addressed blob/manifest + anonymous token; reverse: static-type whitelist + upstream CC explicitly allows), requests with range/conditional/Authorization/cookie always bypass.
- **Dual-track cache writes**: ≤8MB buffered then **inline await put** (deterministic); larger goes tee-streamed waitUntil (the production-standard path; can't be verified in local dev, see §10). TTFB cost limited to the buffered path.
- **CC policy**: rewritten HTML / auth / errors → no-store; digest-immutable content → 7 days; everything else passes upstream directives through (browser caching and revalidate semantics preserved).
- **No X-Proxy-Cache diagnostic header**: responses with `public, max-age` get replayed as-is by shared cache layers, freezing the diagnostic header into the cache (empirically proven). Cache-hit assertions always use upstream counts.
- **Subrequest count**: normal path 1 fetch + ≤1 cache lookup; repeated token/manifest/blob pulls absorbed by cache (= the core anti-rate-limit benefit; Docker Hub anonymous 100/hour counted per egress IP).

## 8. Proxy capability / anti-scraping dimensions

- Request headers preserve the real browser fingerprint (UA/Accept/Sec-Fetch-\* all passed through), only leaking items stripped; Referer/Origin restored to the target domain.
- Shim coverage (the `/shim-test` assertion page is the regression matrix): fetch/XHR/Request constructor/WebSocket/EventSource/sendBeacon/Worker/SharedWorker/pushState/replaceState/window.open/setAttribute/property setters/click links/submit events + direct form.submit() call/insertRule/document.cookie namespace/ServiceWorker interception.
- **Registered boundaries** (can't fix or too costly, don't report as bugs): absolute `location.href/assign/replace` assignment (Location properties are LegacyUnforgeable, patches ineffective — the try patches in the shim work on supporting engines, on other engines relative navigation stays inside the proxy); absolute URLs embedded in iframe srcdoc; fetch inside Worker/SharedWorker **internal** realms (the scripts themselves are already proxied); content restricted by upstream `Vary` not cached.
- Full-chain cookies + challenge-page Location rewriting = logged-in sites and 403/429 challenge redirects survive.
- container-proxy's anti-rate-limit = edge caching of anonymous tokens / digest manifests / blobs.

## 9. Security dimensions

- Open proxy (reverse-proxy has no auth) and cross-target Authorization passthrough = **accepted deployment premises** (personal workers), registered; if tightening is needed, add `PROXY_TOKEN` gating (not implemented).
- **Digest capability-URL trade-off**: digest-addressed content cached by URL (anonymous pulls also carry Bearer, can't distinguish anonymous/logged-in by Authorization) — anyone holding a private image's digest can read that content from this worker's cache; the digest itself is a 64-hex capability string, this trade-off is accepted (same in worker code comments).
- Credential leak surface: redirects don't carry credentials cross-origin; cookie prefix isolation; cache never stores responses with Set-Cookie or from authenticated requests (tokens); URL userinfo is explicit credentials.
- Error paths: console.error + JSON message, no stack returned.

## 10. Environment trap checklist (each empirically proven)

- **Local workerd hot reload poisons Cache API behavior**: same code on a fresh instance is fine; after several hot reloads put silently no-ops/half-writes (hit but empty body). Before cache assertions, always clear `.wrangler` and restart fresh.
- **Local workerd drops waitUntil cache writes for "requests that already issued a subrequest"** (confirmed by controlled experiment: inline await all green / waitUntil+fetch all yellow). This is local runtime behavior, production unaffected; hence ≤8MB cache writes use inline await.
- **Local dev's CDN layer replays worker responses per `public, max-age`** (freezing and replaying all response headers from that moment), the second request may never enter the worker — upstream count is the hit criterion.
- **`wrangler dev` positional argument is the entry script**, config must use `--config` (otherwise "No loader is configured for .jsonc").
- **Zombie workerd holds ports/internal sockets** ("Address already in use socket direct:1:default", lsof often shows no LISTEN): `ps` to find `workerd serve`, kill -9 each, switch ports if needed; occasional runtime crash loops after wrangler crash-restarts, a fresh restart cures it.
- Reusing the harness's git seed directory across startups makes `git commit` fail on empty commits — rm and rebuild at startup.
- biome scans into `.wrangler/` generated artifacts and `scripts/`' test-grouping bare blocks: biome.json already excludes `!**/.wrangler` and disables noUselessLoneBlockStatements for `scripts/**`.
- workerd egress re-compresses responses per client AE (CE header appearing is normal, don't treat as a garbling bug).
- `curl -H "Host: …"` works for testing subdomain routing; node fetch forbids changing Host, use `node:http`.
- Running multiple E2E rounds within one hot reload lets the CDN layer cache stale assertions — for cache-related assertions trust only fresh instances.
- **workerd doesn't consume proxies at all**: the binary has no proxy/socks support whatsoever, `HTTPS_PROXY`/`ALL_PROXY` env vars are ineffective for worker outbound fetch (local full-chain verification of blocked upstreams can only rely on the runner). `scripts/dev-via-proxy.mjs` uses miniflare `outboundService` to hijack outbound fetch back into the Node process — Node 24 native fetch only honors proxy env under `NODE_USE_ENV_PROXY=1`; the runner builds its own `node:http` server + `dispatchFetch` (doesn't depend on the miniflare listener, and naturally preserves Host-header routing), auto-detects module/service-worker format from `export default`, passes `script` content directly to bypass workerd sandbox's "paths must not leave the start directory" restriction. **miniflare must be pinned to 4.x**: 5-beta changed the constructor API entirely (`workers` array), and its bundled workerd version must match the compatibility date (4.20260730 supports up to 2026-08-06; harness-specific downgrade inside the runner, audited workers use only ancient stable APIs).
- When miniflare/dispatchFetch forwards responses, `appendHeader` must come before `writeHead` (Node semantics), otherwise responses with Set-Cookie 500 — the token endpoint hit this first.
- **`NODE_USE_ENV_PROXY=1` is snapshotted at startup**, later `delete process.env` is ineffective: it makes **all `node:http` requests in this process** also go through proxy rewriting (`rewriteForProxiedHttp`), whose validation requires the Host header to match the authority — probes with virtual-routing Host (e.g. mirror.test) + 127.0.0.1 authority inevitably blow up. To simultaneously "test localhost + let the runner proxy egress", the test process must be proxy-free: re-exec itself with a clean env, inject proxy env only into the runner subprocess (worker-specific E2E scripts carry this re-exec pattern).
- Runner `server.listen` failures (port in use, etc.) must explicitly `server.on("error")` and exit, otherwise unhandled error crashes directly with no diagnostics.
- The runner accepts any worker directory argument; **worker-specific audit suites live in the same repo as the worker** (the owning repo's scripts/); this playbook only collects matrices for this repo's two workers.

## 11. Closing loop

1. Fix → `pnpm run ci` → impact-surface matrix (§4/§5 full suite) → full-matrix re-run.
2. Each round, land new lessons into docs: this file (new matrix rows/new traps), AGENTS.md (convention changes), README (capability table/usage), worker header version comments (bump on significant changes).
3. Commit style: conventional (`fix(proxy): …` / `feat(container): …` / `docs: …`), docs committed separately from code.