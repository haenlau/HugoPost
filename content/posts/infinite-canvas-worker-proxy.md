+++
author = "haenlau"
title = "无限画布的 Worker 同源代理"
url = "/infinite-canvas-worker-proxy/"
date = "2026-10-27T09:07:46+00:00"
description = "无限画布定制版运行在 Cloudflare Workers 上，以单个 Worker 提供静态页面与受限的 CORS 代理。本文整理项目结构、前端定制、构建部署、上游同步、应用侧数据存储和维护时需要守住的安全边界。"
tags = [
  "记录",
]
+++

无限画布定制版运行在 Cloudflare Workers 上，以单个 Worker 提供静态页面与受限的 CORS 代理。本文整理项目结构、前端定制、构建部署、上游同步、应用侧数据存储和维护时需要守住的安全边界。

## 1. 项目结构

项目基于开源仓库 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)，采用 React 19、Vite 7、TypeScript 和 Zustand。它是纯前端 SPA，没有独立业务后端；渠道配置、API Key 和画布数据保存在浏览器的 Local Storage 与 IndexedDB 中。

定制版本部署在 Cloudflare Workers。Worker 同时托管前端静态资源并提供 CORS 代理，主入口为 [canvas.air1.cn](https://canvas.air1.cn)，默认 Workers 域名指向同一服务。静态资源由 web/dist 提供，修改前端源码后必须重新构建，部署才会包含变更。

## 2. Worker 与 CORS 代理

`worker/index.js` 负责静态资源路由、代理请求和代理健康检查端点 `/__proxy_ping`。根路径 `/` 保留给 SPA，因此应用里的代理连通性测试需要访问 `/__proxy_ping`，不能用根路径代替。

代理目标由 `PROXY_ALLOWED_HOSTS` 控制，使用逗号分隔的主机名白名单。白名单应只包含确实需要转发的上游域名。置空会让 Worker 代理失去目标限制，可能被陌生人滥用成公共跳板，不应这样部署。

前端的 `withLocalProxy` 会在用户没有显式启用本地代理时，默认使用当前站点同源代理。Worker 通过 Origin 信任校验处理站内请求；来自站外的代理请求仍应遵守目标域名白名单。新增代理目标时，更新 `wrangler.jsonc` 中的 `PROXY_ALLOWED_HOSTS` 后重新部署 Worker。

## 3. 前端本地定制

相对上游源码，项目保留三处前端改动：

1. `web/src/services/api/local-proxy.ts`：将代理连通性测试改为请求 `/__proxy_ping`，避免 SPA 根路径与健康检查冲突。
2. `web/src/components/layout/user-status-actions.tsx`：移除右上角 GitHub 图标。
3. `web/src/stores/use-config-store.ts`：调整 `withLocalProxy`，让未显式开启本地代理的请求默认走当前网站的同源代理。

项目新增的部署文件包括 `worker/index.js`、`wrangler.jsonc`、`update.sh`、`HANDOFF.md` 和 `PROJECT.md`。上游的 `AGENTS.md`、`README.md` 等文件应与本地定制文档区分；同步上游时避免无关修改这些文件。

## 4. 构建与部署

前端源码变更后，在 `web` 目录安装依赖并构建：

```bash
npm install --no-audit --no-fund --legacy-peer-deps
npm run build
```

构建产物写入 `web/dist/`。随后回到项目根目录部署 Worker：

```bash
npx wrangler deploy
```

部署凭据通过环境变量临时提供，不要写入仓库、文章或命令历史。只改 `worker/` 或 `wrangler.jsonc` 时，无需重新构建前端，可直接部署。

同步上游更新时运行：

```bash
bash update.sh
```

脚本依次执行上游 fetch、检查更新、将本地定制提交 rebase 到上游、构建和部署。`web/package-lock.json` 冲突时采用上游版本；其他冲突需要检查后手动解决。部署完成后，再执行健康检查。

本地维护提交使用 `local:` 前缀，例如：

```bash
git add -A
git commit -m "local: <变更内容>"
```

## 5. 部署后检查

```bash
BASE=https://canvas.air1.cn
curl -s "$BASE/__proxy_ping"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/"
curl -s "$BASE/https://api.github.com/zen"
curl -s "$BASE/https://generativelanguage.googleapis.com/v1beta/models"
```

检查重点：健康端点应返回 Worker 标识与版本；主页应返回 HTTP `200`；未列入代理白名单的目标应被拒绝；已允许的上游请求应能到达目标服务。具体状态码会受上游鉴权影响，判断时要区分 Worker 拒绝与上游服务的响应。

## 6. 浏览器中的渠道与画布数据

应用没有账号系统。渠道、API Key、自定义脚本和画布数据保存在当前浏览器的 Local Storage 与 IndexedDB 中。清理网站数据可能导致配置和画布丢失；换设备或浏览器时也不会自动同步，重要画布应定期导出备份。

当前图像模型通过 OpenAI 兼容的 Chat Completions 接口调用。模型脚本从 `choices[0].message.images[]` 读取图片，兼容 `image_url` 为字符串或对象的响应结构。该调用方式通常受服务商格式限制，分辨率可能封顶在 1K，`imageSize` 等参数也未必能透传。生成请求为同步操作，等待期间不要关闭页面；并发过高可能触发 HTTP `429`，遇到限流时降低并发后重试。

原生 Gemini 协议渠道尚未配置。该路线在服务端支持时可以传递更高分辨率等参数；接入前需确认代理路径、认证方式和模型能力，不应把真实 API Key 写入源码或 Git。

## 7. 安全与维护边界

- Cloudflare API Token 只在部署时经环境变量提供，并遵循最小权限原则。
- 中转站域名、账号标识和 API Key 等部署细节不放入公开仓库或博客；公开发布前检查配置、命令和日志中的凭据。
- `PROXY_ALLOWED_HOSTS` 必须保留有效限制，不能通过清空白名单来绕过代理故障。
- 前端改动必须重新构建后再部署，否则线上仍会使用旧的 `web/dist/`。
- 部署后核对健康端点、主页和代理边界，确认实际发布状态，而不是只依据部署命令的退出码。
