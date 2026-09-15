+++
author = "haenlau"
title = "用 Resend 发送域名邮件"
url = "/resend-domain-email/"
date = "2026-09-15T09:10:37+00:00"
description = "记录使用 Resend 通过已验证域名发送邮件，并结合 Cloudflare Email Routing 和 Worker 完成收发链路。"
tags = [
  "记录",
]
+++

Resend 主要解决应用或脚本向外发送邮件的问题。它不提供传统意义上的完整邮箱服务，但可以使用已经验证的域名作为发件域名，通过 API 发送邮件。

如果域名的收信部分已经交给 Cloudflare Email Routing，那么可以组合成：

```text
发信：应用 / Worker → Resend → 域名邮箱
收信：域名邮箱 → Cloudflare Email Routing → Gmail
```

这样不需要自己维护 SMTP、IMAP、反垃圾邮件和邮件投递基础设施。

## 一、准备工作

需要准备：

- 一个自己的域名；
- 域名 DNS 托管在 Cloudflare；
- 一个 Resend 账号；
- 一个用于接收测试邮件的 Gmail 或其他邮箱。

本文统一使用以下示例数据：

```text
域名：example.com
发件地址：me@example.com
收件地址：your-email@gmail.com
```

以上地址均为示例，实际使用时替换为自己的信息。

## 二、在 Resend 添加域名

登录 Resend，进入域名管理页面，添加自己的域名：

```text
example.com
```

Resend 会根据当前配置生成 DNS 记录。需要按照 Resend 控制台显示的内容，在 Cloudflare DNS 中添加对应记录，不要自行猜测记录值。

配置完成后，返回 Resend 对域名进行验证。验证成功后，通常会看到类似状态：

```text
example.com
Verified
```

这表示 Resend 已经获得代表该域名发送邮件的权限。

## 三、创建 Resend API Key

进入 Resend 的 API Key 页面，创建一个新的 API Key。

示例：

```text
re_xxxxxxxxxxxxxxxxxxxxxxxxx
```

API Key 是程序调用 Resend API 的认证凭据，不要：

- 提交到 GitHub；
- 写死在前端 JavaScript；
- 发布到博客；
- 发给其他人；
- 写进公开配置文件。

如果程序运行在服务器或 Cloudflare Worker 上，应使用环境变量或 Secret 保存：

```text
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
```

文章、代码仓库和日志中只保留占位符。

## 四、使用 curl 测试发送邮件

域名验证和 API Key 创建完成后，可以先不写程序，直接使用 `curl` 测试 Resend API：

```bash
curl -X POST 'https://api.resend.com/emails' \
  -H 'Authorization: Bearer YOUR_RESEND_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "me@example.com",
    "to": ["your-email@gmail.com"],
    "subject": "Resend 测试",
    "html": "<h1>Hello</h1><p>这是通过 Resend 发送的测试邮件。</p>"
  }'
```

需要替换：

```text
YOUR_RESEND_API_KEY
```

同时把发件地址替换成已经通过 Resend 验证的域名下的地址，例如：

```text
me@example.com
hello@example.com
noreply@example.com
```

具体可用的发件地址，以 Resend 当前域名验证状态和发送策略为准。

## 五、容易踩坑：Shell 多行命令换行

如果把 `curl` 写成多行，反斜杠 `\` 必须是这一行的最后一个字符。

正确写法：

```bash
curl -X POST 'https://api.resend.com/emails' \
  -H 'Authorization: Bearer YOUR_RESEND_API_KEY' \
  -H 'Content-Type: application/json'
```

错误写法：

```bash
curl -X POST 'https://api.resend.com/emails' \ 
```

第二种写法中，反斜杠后面存在空格。Bash 不会把下一行继续拼接起来，可能出现：

```text
Missing API Key
-H: command not found
-d: command not found
```

遇到这种错误时，先检查反斜杠后面是否存在空格或其他不可见字符。

## 六、判断发送是否成功

如果 API 调用成功，Resend 会返回一个邮件 ID：

```json
{
  "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

这表示 Resend 已经接受了邮件发送请求。之后还需要检查目标邮箱是否实际收到邮件。

如果没有收到，可以检查：

- Resend 控制台中的邮件日志；
- DNS 配置；
- SPF；
- DKIM；
- DMARC；
- 目标邮箱的垃圾邮件文件夹。

“API 返回邮件 ID”只代表发送请求被接受，不等于邮件已经进入收件箱。

## 七、配置 Cloudflare Email Routing 接收邮件

Resend 解决的是发信。如果还希望：

```text
me@example.com
```

能够接收邮件，可以使用 Cloudflare Email Routing。

在 Cloudflare 中开启 Email Routing，并添加地址：

```text
me@example.com
```

再指定最终目标邮箱：

```text
your-email@gmail.com
```

收信链路如下：

```text
别人发送邮件
      │
      ▼
me@example.com
      │
      ▼
Cloudflare Email Routing
      │
      ▼
your-email@gmail.com
```

这样 Gmail 就成为实际的个人收件箱。

## 八、使用 Cloudflare Worker 处理邮件

如果只是简单转发邮件，Cloudflare Email Routing 本身就可以完成。如果希望对邮件进行进一步处理，例如：

- 根据主题分类；
- 保存邮件内容；
- 调用其他 API；
- 发送通知；
- 过滤特定邮件；
- 自定义邮件处理逻辑。

可以加入 Cloudflare Worker：

```text
me@example.com
      │
      ▼
Cloudflare Email Routing
      │
      ▼
Cloudflare Worker
      │
      ├── 处理
      ├── 过滤
      └── 转发
              │
              ▼
            Gmail
```

Worker 不是 Resend 发信所必需的组件，只有在需要自定义收信逻辑时才需要加入。

## 九、最终邮件架构

完成发信和收信配置后，可以得到一套轻量的个人域名邮件链路：

```text
                         example.com
                              │
                ┌─────────────┴─────────────┐
                │                           │
              Outbound                    Inbound
                │                           │
              Resend                Cloudflare Email
                                         Routing
                │                           │
                │                       Worker
                │                           │
                ▼                           ▼
        me@example.com  ──────────────→  Gmail
```

各组件职责如下。

### Resend

负责发送邮件，通过 API 调用：

```text
POST https://api.resend.com/emails
```

### Cloudflare Email Routing

负责接收发往域名邮箱的邮件，并转发到最终收件地址。

### Cloudflare Worker

负责自定义邮件处理，例如过滤、分类、保存和发送通知。

### Gmail

作为最终收件箱。

## 十、是否需要自己写邮件程序

测试阶段不需要写程序：

```text
curl
  ↓
Resend API
  ↓
目标邮箱
```

这样就可以完成最小化的发信验证。

只有当网站或应用需要自动发送邮件时，才需要在后端或 Cloudflare Worker 中调用 Resend API。

例如网站表单：

```text
用户提交网站表单
        │
        ▼
Cloudflare Worker
        │
        ▼
Resend API
        │
        ▼
me@example.com
```

## 十一、网站联系表单场景

如果给个人网站增加“联系我”功能，可以采用以下结构：

```text
访客
 │
 │ 提交留言
 ▼
网站前端
 │
 ▼
Cloudflare Worker
 │
 │ RESEND_API_KEY
 ▼
Resend
 │
 ▼
me@example.com
 │
 ▼
Cloudflare Email Routing
 │
 ▼
Gmail
```

整个邮件发送过程不需要把 Resend API Key 暴露给浏览器。

错误做法：

```text
浏览器
   │
   └── Resend API
        ↑
    API Key 暴露
```

正确做法：

```text
浏览器
   │
   ▼
Cloudflare Worker
   │
   │ API Key 保存在 Secret
   ▼
Resend
```

浏览器只负责提交表单，Worker 负责使用 Secret 调用 Resend。

## 十二、注意事项

### 1. API Key 不要泄露

如果 API Key 意外出现在以下位置：

- GitHub；
- 日志；
- 截图；
- 聊天记录；
- 博客文章。

应该立即撤销旧 Key，并重新创建新的 API Key。

### 2. 发件地址必须使用已验证域名

例如验证的是：

```text
example.com
```

那么通常可以使用：

```text
me@example.com
hello@example.com
noreply@example.com
```

具体规则以 Resend 当前控制台和发送策略为准。

### 3. 收信和发信是两个独立的问题

不要把 Resend 理解成传统邮箱服务。它主要解决：

```text
应用 → 邮件
```

Cloudflare Email Routing 解决的是：

```text
邮件 → 你的邮箱
```

因此两者可以组合使用：Resend 负责发信，Cloudflare Email Routing 负责收信，Worker 负责需要定制的邮件处理逻辑。

## 十三、最小验证流程

只想把发信流程跑通时，只需要：

```text
① 域名
    ↓
② Resend 添加并验证域名
    ↓
③ 创建 API Key
    ↓
④ curl 调用 Resend API
    ↓
⑤ 收到测试邮件
```

如果还需要接收邮件，再继续配置：

```text
⑥ Cloudflare 开启 Email Routing
    ↓
⑦ me@example.com → Gmail
    ↓
⑧ 使用外部邮箱发送邮件到 me@example.com
```

这套方案把发信、收信和邮件处理拆成了相互独立的组件，出问题时也更容易定位。
