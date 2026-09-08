+++
author = "haenlau"
title = "Cloudflare 邮件转 Telegram 通知"
url = "/cloudflare-email-telegram/"
date = "2026-09-08T10:27:28+00:00"
description = "记录使用 Cloudflare Email Worker 将域名邮箱的新邮件摘要推送到 Telegram，同时继续转发完整邮件的方法。"
tags = [
  "记录",
]
+++

Cloudflare Email Routing 可以把域名邮箱转发到真实邮箱，但如果只依赖邮箱客户端通知，容易错过新邮件。更直接的做法，是让 Cloudflare Email Worker 在收到邮件后，同时向 Telegram 发送摘要，并把完整邮件转发到目标邮箱。

## 工作流程

```text
域名邮箱
  ↓
Cloudflare Email Worker
  ├── Telegram：发送发件人、收件人和主题
  └── 真实邮箱：转发完整邮件
```

Telegram 只负责即时提醒，完整邮件仍然保存到真实邮箱。这样可以避免把验证码、账单、附件和私人正文直接发送到 Telegram。

## 最终 Worker 代码

邮件主题经常使用 MIME Header 编码，中文主题可能表现为下面这样的形式：

```text
=?GBK?B?suLK1NbQzsQ=?=
=?UTF-8?B?...==?=
```

下面的代码会先解码 `B`（Base64）和 `Q`（Quoted-Printable）编码，再使用 Telegram `HTML` 模式发送通知。相比 `MarkdownV2`，HTML 对中文标点和特殊字符更容易处理。

```js
export default {
  async email(message, env, ctx) {
    const from = message.from || "未知发件人";
    const to = message.to || "未知收件人";
    const rawSubject = message.headers.get("subject") || "(无标题)";

    // 解码 MIME Header，例如 =?GBK?B?...?= 或 =?UTF-8?B?...?=
    const subject = decodeMimeHeader(rawSubject);

    // HTML 转义，防止主题中的特殊字符破坏 Telegram 消息格式
    const escapeHtml = (text) => {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    };

    const text =
      `<b>📬 收到新邮件通知</b>\n\n` +
      `<b>👤 发件人:</b> <code>${escapeHtml(from)}</code>\n` +
      `<b>🎯 收件人:</b> <code>${escapeHtml(to)}</code>\n` +
      `<b>📌 主题:</b> ${escapeHtml(subject)}`;

    const tgUrl =
      `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`;

    try {
      await fetch(tgUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: env.TG_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      // Telegram 失败不应阻断原邮件转发
      console.error("Telegram 推送失败:", err);
    }

    // 转发完整邮件到已验证的目标邮箱
    await message.forward(env.FORWARD_TO);
  },
};

/**
 * 解码 MIME Header，支持 GBK / GB2312 / UTF-8 等字符集，
 * 以及 Base64（B）和 Quoted-Printable（Q）两种编码。
 */
function decodeMimeHeader(header) {
  if (!header || !header.includes("=?")) {
    return header;
  }

  return header.replace(
    /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g,
    (_, charset, encoding, encodedText) => {
      try {
        const type = encoding.toUpperCase();
        let bytes;

        if (type === "B") {
          const binary = atob(encodedText);
          bytes = new Uint8Array(binary.length);

          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
        } else if (type === "Q") {
          const qText = encodedText.replace(/_/g, " ");
          const binary = qText.replace(
            /=([0-9A-Fa-f]{2})/g,
            (_match, hex) => String.fromCharCode(parseInt(hex, 16)),
          );
          bytes = new Uint8Array(binary.length);

          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
        } else {
          return encodedText;
        }

        const decoder = new TextDecoder(charset.toLowerCase());
        return decoder.decode(bytes);
      } catch (error) {
        console.error("MIME Header 解码失败:", error);
        return encodedText;
      }
    },
  );
}
```

## Cloudflare Worker 配置

代码使用 3 个绑定：

| 名称 | 类型 | 用途 |
| --- | --- | --- |
| `TG_BOT_TOKEN` | Secret | Telegram Bot Token |
| `TG_CHAT_ID` | Variable 或 Secret | 接收通知的 Chat ID |
| `FORWARD_TO` | Variable | 已验证的真实收件邮箱 |

`TG_BOT_TOKEN` 不要写进源码或公开仓库。建议在 Cloudflare 控制台的 Worker Settings 中使用 Secret 配置。

## 配置 Email Routing

在 Cloudflare Email Routing 中，把域名邮箱的规则指向这个 Worker：

```text
域名邮箱 → Email Worker
```

完整邮件由 Worker 中的这一行负责转发：

```js
await message.forward(env.FORWARD_TO);
```

目标邮箱必须是 Cloudflare Email Routing 中已经验证的地址。

不要同时保留一条绕过 Worker 的直接转发规则，否则可能出现邮件已经到达真实邮箱，但 Telegram 没有通知的情况。

## 为什么使用 HTML 模式

Telegram 的 `MarkdownV2` 需要转义很多字符：

```text
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

中文主题中经常混合中文标点、英文括号、URL 和特殊字符，MarkdownV2 很容易因为漏转义而出现解析错误。

代码使用：

```js
parse_mode: "HTML"
```

并通过 `escapeHtml()` 处理：

```text
&  →  &amp;
<  →  &lt;
>  →  &gt;
"  →  &quot;
'  →  &#39;
```

这样可以降低中文主题出现乱码或格式错误的概率。

## 为什么要解码 MIME Header

邮件主题不是简单的 UTF-8 文本。邮件客户端和服务器为了兼容不同字符集，会把非 ASCII 字符编码成 MIME Header，例如：

```text
=?GBK?B?suLK1NbQzsQ=?=
```

其中：

- `GBK` 是字符集；
- `B` 表示 Base64；
- `Q` 表示 Quoted-Printable。

如果不解码，Telegram 里看到的可能就是一串编码文本，而不是正常中文主题。`decodeMimeHeader()` 会识别这些片段，并使用 `TextDecoder` 按对应字符集还原文本。

## 测试步骤

1. 从外部邮箱发送一封测试邮件；
2. 主题使用中文和特殊符号，例如：
   ```text
   测试：中文（括号）[英文] <符号> & 特殊字符
   ```
3. 确认 Telegram 收到发件人、收件人和解码后的主题；
4. 确认真实邮箱收到完整邮件；
5. 检查 Worker Logs；
6. 临时测试错误 Telegram Token 时，确认邮件仍然可以正常转发。

## 常见问题

### Telegram 收不到，但邮箱能收到

检查：

- `TG_BOT_TOKEN` 是否正确；
- `TG_CHAT_ID` 是否正确；
- 是否已经向 Bot 发送过消息；
- Bot 是否被拉黑；
- Worker 日志中 Telegram API 的返回状态。

### 中文主题仍然显示异常

检查邮件原始主题是否使用了不常见字符集。如果 `TextDecoder` 不支持邮件声明的字符集，函数会返回编码片段本身。常见的 `UTF-8`、`GBK` 和 `GB2312` 通常可以正常处理。

### Telegram 失败会不会导致邮件丢失

代码先单独捕获 Telegram 请求异常，然后继续执行：

```js
await message.forward(env.FORWARD_TO);
```

因此 Telegram 推送失败时，邮件仍然会继续转发。实际部署时仍应检查 Worker 日志和目标邮箱的收件情况。

### 收到重复邮件

检查 Email Routing 中是否同时配置了：

- 直接转发到真实邮箱的规则；
- 发送到 Worker 的规则。

推荐只保留 Worker 路径，由 Worker 统一完成 Telegram 通知和邮件转发。

## 安全注意事项

- `TG_BOT_TOKEN` 只存储为 Cloudflare Secret；
- 不要把完整邮件正文发送到 Telegram；
- 不要在日志中打印邮件正文、验证码或附件内容；
- 目标邮箱使用 Cloudflare 已验证地址；
- 测试时使用专门的测试邮件，不要发送真实密码或验证码；
- 如果这个域名邮箱用于登录、支付或找回密码，建议单独规划通知策略。
