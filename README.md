# Cloudflare Workers 工具集

这个仓库包含了多个实用的 Cloudflare Workers 脚本，用于提供各种网络代理和服务功能。

## 项目概览

| 目录                       | 功能                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `workers/container-proxy/` | 容器镜像仓库代理（Docker Hub、GHCR、quay.io、gcr.io 等 9 个源，支持 login/pull/**push**、token/manifest/blob 边缘缓存） |
| `workers/reverse-proxy/`   | 通用反向代理（任意 URL 透传、网页/URL 改写、SPA 客户端垫片、git clone/push、WebSocket、静态资源边缘缓存）               |

## 能力速览

**container-proxy**（`docker.<worker-host>/v2/…`、`ghcr.<worker-host>/…` 等子域名路由）

- 认证挑战（WWW-Authenticate realm）改写回代理，`docker login` 与拉取的 token
  协商全程走代理；离宿认证端点（auth.docker.io、docker-auth.elastic.co）自动路由
- blob 层 307 → CDN 的服务端跟随（凭据绝不跨域），digest 寻址的 manifest/blob
  与匿名 token 按内容寻址进边缘缓存（重复拉取不再触发上游限流）
- 镜像推送：upload 会话的 `202/204 Location` 改写回代理，PATCH/PUT 续传可用
- CORS 预检本地应答，错误统一 JSON + CORS

**reverse-proxy**（`https://worker/https://example.com/page`）

- HTMLRewriter 全元素 URL 改写（含 `style`/`formaction`/srcset/@import），
  GBK 等传统字符集自动转码为 UTF-8
- 注入 SPA 客户端垫片（fetch/XHR/Request/EventSource/sendBeacon/Worker/
  WebSocket/pushState/location/表单直提交/CSSOM/cookie 命名空间），登录态站点
  与运行时请求全程留在代理内
- cookie 按目标站点哈希前缀隔离（防跨站碰撞），`__Host-`/`SameSite=None` 等
  属性语义自动修正；`https://user:pass@target` 形式的 URL 凭据转为 Basic 认证
- git smart-HTTP 字节级透传（`git clone`/`push`）、WebSocket 中继（含子协议
  协商）、Range/条件请求透传、静态资源按上游缓存指令门控的边缘缓存

## 部署方法

### 准备工作

1. 注册 Cloudflare 账号
2. 安装 Wrangler CLI（仓库 devDependencies 已含，或全局安装）：

```bash
npm install -g wrangler
```

3. 登录 Cloudflare：

```bash
wrangler auth login
```

### 部署单个 Worker

每个 worker 位于独立目录（含 `worker.js` 与各自的 `wrangler.jsonc`，`name` 按需修改）：

```bash
# 部署容器代理
wrangler deploy --config workers/container-proxy/wrangler.jsonc

# 部署通用反向代理
wrangler deploy --config workers/reverse-proxy/wrangler.jsonc
```

## 审计与本地测试

质量门禁与协议实测矩阵见 [AUDIT.md](AUDIT.md)。快速上手：

```bash
pnpm run ci                          # biome + tsc 门禁
node scripts/audit-container-unit.mjs  # container-proxy 单元审计（无需起服务，33 项）

node scripts/audit-upstream.mjs       # 本地测试上游 :8901
pnpm wrangler dev --config workers/reverse-proxy/wrangler.jsonc --port 8788
node scripts/audit-reverse-e2e.mjs    # reverse-proxy E2E（77 项）

# 被墙上游（Docker Hub、github.com）的全链验证：workerd 本身不吃代理，
# runner 把 worker 的出站 fetch 劫持到 Node 进程走 HTTPS_PROXY：
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://10.192.7.1:7890 \
  node scripts/dev-via-proxy.mjs workers/container-proxy 8786 &
node scripts/audit-dockerhub-e2e.mjs  # 真实 Docker Hub 全链（17 项；认证段用
                                      # DOCKER_ID/DOCKER_PAT env，凭据不落盘）

node scripts/audit-ghmirror-unit.mjs  # gh-mirror 单元审计（25 项；worker 源在
                                      # ../blog/workers/gh-mirror/，argv 可覆写）

pnpm wrangler dev --config workers/container-proxy/wrangler.jsonc --port 8787
node scripts/audit-container-e2e.mjs  # container-proxy 真实 registry E2E（19 项）
```

浏览器 shim 断言页：dev 起好后访问
`http://127.0.0.1:8788/http://127.0.0.1:8901/shim-test`（页内 16 项断言）。

## 注意事项

1. 所有代理响应都带 CORS 支持，可以跨域访问；OPTIONS 预检由 worker 本地应答
2. 部署前请确保已正确配置 Cloudflare 账户和域名
3. 某些脚本可能需要根据实际使用场景进行配置调整
4. 建议在生产环境中使用自定义域名而不是 Workers 的默认域名
5. reverse-proxy 是无鉴权的开放代理（个人使用前提）；缓存永不落带
   Set-Cookie 或鉴权请求的响应，详见 AUDIT.md §9

## 许可证

本项目采用Apache License 2.0 with Commons Clause v1.0许可证 - 详见[LICENSE](LICENSE)文件
