+++
author = "haenlau"
title = "无限画布部署与 Nano Banana 接入"
url = "/infinite-canvas-nano-banana/"
date = "2026-09-14T00:12:48+00:00"
description = "记录开源无限画布部署到 Cloudflare Workers，以及通过 CPA 反代接入 Nano Banana 图像模型。"
tags = [
  "记录",
]
+++

无限画布项目采用纯前端架构，部署到 Cloudflare Workers 后，可以同时提供静态页面和 CORS 代理。本文记录部署结构、上游同步方式，以及接入 Nano Banana 图像模型时遇到的两种调用路径。

## 一、项目背景

项目基于开源项目 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) 二次开发。上游项目采用 React 19、Vite 7、Zustand 和 LocalForage，属于纯前端 SPA，没有独立后端服务。API Key 和画布数据都保存在浏览器本地，因此可以使用静态文件托管，再配合一个 CORS 代理完成部署。

## 二、Cloudflare Worker 部署

### 架构

```text
Worker: infinite-canvas
├── 静态资源：web/dist 构建产物
├── /https://... 或 /proxy/https://... → CORS 转发代理
└── /__proxy_ping → 应用内置的代理连通性测试
```

同一个 Worker 同时承担静态资源托管和代理功能，不需要额外部署服务器。

### 入口地址

- 主入口：[https://canvas.air1.cn](https://canvas.air1.cn)

### 本地目录

```text
本地工作区中的 `infinite-canvas/`
├── web\                      # 前端源码
│   └── dist\                 # 构建产物
├── worker\index.js           # 静态托管与 CORS 代理
├── wrangler.jsonc            # Worker 部署配置
└── update.sh                 # 同步上游、构建并部署
```

### 对上游源码的改动

目前只保留两处本地修改：

1. `web/src/services/api/local-proxy.ts`

   将代理连通性测试从 `/` 改为 `/__proxy_ping`，避免根路径被 SPA 页面占用。

2. `web/src/components/layout/user-status-actions.tsx`

   移除右上角 GitHub 图标链接。

### 常用命令

```bash
cd "/d/ZCode Workspace/infinite-canvas/web"
npm install --no-audit --no-fund --legacy-peer-deps
npm run build

cd ..
npx wrangler deploy
```

部署前需要先执行 `wrangler login`，或者配置 `CLOUDFLARE_API_TOKEN`。

一键同步上游、重新构建并部署：

```bash
bash update.sh
```

### 与上游同步

Git 历史结构是在上游真实提交之上保留两个本地提交，提交信息以 `local:` 开头。同步时只需要重放这几处本地修改：

```bash
bash update.sh
```

脚本会依次执行：

```text
fetch → 检测新提交 → rebase → build → deploy
```

如果发生冲突：

- `package-lock.json` 自动采用上游版本；
- 其他冲突需要手动解决；
- 解决后执行 `git rebase --continue`；
- 再次运行 `update.sh` 完成构建和部署。

上游仓库可以通过 GitHub 的 Watch → Custom → Releases 订阅新版本提醒。

项目中的自定义模型调用脚本是动态读取模型名的通用实现。上游新增 Gemini 系列模型后，可以继续挂载同一份脚本。

## 三、应用配置

### 渠道

一个渠道由以下几部分组成：

- 接口地址；
- API Key；
- 协议类型，例如 OpenAI 或 Gemini；
- 模型列表。

API Key 只保存在当前浏览器的 Local Storage 中。换浏览器、清理网站数据或更换设备后，配置不会自动迁移，其他用户打开网站也无法使用当前浏览器里的 Key。

### 本地代理

在应用中填写 Worker 地址，例如：

```text
https://canvas.air1.cn
```

开启本地代理后，浏览器请求会经 Worker 转发，并由 Worker 补充 CORS 响应头。对于浏览器直连受到 CORS 限制的渠道，应开启这个选项。

### 数据存储

画布和生成图片保存在浏览器 IndexedDB 中，默认只存在本地，不会跨设备同步。重要画布需要及时导出备份。

## 四、Nano Banana 图像模型接入

当前使用的模型 ID 包括：

```text
gemini-3.1-flash-image
gemini-3-pro-image
```

前者适合日常生成，后者定位更高，具体价格和可用能力以实际服务商页面为准。

### 调用方式对比

| 调用方式 | 状态 | 说明 |
| --- | --- | --- |
| `/v1/chat/completions` + `message.images[]` | 可用 | 通过自定义模型脚本适配中转站返回格式 |
| `/v1/images/generations` | 不可用 | 当前中转站不通过此路径处理 Gemini 图像模型 |
| 原生 `:generateContent` + `x-goog-api-key` | 应用原生支持，待配 Key | 完成配置后可通过 Gemini 原生协议解锁 2K / 4K |

### 方案一：通过 Chat Completions 生图

渠道协议选择 OpenAI，接口地址使用实际可用的 OpenAI 兼容中转地址，模型挂载同一份通用脚本。出于安全原因，实际 API Key 不写入文章、仓库或脚本。

```js
/**
 * Generate images through chat/completions.
 * The upstream service returns images in message.images[].
 */
async function generateImage({ prompt, images, params: { count = 1 } = {}, model, http }) {
  const content = [{ type: "text", text: prompt }];

  for (const img of images || []) {
    content.push({
      type: "image_url",
      image_url: { url: img },
    });
  }

  const callOnce = () => http.post("/chat/completions", {
    model,
    messages: [{ role: "user", content }],
  });

  const replies = await Promise.all(
    Array.from({ length: Math.max(1, count) }, callOnce),
  );

  const urls = [];
  for (const data of replies) {
    const message = data?.choices?.[0]?.message || {};
    const list = Array.isArray(message.images) ? message.images : [];

    for (const item of list) {
      const url = typeof item?.image_url === "string"
        ? item.image_url
        : item?.image_url?.url;
      if (url) urls.push(url);
    }
  }

  if (!urls.length) {
    const text = replies[0]?.choices?.[0]?.message?.content;
    throw new Error(
      typeof text === "string" && text
        ? text
        : "接口没有返回图片",
    );
  }

  return urls;
}

return await generateImage({ prompt, images, params, model, http });
```

脚本的处理逻辑如下：

1. 将文字提示词放入 `content`；
2. 将参考图片作为 `image_url` 放入同一个 `content` 数组；
3. 动态读取当前模型名；
4. 根据 `count` 并发发起请求；
5. 从 `choices[0].message.images[].image_url.url` 提取图片；
6. 如果接口没有返回图片，优先抛出接口返回的文本错误。

### Chat Completions 路径的限制

- 分辨率通常封顶在 1K；
- `imageSize` 和宽高比参数无法稳定透传；
- 普通模型生成通常需要等待一段时间；
- Pro 模型单张图可能需要 30 至 60 秒；
- 生成期间不要关闭页面；
- 并发请求过多可能触发 `429`，应降低并发后重试。

## 五、Google Vertex AI 与 CPA 反代

应用原生调用格式为：

```text
{BaseURL}/v1beta/models/{model}:generateContent
```

鉴权头为：

```text
x-goog-api-key: [REDACTED]
```

对于 Gemini 3 系列图像模型，原生路径可以传递 `imageSize` 和宽高比，因此适合需要 2K 或 4K 输出的场景。

Google Vertex AI 通过 CPA 提供反代服务，画布通过 CPA 反代调用 Google 的图像模型。应用侧不直接访问 Google 的原生接口，而是将渠道地址配置为 CPA 反代地址，再由反代处理认证和请求转发。

反代需要处理原生接口路径重写：

```text
/v1beta/models/(.+):(.*)
↓
/v1/publishers/google/models/$1:$2
```

画布中填写 CPA 反代地址，使用 CPA 提供的认证方式，并按反代服务支持的协议配置 Gemini 或 Vertex AI 渠道。真实 Key 不应写入前端源码、Git 仓库、文章或日志。

### 中转站兼容性

画布调用 CPA 反代时，如果原生 `/v1beta/*` 请求被转换为 `Invalid API key`，需要检查 CPA 的路径重写和认证配置，而不是在前端继续修改模型脚本。

## 六、安全注意事项

文档和调试过程中曾使用过多类凭证，包括：

- OpenAI 兼容中转站的 Key；
- Google Cloud 或 Gemini API Key；
- Cloudflare API Token。

这些凭证一旦在聊天记录、截图、命令行历史或仓库中暴露，都应立即轮换。Cloudflare Token 在任务完成后可以删除，不要长期保留高权限 Token。

推荐做法：

- 前端只保存必要的 Key；
- 不把 Key 写入代码、Git 或公开笔记；
- 通过环境变量或本地未提交配置文件提供部署凭证；
- 为 Cloudflare Token 设置最小权限和明确的资源范围；
- 重要画布定期导出备份。

## 七、可选升级

- [ ] 轮换已经暴露过的凭证；
- [ ] 走通原生 Gemini 路径，解锁 2K / 4K；
- [ ] 将本地仓库推送到自己的 GitHub 私有仓库做异地备份；
- [ ] 使用 GitHub Actions 定时同步上游并自动部署；
- [ ] 使用 WebDAV 同步应用配置，方便多设备使用。
