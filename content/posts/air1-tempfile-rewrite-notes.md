+++
title = "Air1 TempFile 改造笔记"
date = "2026-07-06"
lastmod = "2026-07-06"
description = "记录 Air1 TempFile 从手动粘贴 Worker JS 部署，改造成 GitHub 推送 + Cloudflare Pages 自动构建的全过程，以及 WebDAV 分片上传的尝试、踩坑和回退。"
url = "/air1-tempfile-rewrite-notes/"
aliases = ["/posts/air1-tempfile-rewrite-notes/"]
categories = ["笔记"]
draft = false
+++
> **仓库**: <https://github.com/haenlau/TempFile>
> **线上地址**: <https://tmp.air1.cn/>
> **当前部署**: Cloudflare Pages + Pages Functions / Advanced Worker，GitHub 自动构建
> **最新状态**: 已回退到最大上传 99 MiB 的稳定版本

记录 Air1 TempFile 从"手动粘贴 Worker JS 部署"改造成"GitHub 推送 + Cloudflare Pages 自动构建"的过程，也记录了后来尝试 WebDAV 分片大文件上传、发现问题、最终回退到 99 MiB 稳定版本的完整经过。

---

## 1. 项目背景

Air1 TempFile 是一个部署在 Cloudflare 上的临时文件上传工具，用于快速分享文件，7 天自动销毁。

当前版本核心策略：

- **最大上传限制**：99 MiB
- **小文件存储**：Cloudflare KV（≤24 MiB）
- **可选大文件后端**：R2、S3、WebDAV（24 MiB - 99 MiB）
- **超过 99 MiB**：直接拒绝，不分片，不妥协
- **上传接口**：公开，无需口令
- **部署方式**：GitHub 推送 → Cloudflare 自动构建

一句话：**当前目标不是做超大文件传输工具，而是做一个稳定、轻量、适合临时分享的文件中转站。**

---

## 2. 改造前状态

最初项目是一个直接部署在 Cloudflare Workers 上的单文件 JS，使用方式是：

1. 代码由千问网页生成
2. 手动粘贴到 Cloudflare Worker 编辑器
3. 在 Dashboard 绑定 KV 空间和变量
4. 绑定自定义域名

当时用到的变量：

| 变量名 | 说明 |
|--------|------|
| `UPLOAD_TOKEN` | 上传令牌（实际并未被前端使用） |
| `WEBDAV_ACCOUNT` | WebDAV 账号 |
| `WEBDAV_PASSWORD` | WebDAV 密码 |
| `WECOM_WEBHOOK_URL` | 企业微信 Webhook |
| `TEMP_STORE` | KV 空间绑定 |

### 改造动机

- 每次改代码都要手动粘贴，繁琐且容易出错
- 没有版本管理，改坏了无法回退
- 无法多人协作
- 无法自动构建和部署

---

## 3. 改造目标

- ✅ GitHub 仓库化管理
- ✅ Cloudflare Pages 自动构建（GitHub 推送即部署）
- ✅ 保持旧版 Air1 TempFile 前端样式不变
- ✅ 去掉上传口令逻辑，保持公开上传
- ✅ 不提交 `wrangler.toml`，绑定通过 Dashboard 管理
- ✅ 保留 KV、R2、S3、WebDAV 多种后端支持
- ✅ 支持企业微信 / Telegram 通知

### 为什么不提交 wrangler.toml

这是本项目的一个重要约定：

- 维护者习惯通过 Cloudflare Dashboard 管理 KV、R2、环境变量和 Secrets
- 如果绑定由 `wrangler.toml` 管理，Dashboard 会提示"由配置文件管理"，不便 Web UI 修改
- 当前项目的维护方式以 Dashboard 为主

---

## 4. Cloudflare Pages 构建配置

在 Cloudflare Dashboard 新建 Pages 项目并连接 GitHub 仓库 `haenlau/TempFile`：

| 项目 | 值 |
|------|-----|
| Framework preset | None |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js version | 20 或 22 |

进入 **Settings → Functions** 设置：

- **Compatibility date**：`2026-07-06` 或更新日期
- KV、R2、环境变量、Secrets 通过 Dashboard 添加

### 域名绑定

绑定 `tmp.air1.cn` 到 Pages 项目。

> ⚠️ 如果旧 Worker route 仍然绑定这个域名，需要先移除旧 route，否则路由冲突。

### GitHub 仓库

```text
haenlau/TempFile
```

本地开发路径：`本地项目路径/TempFile`

---

## 5. 当前项目结构

```
src/
├── index.ts          # Worker 入口、路由和上传流程
├── html.ts           # 旧版上传页面
├── config.ts         # 运行时固定配置和环境变量解析
├── storage.ts        # KV / R2 / S3 / WebDAV 存储与下载逻辑
├── r2.ts             # Cloudflare R2 后端
├── s3.ts             # S3 / S3-compatible 后端
├── webdav.ts         # WebDAV 后端
├── notify.ts         # 企业微信 / Telegram 通知
├── download-page.ts  # 下载链接不存在或过期提示页
└── utils.ts          # 通用工具函数
```

没有分片上传接口相关代码。

---

## 6. 存储策略

### 6.1 小文件（≤24 MiB）

- 直接写入 `TEMP_STORE` KV
- 文件内容和 metadata 都在 KV 中
- 下载时直接从 KV 返回

### 6.2 中等文件（24 MiB < 大小 ≤ 99 MiB）

- 必须配置 `LARGE_STORAGE_BACKEND`
- 可选后端：`r2`、`s3`、`webdav`
- 文件本体写入后端，KV 只保存短链索引和 metadata

### 6.3 超过 99 MiB

- 前端直接提示不能超过 99MB
- 后端也会拒绝
- 不会尝试分片上传

---

## 7. 上传接口

### 7.1 普通上传

```http
POST /api/upload-public
```

兼容旧路径：

```http
POST /api/upload
```

**要求**：

- `multipart/form-data`
- 文件字段名：`file`
- 支持多文件

**限制**：

- 单文件 ≤ 99 MiB
- 单次上传总大小 ≤ 99 MiB
- 多文件 ZIP 后也不能超过 99 MiB

**成功返回示例**：

```json
{
  "downloadUrl": "https://tmp.air1.cn/abc123",
  "fileId": "abc123",
  "filename": "example.zip",
  "size": 123456,
  "storage": "kv",
  "expiresAt": "2026-07-13T06:39:58.220Z"
}
```

### 7.2 当前不存在的接口

以下分片接口已经回退，不再存在：

```http
POST /api/upload/chunk/init
PUT /api/upload/chunk/{uploadId}/{index}
POST /api/upload/chunk/complete
```

---

## 8. 下载接口

```http
GET /{id}
```

**短链规则**：

- 6 位，数字 + 小写字母
- 字符集：`0123456789abcdefghijklmnopqrstuvwxyz`
- 示例：`psf5i7`、`2nofgm`
- 兼容旧链接（旧的 10-32 位字母数字 ID 仍然可访问）

**下载响应设置**：

- `Content-Type`
- `Content-Disposition`
- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`

**过期提示**：链接不存在或过期时返回中文提示页（`src/download-page.ts`）

---

## 9. 通知系统

支持两种通知渠道，可单独启用或同时启用。

### 企业微信

| 变量 | 说明 |
|------|------|
| `WECOM_WEBHOOK_URL` | 企业微信机器人 Webhook 地址 |

### Telegram

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Bot Token |
| `TELEGRAM_CHAT_ID` | 接收通知的 Chat ID |

> ⚠️ 两个变量必须成对配置，只填一个会导致通知失败。通知失败不会影响上传结果。

### 通知模板

```text
Air1 TempFile：新文件上传
文件名：upload.zip
大小：1.20 MB
存储：KV
上传 IP：203.0.113.10
时间：2026/7/6 14:02:45
过期：2026/7/13 14:02:44
下载地址：https://tmp.air1.cn/abc123
```

通知通过 `ctx.waitUntil(...)` 在后台发送，**成功或失败都不在前端提示**，只在运行日志中记录。

---

## 10. WebDAV 分片上传 — 一次不成功的尝试

> 这一段是历史记录，不是当前功能。

### 想法

- 上传上限改为 2 GiB
- 单文件超过 99MB 走 WebDAV 分片
- 分片大小 48 MiB
- KV 保存分片上传会话
- 每片上传成功后写 KV 收据
- 完成后生成短链

### 第一次方案：下载时流式拼接

下载时 Worker 按顺序读取 WebDAV 分片，用响应流拼接给浏览器。

**问题**：真实环境里下载时只拿到一个分片。同一个链接反复下载会得到不同分片，浏览器本地得到多个残缺文件。

### 第二次方案：TransformStream

改成 `TransformStream + writer.write()`，希望通过背压顺序写出所有分片。

**问题**：本地测试通过，真实 Cloudflare 环境仍然不可靠。

### 第三次方案：上传完成时合并

上传完成时把 WebDAV 分片合并成完整文件，下载只下载完整文件。

**问题**：合并过程发生在 `complete` 请求里，WebDAV 较慢时容易导致前端 `Network connection lost`，用户体验变差。

### 教训

- **WebDAV 不是为浏览器大文件分片上传设计的协议**
- Worker 中转分片并在边缘环境里合并大文件，容易遇到平台和网络边界
- 为了一个临时文件工具把系统复杂度推到这个程度不值得

### 回退

最终回退到 99 MiB 稳定版本，三个回退提交：

```text
3548f26 Revert "Merge WebDAV chunks before download"
f988268 Revert "Fix chunked WebDAV downloads"
5b414ce Revert "Add WebDAV chunked uploads"
```

---

## 11. 当前推荐配置

### 11.1 最稳配置 — 仅 KV（≤24 MiB）

```
KV namespace binding: TEMP_STORE
```

### 11.2 推荐中等文件配置 — KV + R2（≤99 MiB）

```
KV namespace binding:   TEMP_STORE
R2 bucket binding:      R2_BUCKET
Environment variable:   LARGE_STORAGE_BACKEND=r2
```

可选：

```
PUBLIC_BASE_URL=https://tmp.air1.cn/
```

### 11.3 WebDAV 配置（24 MiB - 99 MiB）

```
KV namespace binding:   TEMP_STORE
Environment variable:   LARGE_STORAGE_BACKEND=webdav
Environment variable:   WEBDAV_URL=https://your-webdav-host/path/
Secret:                 WEBDAV_ACCOUNT=...
Secret:                 WEBDAV_PASSWORD=***
```

> 注意：当前 WebDAV 不是分片模式，超过 99 MiB 仍然会拒绝。

---

## 12. 上传 IP 获取

后端按以下顺序获取上传 IP：

1. `CF-Connecting-IP`
2. `True-Client-IP`
3. `X-Forwarded-For` 第一个 IP
4. `unknown`

---

## 13. 本地开发

```bash
npm install        # 安装依赖
npm run typecheck  # TypeScript 类型检查
npm run build      # esbuild 打包生成 dist/_worker.js
npm run dev        # 本地启动 Cloudflare Pages runtime
npm run deploy     # 手动部署到 Cloudflare Pages
```

### 本地 .dev.vars 示例

```ini
LARGE_STORAGE_BACKEND=webdav
WEBDAV_URL=https://example.com/dav/tempfile/
WEBDAV_ACCOUNT=your-webdav-account
WEBDAV_PASSWORD=your-webdav-password
PUBLIC_BASE_URL=http://localhost:8788/
```

---

## 14. 排障指南

### 超过 24MiB 上传失败

检查 `LARGE_STORAGE_BACKEND` 是否配置。未配置时超过 KV 阈值会失败。

### 超过 99MiB 上传失败

当前预期行为。当前版本最大只支持 99 MiB，不是 bug。

### 上传成功但通知没收到

检查 `WECOM_WEBHOOK_URL`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。通知失败不会影响上传，看 Cloudflare Functions 日志排查。

### 下载链接显示过期页

可能原因：

- KV 记录过期
- KV namespace 绑定错误
- 生产环境和预览环境绑定了不同 KV
- 后端对象被清理
- 短链 ID 不存在

### 返回链接域名不是 tmp.air1.cn

检查 `PUBLIC_BASE_URL`。如果需要强制返回正式域名：

```ini
PUBLIC_BASE_URL=https://tmp.air1.cn/
```

---

## 15. 如果未来要支持大文件

不要再优先走 WebDAV 分片，更合理的方向是 **R2 Multipart Upload**：

- R2 是 Cloudflare 原生对象存储，支持 multipart upload
- 浏览器分片上传到 Worker，Worker 调用 R2 multipart API 上传 part
- R2 服务端完成合并，下载时是单个完整对象
- 不需要 WebDAV 分片拼接，不需要 Worker 自己下载分片再合并

但注意：这应该作为独立大版本设计，不能在当前稳定分支里仓促加入。

---

## 16. 重要提交记录

| 提交 | 说明 |
|------|------|
| `5b414ce` | **当前最新** — Revert "Add WebDAV chunked uploads" |
| `c80d1ac` | Shorten download ids |
| `bc446ce` | Add expired download page |
| `d2d6473` | Localize upload notifications |
| ~~`c5fec03`~~ | ~~已回退 — Add WebDAV chunked uploads~~ |
| ~~`c90a8a7`~~ | ~~已回退 — Fix chunked WebDAV downloads~~ |
| ~~`b5d1cba`~~ | ~~已回退 — Merge WebDAV chunks before download~~ |

---

## 17. 总结

截至本文，Air1 TempFile 项目的关键状态：

| 项目 | 状态 |
|------|:----:|
| GitHub 仓库化 | ✅ 已完成 |
| Cloudflare Pages 自动构建 | ✅ 已完成 |
| 不使用 wrangler.toml | ✅ Dashboard 管理 |
| 前端保持旧版样式 | ✅ 已保留 |
| 上传接口公开 | ✅ 无口令 |
| KV 小文件存储 | ✅ 正常 |
| R2/S3/WebDAV 中文件后端 | ✅ 可用 |
| 通知（企业微信/Telegram） | ✅ 已支持 |
| 下载短链（6 位字母数字） | ✅ 已启用 |
| 最大上传 99 MiB | ✅ 已稳定 |
| WebDAV 分片上传 | ❌ 已回退 |
| 2GB 大文件上传 | ❌ 不属于当前版本能力 |

核心维护原则：**稳定优先，最大上传 99 MiB，不再用 WebDAV 硬撑超大文件。**
