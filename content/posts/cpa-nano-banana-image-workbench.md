+++
author = "haenlau"
title = "CLIProxyAPI + GCP 试用金接入 Nano Banana 生图"
url = "/cpa-nano-banana-image-workbench/"
date = "2026-09-11T00:00:00+08:00"
description = "记录 CLIProxyAPI 免费账号调用 gpt-image-2 失败后，切换到 GCP Vertex AI Nano Banana 图像模型的排查与接入过程。"
tags = [
  "记录",
]
+++

> 一次完整的踩坑记录:CPA 挂着 Codex 免费号,模型列表里明明有 `gpt-image-2`,一调就报 `auth_not_found`。本文讲清楚为什么会这样,以及如何用 Google Cloud 的 $300 试用赠金,把工作台的生图后端切换到 Vertex AI 的 Gemini 图像模型(Nano Banana 系列),最后给出可直接抄的调用文档。

## 背景

我这套环境是这样的:

- **云主机**(Oracle 系列,Ubuntu):裸跑 CLIProxyAPI（社区俗称 CPA）,systemd 服务 `cliproxyapi.service`,配置在 `/opt/cliproxyapi/config.yaml`,监听 8317 端口,开了 TLS。

  项目地址：[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- **上游账号**:OAuth 登录了 ChatGPT **免费**账号,auth 文件都在 `~/.cli-proxy-api/` 下,清一色 `codex-xxx-free.json`;
- **前端**:一个部署在 Cloudflare Workers 上的"无限画布"生图工作台,配置(URL / API Key / 模型名)存在浏览器 localStorage 里。

目标很简单:让工作台能出图。

## 踩坑:模型列表里有 gpt-image-2,一调就 auth_not_found

调 `/v1/chat/completions` 传 `model=gpt-image-2`,拿到的是:

```json
{"error":{"message":"auth_not_found: no auth available (providers=codex, model=gpt-image-2)","type":"invalid_request_error"}}
```

但同一个号跑 `gpt-5.x` 文本模型完全正常。排查下来是三层原因叠在一起:

1. **`/v1/models` 是静态注册表**。CPA 把 `gpt-image-2` 写死挂在 codex 渠道下,列表返回的是"理论上支持",不校验你的账号实际权益。看到 ≠ 能用。
2. **Codex 出图是付费套餐权益**。通过 Codex 走 `gpt-image` 生成只对 ChatGPT Plus/Pro/Team 开放,免费号在鉴权层就被排除,CPA 在 codex 渠道下挑不出任何"能服务这个模型"的凭证,于是报 `auth_not_found`。相关讨论见 issue #3038（建议移除 free 账号的 gpt-image-2 权限）、社区"破案帖"结论一致。
3. **旧版 `/v1/images/generations` 被硬编码路由到 codex 路径**,不会回退到其他渠道（issue #3406）。所以就算你配了别的渠道,这个接口也可能只盯着 codex 找凭证。

另外一个坑提前说:即使换了 Plus 账号,老版本的 CPA 走图片接口还可能因为本地 `id_token` 时效问题选不上凭证（issue #3508）,表现为文本模型正常、唯独出图报 auth_not_found。所以真要走 codex 出图,先把 CPA 升到最新版。

## 方案选型

| 路线 | 成本 | 质量 | 结论 |
|---|---|---|---|
| Codex + Plus/Pro 账号 | $20/月起 | gpt-image 档 | 不想付月费,弃 |
| Antigravity / Gemini Web 免费号 | 0 | flash 档,免费号每天约 100 张 | 可行,但要折腾多号轮询 |
| **GCP 新用户试用赠金** | $300(90 天有效) | **Nano Banana Pro 顶配档可用** | 量大管饱,选这个 |

选 $300 的理由:不需要月费、按张计费、能上 `gemini-3-pro-image` 顶配档,个人工作台的量级下 $300 约等于几千张 Pro 图或上万张 flash 图。

## 第一步:验证 key 通道,用"空请求"免费探测模型

从 Model Garden / Cloud Console 拿到的**新版 Google API key 是 `AQ.` 开头的**,它是 **Vertex AI 通道**的凭证。验证时要注意:

- 打 `generativelanguage.googleapis.com`(AI Studio / Gemini API 通道)会被拒:`API_KEY_SERVICE_BLOCKED`;
- 打 `aiplatform.googleapis.com`(Vertex 通道)才通:

```bash
curl -s https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash-image:generateContent \
  -H "x-goog-api-key: $GOOGLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"test"}]}]}'
```

注意 `role` 字段必须带,Vertex 会校验,缺了报 `Please use a valid role: user, model`。

**省钱的模型探测技巧**:发一个空 contents,body 用 `{"contents":[]}`:

- 返回 400 `at least one contents field is required` → 模型存在且有权限(没花钱);
- 返回 404 → 模型 ID 不存在。

一把扫下来,我的 key 可用/不可用情况:

| 模型 ID | 状态 | 定位 |
|---|---|---|
| `gemini-3-pro-image` | ✅ | Nano Banana Pro,质量天花板,最高 4K |
| `gemini-3.1-flash-image` | ✅ | Nano Banana 2,日常主力,0.5K-4K |
| `gemini-3.1-flash-lite-image` | ✅(直连可用) | 最快最便宜,仅 1K |
| `gemini-2.5-flash-image` | ✅ | 上一代,保底 |
| `*-001` / `*-preview` 后缀变体 | ❌ 404 | 不用管 |

真实出图对比(同提示词):lite 8 秒、flash 15 秒、pro 32 秒;返回多为 1408×768 或 1024×1024。单价参考:flash 档约 $0.03-0.05/张,Pro 档 1-2K 约 $0.134/张、4K 约 $0.24/张。

顺带提醒:**Imagen 已经在 2026-08-17 停服**,模型列表里看到 `imagen-*` 不要再配了。

## 第二步:接入 CPA

1. 备份配置:

```bash
sudo cp /opt/cliproxyapi/config.yaml /opt/cliproxyapi/config.yaml.bak-$(date +%Y%m%d)
```

2. 在 `config.yaml` 末尾追加(顶层块,YAML 里顺序无所谓):

```yaml
vertex-api-key:
  - api-key: "AQ.xxxxxxxxxxxxxxxxxx"   # 你的 Vertex 通道 key
```

不带 `models` 过滤,CPA 会把这个 key 上的全部模型透出来(生图模型 + 一堆 Gemini 文本模型,白送)。想加别名就在条目里写 `models: [{name: ..., alias: ...}]`——注意**全局的 `oauth-model-alias` 对 API key 渠道不生效**,别放错地方。

3. 验证。CPA 支持 config.yaml **热重载**,不用重启:

```bash
curl -sk https://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer sk-你的本地key" | grep -o '"id":"[^"]*image[^"]*"'
```

能看到 `gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-2.5-flash-image` 即成功。如果没生效,`sudo systemctl restart cliproxyapi` 再查;动手前一定确认有备份。

## 第三步:调用文档(重要,全是实测的坑)

### ✅ 唯一推荐姿势:chat completions

```bash
curl -sk https://你的CPA地址:8317/v1/chat/completions \
  -H "Authorization: Bearer sk-你的key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.1-flash-image",
    "messages": [{"role": "user", "content": "一只戴墨镜的赛博朋克橘猫"}]
  }'
```

**最大的坑:图片不在 `content` 里。** 返回里 `message.content` 是 `null`,图片在 CPA 扩展的 `images` 字段:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "images": [{
        "type": "image_url",
        "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." }
      }]
    }
  }]
}
```

解析时取 `choices[0].message.images[0].image_url.url`,按 data URI 的 mimeType 解码(`flash-lite` 系返回 `image/jpeg`,其余 `image/png`,别写死 PNG)。

**图生图/编辑**:把参考图按标准视觉格式塞进 content 数组(文字 + `image_url` 的 data URI)再发一遍即可。

### ❌ `/v1/images/generations` 不可用

实测返回:

```json
{"error":{"message":"Model gemini-3.1-flash-image is not supported on /v1/images/generations or /v1/images/edits. Use gpt-image-1.5, gpt-image-2, grok-imagine-image, ...","type":"invalid_request_error"}}
```

CPA 把 images API 留给了 gpt-image/grok 系(而 gpt-image-2 对免费号又是幽灵条目)。**如果你的前端只支持 images API 格式,接不上,必须用支持 chat 格式的画布或自定义渠道。**

### 直连 Vertex(要完整控制参数时)

```bash
curl -s https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.1-flash-image:generateContent \
  -H "x-goog-api-key: $GOOGLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "contents":[{"role":"user","parts":[{"text":"提示词"}]}],
    "generationConfig":{"imageConfig":{"aspectRatio":"16:9","imageSize":"2K"}}
  }'
```

图片在 `candidates[0].content.parts[].inlineData.data`。**控制宽高比(`1:1`/`16:9`/`9:16` 等)和分辨率(`1K`/`2K`/`4K`)走这条最稳**;经 CPA 的 chat 路径这些参数能否透传我未验证,默认出 1K。

### 接入"无限画布"类工作台

设置面板填写 CPA 地址加 `/v1` 作为 Base URL、API Key 和模型 `gemini-3.1-flash-image`。接口格式选 **chat/completions**。注意这类应用的配置存在浏览器 localStorage 里,换浏览器要重填。

## 踩坑速查表

| 报错 | 原因 | 解法 |
|---|---|---|
| `auth_not_found (providers=codex, model=gpt-image-2)` | codex 免费号没有出图权益,模型列表是静态的 | 换 Gemini/Vertex 路线,或上付费套餐 |
| `API_KEY_SERVICE_BLOCKED` @ generativelanguage | `AQ.` 开头的 key 是 Vertex 通道 | 打 aiplatform 端点,CPA 用 `vertex-api-key` 渠道 |
| `Please use a valid role: user, model` | Vertex generateContent 必须带 role | contents 里加 `"role":"user"` |
| `Model ... not supported on /v1/images/generations` | CPA 把 images API 留给 gpt-image/grok 系 | 走 `/v1/chat/completions` |
| 图片"返回为空" | 图片在 `message.images`,不在 `content` | 按 data URI 解析 `images[0].image_url.url` |
| 列表里有模型但调用失败 | 静态注册表 ≠ 账号可用 | 空请求探测 + 看套餐权益 |

## 费用与安全清单

- **费用**:GCP 试用 $300,90 天有效,按张扣费;本次项目全部测试(探测 + 十来张样图)共花费约 $0.4。
- **密钥**:key 在聊天记录、截图、博客里出现过一次就该轮换;Cloud Console → APIs & Services → Credentials 删旧建新,CPA 配置改一行,热重载即生效。文章/截图里一律用占位符。
- **SSH**:云主机安全组限制源地址是好事;给自动化工具用就单独发一把专用公钥,用完可撤。
- **配置**:改 CPA 配置前先备份;热重载虽好,重启前先 `systemctl is-active` 确认服务状态。

## 总结

整个过程的核心认知就三条:

1. **模型列表是广告,不是承诺**——`/v1/models` 看得到不代表账号能调,鉴权层的"选不出可用凭证"(`auth_not_found`)基本就是权益问题;
2. **key 的通道决定端点**——`AIza` 走 Gemini API,`AQ.` 走 Vertex,通道打错会得到一堆误导性的 403;
3. **生图响应格式处处不一致**——CPA 把图放 `message.images`、直连 Vertex 放 `inlineData`、lite 档返回 JPEG,前端解析要按 mimeType 和字段位置做兼容,别写死。

愿意付 $20 月费的话,codex + Plus 出图当然更省事;但在"已有 $300 试用赠金"的前提下,Vertex + Nano Banana 是质量上限更高、单价更低的一条路。

## 参考

- [CLIProxyAPI #3038 建议移除 codex free 账号的 gpt-image-2 权限](https://github.com/router-for-me/CLIProxyAPI/issues/3038)
- [CLIProxyAPI #3406 /v1/images/generations 硬编码路由到 codex](https://github.com/router-for-me/CLIProxyAPI/issues/3406)
- [CLIProxyAPI #3508 图片鉴权依赖本地 id_token](https://github.com/router-for-me/CLIProxyAPI/issues/3508)
- [CPA 官方文档(含 vertex-api-key 配置示例)](https://help.router-for.me/)
- [Gemini 图像生成官方文档](https://ai.google.dev/gemini-api/docs/image-generation)
- [CPA 官方 NanoBanana 实战教程(免费号路线)](https://help.router-for.me/cn/hands-on/tutorial-3)
