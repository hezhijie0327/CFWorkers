# AUDIT.md — Cloudflare Workers 审计手册

本仓库（container-proxy + reverse-proxy 两个 worker）的审计手册，结构参考 ZJBlog
AUDIT.md：**按轮审计，直到一轮不再产生新发现为止**。每轮流程：
环境准备 → 门禁 → 本地部署实测矩阵（单元 / E2E / 浏览器 / git / 真实站点）→
性能/代理能力/安全维度扫查 → 修复 → 回归 → 文档同步。新教训追加进本文件
对应章节与 AGENTS.md，同一错误不审计两次。

与 ZJBlog 的关键差异：本项目无构建、无单测框架、无浏览器端产品代码，**一切
正确性验证靠本地部署（wrangler dev）+ 协议级实测矩阵**；两个 worker 是网络
代理，审计核心是「协议正确性 + 代理能力 + 性能（缓存/流式）+ 安全（凭据/头部
泄漏）。

## 1. 环境准备

```sh
pnpm install                    # 唯一 lockfile（pnpm）；wrangler 也在 devDependencies
pnpm run ci                     # biome check + tsc --noEmit（每轮开头先跑到绿）
node scripts/audit-upstream.mjs # 本地测试上游 :8901（协议矩阵的确定性靶机）
pnpm wrangler dev --config workers/reverse-proxy/wrangler.jsonc   --port 8788  # 通用反代
pnpm wrangler dev --config workers/container-proxy/wrangler.jsonc --port 8787  # 容器代理
# 被墙上游（Docker Hub、github.com）的全链验证走代理 runner（见 §10 runner 条目）：
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://10.192.7.1:7890 \
  node scripts/dev-via-proxy.mjs workers/container-proxy 8786
```

审计脚本（`node scripts/audit-*.mjs`，均零依赖、exit 1 = 有失败）：

| 脚本                       | 前置                                   | 覆盖                                                                                                                                                                   |
| -------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit-container-unit.mjs` | 无（mock fetch + 内存 cache）          | Docker Hub / elastic 全协议路径（被墙网络的兜底）：202 Location、realm 路由、token/manifest/blob 缓存、HEAD 重放、cf-\*/AE 头过滤                                      |
| `audit-container-e2e.mjs`  | container wrangler dev :8787           | 真实 quay/ghcr/k8s/nvcr/mcr：challenge→token→manifest→blob 全舞步 + digest 缓存                                                                                        |
| `audit-dockerhub-e2e.mjs`  | dev-via-proxy runner :8786（代理出口） | **真实 Docker Hub 全链**：realm 改写→匿名 token→tag/digest manifest→blob 307 跟随→HEAD；认证段（`DOCKER_ID`/`DOCKER_PAT` env，不落盘）验证 Basic 换 JWT + 账号限流归因 |
| `audit-reverse-e2e.mjs`    | reverse wrangler dev :8788 + harness   | §5 全矩阵（头过滤/改写/GBK/压缩/重定向/cookie/Range/304/缓存门控/预检/userinfo/referer 回落/SSE）                                                                      |

- 国际网络（GitHub、境外 registry、wrangler 下载）：`HTTP_PROXY=http://10.192.7.1:7890
  HTTPS_PROXY=http://10.192.7.1:7890 NO_PROXY=localhost,127.0.0.1`。
- workerd 本地按 **Host 头**路由子域名：`curl -H "Host: quay.localhost" http://127.0.0.1:8787/v2/`。
  node 的 fetch 不允许改 Host 头，Host 路由用 `node:http`（audit-container-e2e 即如此）。
- 本地 Cache API / CDN 层缓存随 `.wrangler/` 状态持久化：**断言缓存行为前先清
  `workers/*/.wrangler` 并全新重启 dev**（见 §10 热载陷阱）。

## 2. 质量门禁（每轮）

```sh
pnpm run lint        # biome check 零错误（CI 同款；biome 需排除 **/.wrangler）
pnpm run typecheck   # tsc strict + checkJs 零错误
```

- 修改任一 worker 后：门禁绿 → 重跑该 worker 的影响面矩阵（§4/§5）。
- `wrangler dev` 热载即生效，但**热载会毒化本地缓存行为**（§10）——缓存断言
  一律在全新重启的实例上跑。

## 3. 依赖更新（每轮）

```sh
pnpm outdated; pnpm update   # devDependencies：biome / typescript / workers-types / wrangler
pnpm run bump-compat         # compatibility_date 对齐最新 wrangler 发布日，review git diff
```

- wrangler 升级后本地起两个 dev 冒烟；**对照 `node_modules/wrangler/config-schema.json`
  校验 wrangler.jsonc 字段名**——`observability.issue_detection` 曾是无效字段
  （现行 schema 为 `observability.issues.enabled`）。
- `@cloudflare/workers-types` 跳版本时注意 RequestInit.duplex 等字段缺口
  （container-proxy 用 `@type {any}` 绕过，注释已登记）。

## 4. container-proxy 实测矩阵

单元级（`audit-container-unit.mjs`，mock 上游覆盖被墙的 Docker Hub/elastic
全协议）+ 真实 registry（`audit-container-e2e.mjs`，quay/ghcr/k8s/nvcr/mcr；
k8s 的 307 目标不可达时显式 skip）。

| 面              | 操作                                                   | 预期                                                                                                |
| --------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 子域路由        | `curl -H "Host: <sub>.localhost" :8787/v2/`            | 401 + realm 改写为 worker origin（`http://<sub>.localhost/...`，本地 http 原样）                    |
| 未知子域        | `Host: foo.localhost`                                  | 400 JSON + CORS 三件套                                                                              |
| 预检            | `OPTIONS` + `Access-Control-Request-Method`            | 204 + CORS，不打上游                                                                                |
| auth 离宿路由   | docker `/token`、elastic `/auth`                       | 分别转发 auth.docker.io / docker-auth.elastic.co（REGISTRY_AUTH 表）                                |
| 匿名 token      | `/token?service=…&scope=…` ×2                          | 200；第二次命中缓存（上游计数不涨）；带 Authorization 的不缓存                                      |
| token TTL       | 解析 `expires_in`                                      | `max-age=min(expires_in-60, 240)`                                                                   |
| tag manifest    | `/v2/<repo>/manifests/latest`                          | 200 但 no-store（tag 可变，不缓存）                                                                 |
| digest manifest | `…/manifests/sha256:<64hex>` ×2                        | 200 + `public, max-age=604800`；第二次上游计数不涨                                                  |
| blob 307        | `…/blobs/sha256:…`                                     | 服务端跟随 CDN；CDN 侧**无 Authorization**、保留 UA；按 worker URL 入缓存                           |
| HEAD blob       | 同上 HEAD                                              | 307 重放保持 HEAD、响应无 body                                                                      |
| **push 202**    | `POST /v2/<n>/blobs/uploads/`                          | **不得**跟随 202；Location 改写回 worker origin 供 PATCH/PUT 续传（PATCH 的 204 Location 同样改写） |
| 头过滤          | 上游收到什么                                           | 无 `cf-*`/host/accept-encoding/hop-by-hop；Authorization/Accept 保留                                |
| 真实舞步        | quay/ghcr/nvcr/mcr：challenge→token(带 scope)→manifest | 全 200；mcr 无 challenge 直连                                                                       |

- **auth realm 映射以实测为准**（2026-11 探测）：docker.io→auth.docker.io`/token`、
  elastic→docker-auth.elastic.co`/auth`（离宿，须 ①realm 别名改写 ②路径路由，缺一即坏）；
  ecr/ghcr/k8s/nvcr/quay/mcr 的 realm 都在 registry 自身（gcr=`/v2/token`、quay=`/v2/auth`、
  ecr=`/token/` 带**尾斜杠**）。新增 registry 时先 `curl -sI https://<registry>/v2/ |
  grep -i www-authenticate` 探测再登记。
- k8s 的 manifest/blob 会 307 到 `us-west2-docker.pkg.dev`（Google）——本机网络不可达，
  E2E 显式 skip；部署后的 worker 走 Cloudflare 出口不受影响。
- 全链路 `docker pull docker.<host>/library/alpine`（可选，需可直连 worker 的域名）。

## 5. reverse-proxy 实测矩阵

E2E：`audit-reverse-e2e.mjs` + 浏览器 shim 断言页（harness `/shim-test`）+ git + 真实站点。

| 面             | URL / 操作                             | 预期                                                                                                                                                                           |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 用法页         | `GET /`                                | HTML 200                                                                                                                                                                       |
| 头过滤         | POST `/…/echo`                         | 上游无 accept-encoding/cookie/hop-by-hop/cf-\*（host 是协议层产物）；Referer/Origin 从 worker 域还原；body 原样                                                                |
| HTML 改写      | harness `/`                            | abs/rel 链接、srcset、style 属性（**任意元素**）、`<style>` 块、@import、script、form action 全改写；preconnect/dns-prefetch 移除；shim **前置注入 head 首位**且仅一次         |
| CSS            | `/css` ×2                              | url()/@import 改写；CT utf-8；CC 透传为 `public, max-age`；第二次命中缓存且**仍是改写后内容**                                                                                  |
| GBK            | `/gbk.html`                            | 转码为可读 UTF-8（无 header charset 时 meta sniff）                                                                                                                            |
| 压缩           | `/gzip` `/br`（客户端带 AE）           | 上游收到 identity（AE 剥离）；body 明文。响应腿的 Content-Encoding 是 runtime 按客户端 AE 的透明重压缩，不作断言                                                               |
| 重定向         | 301/302/303/307/308 × abs/rel          | 状态保持 + Location 改写为 worker 前缀                                                                                                                                         |
| cookie         | set→echo                               | 响应：`p<tag>名=值; 属性…; Path=/`（**分号分隔**、无 Domain、__Host-/__Secure- 前缀剥离、SameSite=None 补 Secure）；请求：去前缀、他站 tag 丢弃                                |
| Range          | `Range: bytes=100-199`                 | 206 透传且不走缓存                                                                                                                                                             |
| 304            | `If-None-Match`                        | 304 透传                                                                                                                                                                       |
| 边缘缓存       | 静态类型 ×2 + /hits 计数               | 仅门控全过的入缓存（类型白名单 + 上游 CC 允许 + 无 Set-Cookie/Vary 限制 + 请求无 range/条件/鉴权/cookie）；HTML 永远 no-store                                                  |
| 预检           | OPTIONS + ACRM                         | 204 + CORS，不打上游                                                                                                                                                           |
| userinfo       | `/http://user:pass@…/auth401`          | URL 凭据转 Basic 头，URL 净化                                                                                                                                                  |
| Referer 回落   | `GET /bytes` + 代理页 Referer          | 解析到目标域（绝对路径语义），经代理服务                                                                                                                                       |
| git            | `clone`/`push`/`re-clone`              | 字节级透传，push 的提交在新 clone 可见                                                                                                                                         |
| WebSocket      | shim 页 ws echo                        | 收发回显 + 关闭双向传播；子协议协商回显（RFC 6455）；升级带翻译后 cookie                                                                                                       |
| shim（浏览器） | harness `/shim-test` 页内断言          | fetch(rel/abs/Request)、XHR、EventSource、sendBeacon、Worker、pushState/replaceState（含幂等）、cookie 读写、img.src、srcset、insertRule、form.submit() 直调、WS —— 全部经代理 |
| 真实站点       | example.com、raw.githubusercontent.com | 页面渲染正确（含多语言 charset）、raw fetch 200                                                                                                                                |

- shim 断言页由 harness 提供，最终相对导航 `/nav-target` 顺带验证 referer 回落
  （绝对 `location.href` 赋值属已登记边界，见 §8）。

## 6. 协议正确性扫查清单（每轮逐项过）

1. **重定向语义**：只有 3xx 服务端跟随；2xx 的 `Location`（upload 会话）改写回代理。
2. **凭据不跨域**：服务端跟随跨域 redirect 只带 UA；Authorization 不进 CDN。
3. **Accept-Encoding**：不透传（zstd/br 上游压缩回来 + 我们剥 CE 头 = 乱码；
   HTML 改写也需要明文）；runtime 自行协商 gzip 并透明解压。
4. **条件请求**：If-None-Match/If-Modified-Since 透传，304 透传。
5. **方法保持**：307/308/HEAD 重放保持原方法；204/304 无 body；GET/HEAD 不带 body 发 fetch。
6. **cookie 命名空间**：请求去前缀、响应加前缀互逆；属性语义修正见 §5。
7. **charset**：meta sniff + 转码输出 utf-8。
8. **hop-by-hop / cf-\* / Referrer-Policy**：请求侧剥离；响应侧 CSP/XFO/COOP/COEP/CORP/RP 剥离。
9. **CORS**：代理响应与错误 JSON 带 `*` 三件套；OPTIONS 预检本地 204。
10. **流式**：除 HTML/CSS（必须 buffer 改写）与 ≤8MB 的缓存写入外一律流式。
11. **WS**：子协议回显、cookie 翻译、error/close 双向传播、close 码非法时兜底。

## 7. 性能审计维度

- **边缘缓存门控**（两 worker 一致）：200 GET、无 Set-Cookie、类型/不可变性
  门控（container：digest 寻址 blob/manifest + 匿名 token；reverse：静态类型
  白名单 + 上游 CC 明确允许）、请求带 range/条件/Authorization/cookie 一律旁路。
- **缓存写入双轨**：≤8MB 缓冲后**内联 await put**（确定性）；更大走 tee 流式
  waitUntil（生产标准路径；本地 dev 验证不了，见 §10）。TTFB 代价仅限缓冲路径。
- **CC 策略**：改写 HTML / auth / 错误 → no-store；digest 不可变内容 → 7 天；
  其余透传上游指令（浏览器缓存与 revalidate 语义保留）。
- **不用 X-Proxy-Cache 诊断头**：带 `public, max-age` 的响应会被共享缓存层
  原样回放，诊断头会被冻结进缓存（实证）。缓存命中断言一律用上游计数。
- **子请求数**：正常路径 1 fetch + ≤1 cache 查询；token/manifest/blob 重复拉取
  被缓存吸收（= 反限流核心收益，docker hub 匿名 100 次/小时按出口 IP 计）。

## 8. 代理能力 / 反爬维度

- 请求头保留真实浏览器指纹（UA/Accept/Sec-Fetch-\* 全透传），仅剥泄漏项；
  Referer/Origin 还原为目标域。
- shim 覆盖面（`/shim-test` 断言页即回归矩阵）：fetch/XHR/Request 构造器/
  WebSocket/EventSource/sendBeacon/Worker/SharedWorker/pushState/replaceState/
  window.open/setAttribute/属性 setter/click 链接/submit 事件 + form.submit()
  直调/insertRule/document.cookie 命名空间/ServiceWorker 拦截。
- **已登记边界**（修不了或代价过高，勿当 bug 报）：绝对 `location.href/assign/
  replace` 赋值（Location 属性 LegacyUnforgeable，补丁无效——shim 里的 try 补丁
  在支持的引擎生效，其余引擎相对导航仍留在代理内）；iframe srcdoc 内嵌绝对 URL；
  Worker/SharedWorker **内部** realm 的 fetch（脚本本身已代理）；上游 `Vary`
  限制的内容不缓存。
- cookie 全链路 + 挑战页 Location 改写 = 登录态站点与 403/429 挑战跳转存活。
- container-proxy 的反限流 = 匿名 token / digest manifest / blob 边缘缓存。

## 9. 安全维度

- 开放代理（reverse-proxy 无鉴权）与跨目标 Authorization 透传 = **已接受的
  部署前提**（个人 worker），登记在案；如需收敛加 `PROXY_TOKEN` 门控（未实现）。
- **digest 能力 URL 权衡**：digest 寻址内容按 URL 缓存（匿名拉取也带 Bearer，
  无法以 Authorization 区分匿名/登录）——持有私有镜像 digest 者可从本 worker
  缓存读取该内容；digest 本身即 64-hex 能力串，接受此权衡（worker 代码注释同）。
- 凭据泄漏面：redirect 不带凭据跨域；cookie 前缀隔离；缓存永不存带 Set-Cookie
  或鉴权请求（token）的响应；URL userinfo 即显式凭据。
- 错误路径：console.error + JSON message，不回栈。

## 10. 环境陷阱清单（逐条实证）

- **本地 workerd 热载后 Cache API 行为毒化**：同代码新实例正常，热载若干次后
  put 静默无效/半写（命中但 body 空）。缓存断言前必清 `.wrangler` 全新重启。
- **本地 workerd 丢弃「已发过 subrequest 的请求」的 waitUntil 缓存写**（受控
  实验证实：inline await 全绿 / waitUntil+fetch 全黄）。这是本地运行时行为，
  生产不受影响；因此 ≤8MB 缓存写入走内联 await。
- **本地 dev 的 CDN 层会按 `public, max-age` 回放 worker 响应**（连同当时的一切
  响应头冻结重放），第二次请求可能根本不进 worker——上游计数才是命中判据。
- **`wrangler dev` 位置参数是入口脚本**，config 必须用 `--config`（否则
  "No loader is configured for .jsonc"）。
- **zombie workerd 占端口/内部 socket**（"Address already in use socket
  direct:1:default"，lsof 常看不到 LISTEN）：`ps` 找 `workerd serve` 逐个 kill -9，
  必要时换端口；wrangler 崩溃重启后偶发运行时 crash loop，全新重启即愈。
- harness 的 git 种子目录跨启动复用会让 `git commit` 空提交失败——启动时 rm 重建。
- biome 会扫进 `.wrangler/` 生成物与 `scripts/` 的测试分组裸块：biome.json 已
  排除 `!**/.wrangler` 并对 `scripts/**` 关闭 noUselessLoneBlockStatements。
- workerd 出口会按客户端 AE 重新压缩响应（CE 头出现属正常，别当乱码 bug）。
- `curl -H "Host: …"` 测子域路由可行；node fetch 禁改 Host，用 `node:http`。
- E2E 一次热载内跑多轮会让 CDN 层缓存旧断言——跑缓存相关断言只信全新实例。
- **workerd 完全不吃代理**：二进制里没有任何 proxy/socks 支持，`HTTPS_PROXY`/
  `ALL_PROXY` 环境变量对 worker 的出站 fetch 无效（被墙上游的本地全链验证只能靠
  runner）。`scripts/dev-via-proxy.mjs` 用 miniflare `outboundService` 把出站
  fetch 劫持回 Node 进程——Node 24 原生 fetch 在 `NODE_USE_ENV_PROXY=1` 下才认
  代理 env； runner 里自建 `node:http` 服务器 + `dispatchFetch`（不依赖
  miniflare listener，且天然保留 Host 头路由），按 `export default` 自动判
  module/service-worker 格式，`script` 内容直传绕开 workerd 沙箱「路径不得离开
  起始目录」限制。**miniflare 必须钉 4.x**：5-beta 构造器 API 全变（`workers`
  数组），且其内置 workerd 版本必须与兼容日匹配（4.20260730 支持到
  2026-08-06，runner 里 harness 专用降级，被审 worker 只用远古稳定 API）。
- miniflare/dispatchFetch 转发响应时 `appendHeader` 必须在 `writeHead` 之前
  （Node 语义），否则带 Set-Cookie 的响应 500——token 端点最先踩中。
- **`NODE_USE_ENV_PROXY=1` 在启动时快照**，事后 `delete process.env` 无效：
  它会让**本进程所有 `node:http` 请求**也走代理重写（`rewriteForProxiedHttp`），
  重写校验 Host 头必须匹配 authority——虚拟路由 Host（如 mirror.test）+
  127.0.0.1 authority 的探针必炸。要同时「测 localhost + 让 runner 代理出口」
  时，测试进程必须 proxy-free：re-exec 干净 env 重启自身，代理 env 只注入
  runner 子进程（worker 专属 E2E 脚本自带此 re-exec 模式）。
- runner 的 `server.listen` 失败（端口占用等）必须显式 `server.on("error")`
  退出，否则 unhandled error 直接崩且无诊断。
- runner 接受任意 worker 目录参数；**worker 专属的审计套件与 worker 同仓存放**
  （归属仓库的 scripts/），本手册只收本仓库两个 worker 的矩阵。

## 11. 收尾闭环

1. 修复 → `pnpm run ci` → 影响面矩阵（§4/§5 全套）→ 全矩阵复跑。
2. 每轮把新教训落文档：本文件（新矩阵行/新陷阱）、AGENTS.md（约定变更）、
   README（能力表/用法）、worker 头部版本注释（显著变更 bump）。
3. 提交风格：约定式（`fix(proxy): …` / `feat(container): …` / `docs: …`），
   文档与代码分开提交。
