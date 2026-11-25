# `capdux.org` — CP & Cap 官方包管理平台

> 基于 **Cloudflare Workers + D1 (SQLite) + R2 (零出口流量费)** 构建，原生采用 **Zstd 高压缩格式（`.tar.zst`）** 与 **Sparse Index 稀疏静态索引**，兼顾 npm 的生态体验与 crates.io 的极致性能。

## 架构总览

| 域名 | 职责 | 底层组件 |
| :--- | :--- | :--- |
| `https://capdux.org` | 门户首页、包搜索、版本与依赖浏览、AI `.d.cp` 接口存根预览 | Cloudflare Workers SSR + D1 |
| `https://registry.capdux.org` | 发布（`PUT /v1/publish`）、鉴权、搜索、Yank、去重索引同步 | Cloudflare Workers + D1 + R2 |
| `https://index.capdux.org` | Sparse Index 静态包索引（95%+ `cap install` 直击边缘缓存，零 DB 压力） | Cloudflare R2 + Edge Cache |
| `https://dl.capdux.org` | `.tar.zst` 源码归档与跨平台预编译二进制下载（**永久 $0 出口流量费**） | Cloudflare R2 |

## 核心协议规范

1. **高压缩归档与魔数校验**：
   - 优先接收 **Zstd（`.tar.zst`，魔数 `28 B5 2F FD`）**，同时兼容 npm `.tgz`（`1F 8B`），与 `cap/src/project/archive.zig` 100% 互通；
   - 上传时强制校验归档魔数、体积上限（50 MiB）与 `sha256-<64hex>` / `sha512-<b64>` SRI 完整性，禁止覆写已发布版本（`409 Conflict`）。
2. **安全鉴权**：
   - 密码采用 Web Crypto PBKDF2-SHA256（100,000 轮 + 随机盐）；
   - API Token（`capdux_*`）仅在服务端保存 SHA-256 哈希，支持作用域（`read`/`publish`/`admin`）与即时吊销；
   - 官方命名空间 `@cap/*` 与 `@web/*` 仅允许 `admin` / `maintainer` 发布。
3. **全球去重索引联动（`cap from -npm/-crate`）**：
   - `GET /v1/registry.json` 与 `GET /registry.json` 直接提供全局 npm / crates.io 去重映射，供 `cap from -npm` / `cap from -crate` 毫秒级查重。

## 本地测试

```bash
cd /data/dev/capdux
bun test
```

## 一键部署到 Cloudflare

只需要提供 **最小权限 Cloudflare API Token** 与 **Account ID**（切勿提供账号密码）：

```bash
export CLOUDFLARE_API_TOKEN="你的_scoped_api_token"
export CLOUDFLARE_ACCOUNT_ID="你的_account_id"
export CAPDUX_ADMIN_BOOTSTRAP_KEY="随机生成的32字节管理员密钥" # 可选，用于批量同步官方包

bash scripts/deploy.sh
```

部署完成后，一键把 CP 仓库中已有的官方 `@cap/*` 与 `@web/*` 包批量打包 `.tar.zst` 并发布到 `capdux.org`：

```bash
export CAPDUX_URL="https://registry.capdux.org"
export CAPDUX_TOKEN="$CAPDUX_ADMIN_BOOTSTRAP_KEY"
bun run scripts/seed_official.ts
```
