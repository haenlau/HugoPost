+++
title = "DNSHE 域名自动续期平台"
date = "2026-03-22"
lastmod = "2026-03-22"
description = "记录 DNSHE 免费域名自动续期管理平台的设计思路、Cloudflare Workers 部署方式、核心模块与常见踩坑。"
url = "/dnshe-manager/"
aliases = ["/posts/dnshe-manager/"]
categories = ["笔记"]
draft = false
+++

## 1. 项目定位

`DNSHE-Manager` 是一个跑在 Cloudflare Workers 上的域名自动续期管理平台，目标很明确：

- 自动检查 DNSHE 域名的到期时间
- 在可续期窗口内自动续期
- 提供一个能手动查看和操作的 Web 管理界面
- 用 Telegram 发送续期通知和周期汇总

这个项目的重点不在“做一个复杂的域名面板”，而在于把 DNSHE 免费子域名的日常维护自动化，减少忘记续期带来的中断风险。

---

## 2. 背景与约束

DNSHE 提供免费域名注册和 DNS 托管服务。根据原始笔记里的说明，从 `2026-01-01` 起，新注册域名采用年度注册机制，需要在到期前 `180` 天内手动续期，但续期本身仍然免费。

这带来一个很典型的问题：

- 域名不是付费到期自动扣款
- 也不是永久生效无需处理
- 而是“免费，但需要在窗口期内主动续”

所以系统的职责就变成了：

| 任务 | 目标 |
|------|------|
| 每日巡检 | 查出哪些域名进入续期窗口 |
| 自动续期 | 对符合条件的域名直接发起续期 |
| 结果通知 | 成功、跳过、失败都留痕 |
| 人工介入 | 提供后台手动刷新、检查、续期 |

---

## 3. 功能清单

按原始方案，这个平台包含下面几类能力：

| 功能 | 说明 |
|------|------|
| 多账户管理 | 支持多个 DNSHE 账户并行管理 |
| 自动续期检查 | 定时任务每日执行巡检 |
| 窗口控制 | 只在到期前 `180` 天内触发续期 |
| 永久域名跳过 | `never_expires = 1` 的域名不处理 |
| Telegram 通知 | 推送续期结果和汇总信息 |
| 管理后台 | 提供可视化 Dashboard |
| 手动操作 | 支持刷新、检查、续期 |
| Basic Auth | 后台访问密码保护 |

一句话理解：**它不是面向访客的网站，而是一个给维护者自己用的运维工具。**

---

## 4. 技术选型

这个项目的栈其实很克制：

| 组件 | 技术 |
|------|------|
| 运行时 | Cloudflare Workers |
| 存储 | Workers KV |
| 调度 | Cron Triggers |
| 通知 | Telegram Bot API |
| 界面 | 原生 HTML / CSS |

这个组合有几个优点：

- 不需要传统服务器
- 没有数据库运维负担
- 适合轻量自动任务
- Workers + Cron 天然适合“每天跑一下”的工作

从工程取舍看，这类项目没必要为了后台界面引入完整前端框架。能用纯 HTML / CSS 把管理界面做出来，兼容性和维护成本都会更稳。

---

## 5. 整体架构

整套系统可以分成五层：

```text
Cron Trigger
  -> Router / API
  -> Account Manager
  -> DNSHE API Client
  -> KV / Telegram / Dashboard
```

更具体一点：

| 层 | 职责 |
|------|------|
| Cron | 每天固定时间触发检查任务 |
| Router | 暴露 `/api/*` 与后台页面入口 |
| Account Manager | 统一遍历多个账户并隔离错误 |
| DNSHE Client | 封装 DNSHE API 请求、鉴权、重试 |
| 周边能力 | KV 存缓存，Telegram 发通知，Dashboard 提供人工入口 |

这种架构的好处是边界清楚：

- HTTP 路由不直接写业务逻辑
- 多账户处理不和 API 封装混在一起
- 通知、存储、调度都是独立模块

后面要加第三个账户、换通知渠道、加新的 API 操作，都会容易很多。

---

## 6. DNSHE API 设计要点

### 6.1 基本信息

原始笔记里给出的 API 信息如下：

| 项目 | 值 |
|------|------|
| API 端点 | `https://api005.dnshe.com/index.php?m=domain_hub` |
| 鉴权 | `X-API-Key` + `X-API-Secret` |
| 限频 | `30` 次/分钟/账户 |
| 返回格式 | JSON |

### 6.2 常用接口

| Endpoint | Action | 方法 | 用途 |
|------|------|------|------|
| `subdomains` | `list` | `GET` | 获取域名列表 |
| `subdomains` | `renew` | `POST` | 续期域名 |
| `subdomains` | `register` | `POST` | 注册域名 |
| `dns_records` | `list` | `GET` | 查询 DNS 记录 |
| `dns_records` | `create` | `POST` | 添加 DNS 记录 |
| `dns_records` | `update` | `POST` | 修改 DNS 记录 |
| `dns_records` | `delete` | `POST` | 删除 DNS 记录 |
| `quota` | `list` | `GET` | 查询配额 |

### 6.3 请求示例

```bash
curl -X GET "https://api005.dnshe.com/index.php?m=domain_hub&endpoint=subdomains&action=list&fields=id,subdomain,rootdomain,full_domain,status,expires_at,never_expires" \
  -H "X-API-Key: cfsd_xxx" \
  -H "X-API-Secret: xxx"
```

```bash
curl -X POST "https://api005.dnshe.com/index.php?m=domain_hub&endpoint=subdomains&action=renew" \
  -H "X-API-Key: cfsd_xxx" \
  -H "X-API-Secret: xxx" \
  -H "Content-Type: application/json" \
  -d '{"subdomain_id": 12345}'
```

### 6.4 续期结果处理

续期逻辑里最重要的是不要把所有失败都当成同一种失败。

| 返回情况 | 解释 | 处理方式 |
|------|------|------|
| 成功 | 已完成续期 | 记录成功、发送通知 |
| `renewal_not_yet_available` | 还没到窗口期 | 跳过，不算异常 |
| `renewal window expired` | 已错过窗口 | 重点告警 |
| `insufficient balance` | 余额不足 | 告警 |
| `subdomain_not_found` | 域名不存在 | 告警 |

系统必须能区分“正常跳过”和“真正失败”，否则通知会变得没有意义。

---

## 7. 核心源码结构

根据原始笔记，项目目录大致是这样：

```text
dnshe-manager/
├── src/
│   ├── index.js
│   ├── dnshe-client.js
│   ├── account-manager.js
│   ├── scheduler.js
│   ├── telegram.js
│   ├── dashboard.js
│   └── storage.js
├── wrangler.toml
├── package.json
└── README.md
```

各模块职责可以概括成：

| 文件 | 作用 |
|------|------|
| `index.js` | Worker 入口、HTTP 路由、Basic Auth |
| `dnshe-client.js` | DNSHE API 封装 |
| `account-manager.js` | 多账户聚合与错误隔离 |
| `scheduler.js` | 定时检查、续期、通知主流程 |
| `telegram.js` | Telegram 消息发送与格式化 |
| `dashboard.js` | 后台页面 HTML |
| `storage.js` | KV 读写封装 |

这是很典型的“小项目但分层清楚”的结构，适合长期维护。

---

## 8. 核心实现思路

### 8.1 DNSHE Client

`DnsheClient` 的核心职责有三件事：

1. 拼接 endpoint / action
2. 统一附带 `X-API-Key` 与 `X-API-Secret`
3. 对 `429` 做重试和退避

这一层不应该掺业务判断。它只负责“把请求发出去并拿回结果”。

例如：

```javascript
async renewDomain(subdomainId) {
  return this.request("subdomains", "renew", "POST", {
    subdomain_id: subdomainId,
  });
}
```

### 8.2 Account Manager

多账户管理器负责两件大事：

- 从环境变量读取多个账户凭据
- 遍历账户并独立 try/catch，避免一个账户异常拖垮全局

这点非常重要。对运维工具来说，“部分成功 + 部分失败可见”远比“一次失败全盘中止”更实用。

### 8.3 续期主流程

续期主流程的判断顺序应该是：

1. 先拉域名列表
2. 跳过 `never_expires`
3. 跳过没有 `expires_at` 的数据
4. 计算距离到期天数
5. 不在 `180` 天窗口内则跳过
6. 在窗口内才实际调用续期
7. 按结果分成成功、跳过、失败

这类流程非常适合写成明确的状态分类，而不是只留一堆日志文本。

### 8.4 KV 的作用

KV 更适合存下面这些轻量状态：

- 上次检查结果
- 续期历史摘要
- 域名缓存
- Dashboard 需要快速展示的汇总数据

不建议把它当复杂关系型数据仓库来用。这个项目的状态结构偏“结果缓存”，和 KV 的定位很匹配。

---

## 9. Worker 配置

一个最小可用的 `wrangler.toml` 可以长这样：

```toml
name = "dnshe-manager"
main = "src/index.js"
compatibility_date = "2025-04-01"
workers_dev = true

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"

[triggers]
crons = ["0 8 * * *"]
```

这里最关键的是三项：

| 配置 | 用途 |
|------|------|
| `main` | Worker 入口 |
| `kv_namespaces` | 绑定 KV |
| `crons` | 每天固定时间执行巡检 |

原始设计里使用的是每天 `08:00 UTC` 触发。

---

## 10. Secrets 设计

这个项目比较适合把所有敏感信息都放在 Workers Secrets 里，而不是写死在代码或配置文件中。

建议项包括：

| Secret | 用途 |
|------|------|
| `ACCOUNT_1_KEY` | DNSHE 账户 1 API Key |
| `ACCOUNT_1_SECRET` | DNSHE 账户 1 API Secret |
| `ACCOUNT_1_NAME` | 账户显示名 |
| `ACCOUNT_2_KEY` | DNSHE 账户 2 API Key |
| `ACCOUNT_2_SECRET` | DNSHE 账户 2 API Secret |
| `ACCOUNT_2_NAME` | 账户显示名 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram 聊天 ID |
| `ADMIN_PASSWORD` | 后台 Basic Auth 密码 |

这类项目的安全边界其实很简单：

- 不要硬编码密钥
- 不要把后台做成公开页面
- 不要让手动 API 没有认证

做到这三点，基本盘就稳了。

---

## 11. 部署流程

### 11.1 环境准备

本地需要：

- Node.js
- Wrangler CLI
- 已登录 Cloudflare

```bash
npm install -g wrangler
wrangler login
```

### 11.2 创建 KV Namespace

```bash
wrangler kv namespace create KV
```

把返回的 `id` 填回 `wrangler.toml`。

### 11.3 设置 Secrets

```bash
wrangler secret put ACCOUNT_1_KEY
wrangler secret put ACCOUNT_1_SECRET
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
wrangler secret put ADMIN_PASSWORD
```

### 11.4 部署

```bash
wrangler deploy
```

部署成功后，Workers 会返回一个默认地址，例如：

```text
https://dnshe-manager.<subdomain>.workers.dev
```

### 11.5 绑定自定义域名

更稳的做法是直接在 Cloudflare Dashboard 里绑定域名，而不是把路由硬写进 `wrangler.toml`。

操作路径：

1. 打开 Cloudflare Dashboard
2. 进入 Workers & Pages
3. 选择 `dnshe-manager`
4. 打开 `Settings -> Domains & Routes`
5. 添加自定义域名

这样 Cloudflare 会一起帮你处理 DNS 记录和 SSL 证书。

---

## 12. 验证方式

部署完成后，至少要验证四件事：

| 验证项 | 方法 |
|------|------|
| 健康检查 | 看基础状态接口是否正常 |
| 账户读取 | 拉域名列表是否成功 |
| 手动检查 | 触发一次手动续期检查 |
| 通知链路 | Telegram 是否收到结果 |

可以直接测 API：

```powershell
Invoke-RestMethod -Uri "https://your-domain/api/status"
```

```powershell
$cred = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("admin:<password>"))
Invoke-RestMethod -Uri "https://your-domain/api/domains" -Headers @{ Authorization = "Basic $cred" }
```

```powershell
Invoke-RestMethod -Uri "https://your-domain/api/check" -Method POST -Headers @{ Authorization = "Basic $cred" }
```

除此之外，还要实际打开 Dashboard，确认：

- 能正常登录
- 账户能展示
- 手动按钮可用
- 状态反馈清楚

---

## 13. 总结

`DNSHE-Manager` 这类项目的价值，不在于技术栈多复杂，而在于它把一个容易忘、但后果明显的维护动作自动化了。

我觉得它最值得借鉴的地方有三点：

1. 用 Workers + Cron 做轻量运维任务，非常合适。
2. 多账户、通知、后台、KV 这几层边界分得比较清楚。
3. 续期窗口、错误分类、权限边界这些“细小但关键”的规则都考虑到了。

如果以后还会继续维护 DNSHE 域名，这样的平台是很值得长期保留的。
