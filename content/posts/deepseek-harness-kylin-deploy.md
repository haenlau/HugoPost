+++
author = "haenlau"
title = "DeepSeek Harness 麒麟部署与改造"
url = "/deepseek-harness-kylin-deploy/"
date = "2026-10-16"
description = "记录 DeepSeek Harness 在麒麟系统上的部署、功能改造、本地模型接入与端到端验证。"
tags = [
  "记录",
]
+++

> 目标平台:Kylin Linux Advanced Server V10 (Halberd) / aarch64 / 鲲鹏 920
> 目标地址:`http://<HOST_IP>/?token=<REDACTED_TOKEN>`
> 当前部署版本:**dsh `0.2.1-rc.2`**(由 `0.2.0-rc.2` 升级而来,见 §11)
> 记录范围:安装、坑点排查与根因分析、dsh 功能改造(补丁)、本地模型接入、端到端验证、版本升级。

---

## 1. 结论速览

这台机器上做的不是「装完就能用」的常规部署,而是一次改造。

- 在 **`0.2.0-rc.2`** 上,「绑定 LAN IP / 固定令牌 / 设置面板可用」三件事都需要源码补丁(当时共 5 处);并且踩了一个极隐蔽的坑:**Node 的 `NO_PROXY` 不认 CIDR**,导致 dsh 访问同网段模型服务器时报 `503`。
- 升级到 **`0.2.1-rc.2`** 后,上游重构了安全模型,**补丁数从 5 处降到 2 处**:
  - ✅ 固定令牌(仍需补丁)
  - ✅ 客户端 loopback 判定(仍需补丁,文件已从 `client.js` 拆为 `client.browser.js`)
  - ❌ 绑定 LAN IP —— 新版**原生支持**绑定任意具体 IP,不再需要补丁
  - ❌ 设置持久化 —— 新版移除了 `persistence` 参数,不再需要补丁
  - ➖ 无条件设置文档存储 —— `isLoopback: true` 后条件自然满足,可选

下面按「安装 → 改造 → 修复 → 接入模型 → 验证 → 升级」的顺序,把每一步的现象、根因、定位、修复写清楚。

---

## 2. 背景与目标

| 项 | 值 |
|---|---|
| 操作系统 | Kylin Linux Advanced Server V10 (Halberd),aarch64 |
| 硬件 | 鲲鹏 920,64 核,509GB 内存,364GB 系统磁盘 + 10T 数据盘（均为 RAID 1）,**无 GPU** |
| 主机 IP | `<HOST_IP>` |
| 目标 1 | dsh Web 绑定 LAN IP(`<HOST_IP>`),而非 `127.0.0.1` |
| 目标 2 | 固定访问令牌 `<REDACTED_TOKEN>`,重启不变 |
| 目标 3 | 设置面板(App Settings)在该浏览器可用 |
| 目标 4 | 接入局域网 `<MODEL_SERVER_IP>:8080` 上的本地模型 |
| 目标 5 | systemd 托管,开机自启 |

**为什么要改造**:dsh 把「本机(loopback)」当作安全前提——监听地址、令牌签发、设置能力都由「是否 loopback」决定。要求 LAN 访问时,这些前提全部不成立,只能改源码。

---

## 3. 环境准备

### 3.1. Node.js —— 系统源版本过旧

麒麟系统源里的 Node.js 只有 `12.x`,而 dsh 要求:

```
engines.node = ^22.19.0 || >=24.0.0
```

直接用系统 Node 安装会因引擎不满足而失败,所以手动安装 Node `22.23.3`(aarch64):

```bash
tar -xJf node-v22.23.3-linux-arm64.tar.xz -C /opt
mv <NODE_PREFIX>-v22.23.3-linux-arm64 <NODE_PREFIX>

ln -sf <NODE_PREFIX>/bin/node     /usr/local/bin/node
ln -sf <NODE_PREFIX>/bin/npm      /usr/local/bin/npm
ln -sf <NODE_PREFIX>/bin/npx      /usr/local/bin/npx
ln -sf <NODE_PREFIX>/bin/corepack /usr/local/bin/corepack

cat > /etc/profile.d/node.sh <<'EOF'
export PATH=<NODE_PREFIX>/bin:$PATH
EOF

node -v   # v22.23.3
```

### 3.2. 出网问题(本文不展开)

该机器需出网才能下载 Node 与 npm 包,相关网络方案不在本文范围。仅需知道:后续 dsh 服务同样可能通过 `HTTP_PROXY/HTTPS_PROXY` 出网,而这会在 §7.2 引出一个大坑。

---

## 4. 安装 dsh

```bash
npm i -g @deepseek-ai/dsh          # 当时稳定版 0.2.0-rc.2
# 升级后:
npm i -g @deepseek-ai/dsh@0.2.1-rc.2
```

- 可执行文件:`<NODE_PREFIX>/bin/dsh` → 软链 `/usr/local/bin/dsh`
- 查看可用版本:`npm view @deepseek-ai/dsh dist-tags --json`
- 版本一览(升级时):

| tag | 版本 | 说明 |
|---|---|---|
| latest | `0.2.0-rc.2` | 当时稳定版(未变) |
| next | `0.2.1-rc.2` | 本次升级目标 |
| alpha | `0.2.1-alpha.5` | 最新 alpha |

---

## 5. 改造一:绑定 LAN IP

### 5.1. 现象

```bash
# 0.2.0-rc.2
dsh web --host <HOST_IP> --port 80
# 启动被 host 校验拒绝
```

### 5.2. 根因(0.2.0-rc.2)

`@deepseek-ai/dsh-host-webserver` 在 schema 层把允许的 host 限定为 loopback 集合(只允许 `127.0.0.1` / `0.0.0.0`),`<HOST_IP>` 不在其中。

### 5.3. 修复(0.2.0-rc.2 时的补丁,现已作废)

- 文件:`dsh-host-webserver/lib/index.js`(约 142 行),在 host 枚举中加入 `<HOST_IP>`。

### 5.4. 0.2.1-rc.2 的变化——不再需要补丁

新版 `dsh-host-webserver` 的 host 配置改为「只拒绝通配地址,接受任意具体 IPv4/IPv6」:

```js
host: z.transform(z.string(), (value) => {
  const parsed = parseIpLiteral(value);
  if (parsed === void 0) throw notLiteralError(value);
  if (isWildcardAddress(parsed)) throw new Error(
    `webserver: host ${JSON.stringify(value)} is an unspecified (wildcard) address, ...`);
  return value;
}).required(...)
```

因此 `dsh web --host <HOST_IP>` **开箱即用**,补丁 1 删除。

> 官方说明:绑定通配地址会把 RCE 暴露到网络,故拒绝;请绑定一个本机具体地址。

---

## 6. 改造二:固定访问令牌

### 6.1. 现象

- 浏览器不带 token → `401`;
- 服务重启后,原带 token 的链接失效(令牌每次随机)。

### 6.2. 根因

`@deepseek-ai/dsh-client-connection` 启动时调用 `processLaunchToken` 生成**随机** launch token,并打印 `dsh web: http://<host>/?token=<random>`。启动参数 `authenticatedUrl()` 会把该 token 拼到 URL 上;之后经校验换取持久 cookie。

### 6.3. 修复(补丁 A)—— 0.2.1 仍适用

- 文件:`@deepseek-ai/dsh-client-connection/lib/index.js`(0.2.1 中在 **297 行**)
- 改动:

```diff
 function processLaunchToken(owner) {
   const existing = PROCESS_LAUNCH_TOKENS.get(owner);
   if (existing !== void 0) return existing;
-  const created = encodeBase64Url(randomBytes(SECRET_BYTES));
+  const created = "<REDACTED_TOKEN>";
   PROCESS_LAUNCH_TOKENS.set(owner, created);
   return created;
 }
```

- 备份:`cp -n index.js index.js.bak`

### 6.4. 效果

访问地址固定为 `http://<HOST_IP>/?token=<REDACTED_TOKEN>`;首次带 token 访问返回 `303` 并下发 cookie,后续 cookie 有效期约 30 天。

---

## 7. 修复设置面板

### 7.1. 现象

LAN 打开页面后,设置面板报:

```
settings are unavailable in this browser
```

### 7.2. 根因

客户端有一处 loopback 判定,并把结果分发给设置模块;非 loopback 时设置文档存储(`SettingsDocumentStore`)被跳过。

- 0.2.0-rc.2:判定在 `dsh-client-connection/lib/client.js`,且另一处 `persistence` 会降级为 `"memory"`;
- 0.2.1-rc.2:浏览器端连接拆到 `dsh-client-connection/lib/client.browser.js`,且 `SettingsDescribeMirror` **不再接收 `persistence` 参数**(该坑消失)。

### 7.3. 修复(补丁 B)—— 0.2.1 版本

- 文件:`@deepseek-ai/dsh-client-connection/lib/client.browser.js`(0.2.1 中在 **1424 行**)
- 改动:

```diff
 const handle = {
   interactions,
   openWebSocket: ...,
-  isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),
+  isLoopback: true,
   generation: { ... },
```

- 备份:`cp -n client.browser.js client.browser.js.bak`

### 7.4. 补丁 C(可选,0.2.1 通常不必)

`dsh-client-ui-settings-general/lib/client.js` 里仍有:

```js
const documentController = ctx.remote.$host.isLoopback ? new SettingsDocumentStore(...) : void 0;
```

只要补丁 B 生效(`$host.isLoopback === true`)该条件即通过,所以补丁 C 非必需。若想双保险,可改为无条件创建。0.2.0-rc.2 时则必须打(那一版还需要同时改 `persistence`)。

### 7.5. 0.2.0-rc.2 时的旧补丁对照(已作废)

| 旧编号 | 文件:行 | 改动 | 0.2.1 状态 |
|---|---|---|---|
| 3 | `dsh-client-connection/lib/client.js:1404` | `isLoopback: true` | 文件迁移 → `client.browser.js:1424`(补丁 B) |
| 4 | `dsh-client-ui-settings/lib/client.js:1509` | `const persistence = "host";` | 上游移除该参数,作废 |
| 5 | `dsh-client-ui-settings-general/lib/client.js:992` | 无条件创建 store | 非必需(补丁 C) |

---

## 8. 修复 `/api` 访问与代理坑

### 8.1. 现象 A(0.2.0-rc.2):`/api/*` 返回 403

老版本 host 校验通过后,还有一层「可信来源」校验。解决方式是启动加:

```
--trusted-host <HOST_IP>
```

### 8.2. 现象 B(跨版本):`discoverModels` 报 503,但直连 200

接本地模型时:

```
http://<MODEL_SERVER_IP>:8080/v1/models answered 503
```

但在服务器上直接 curl 却是 `200`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --noproxy '*' http://<MODEL_SERVER_IP>:8080/v1/models
# 200
```

根因:服务以 `HTTP_PROXY/HTTPS_PROXY` 出网,`NO_PROXY` 最初写成 CIDR:

```
NO_PROXY=localhost,127.0.0.1,<LAN_CIDR>
```

**Node 的 `undici` `EnvHttpProxyAgent` 不识别 CIDR**(只做主机名后缀/精确匹配),`<MODEL_SERVER_IP>` 未被排除 → 请求被送进代理 → 同网段私网地址在代理侧不可达 → `503`。

修复:改成**显式 IP**:

```
NO_PROXY=localhost,127.0.0.1,<HOST_IP>,<MODEL_SERVER_IP>
```

改完 `discoverModels` 立即返回:

```json
{"ok":true,"value":[{"id":"qwen-local","name":"qwen-local"}]}
```

> 教训:凡 Node 服务,`NO_PROXY` 一律用显式主机/IP,不要用 CIDR。

### 8.3. 0.2.1-rc.2 的变化:`--trusted-host` 变成可选项

新版 `/api` 信任栅栏 `isTrustedApiRequest` 会接受三种 Host:**loopback**、**`trustedHosts`**、**本机 bind 地址本身**(`isBindAddressAuthority`)。因此当 `--host <HOST_IP>` 时,浏览器发送 `Host: <HOST_IP>` 已被自动信任,`--trusted-host` 不再必需(保留亦无害)。

---

## 9. 服务化与防火墙

`<SYSTEMD_UNIT_PATH>`:

```ini
[Unit]
Description=DeepSeek Harness Web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=<NODE_PREFIX>/bin:/usr/local/bin:/usr/bin:/bin
Environment=DSH_HOME=<DSH_HOME>
# 出网代理(仅在需要代理出网时设置;本文不展开具体方案)
Environment=HTTP_PROXY=http://127.0.0.1:<proxy-port>
Environment=HTTPS_PROXY=http://127.0.0.1:<proxy-port>
# 关键:必须用显式 IP,不能用 CIDR
Environment=NO_PROXY=localhost,127.0.0.1,<HOST_IP>,<MODEL_SERVER_IP>
# 本地模型凭据(见 §9.4)
Environment=LOCAL_QWEN_KEY=sk-no-key-required
ExecStart=<NODE_PREFIX>/bin/dsh web --host <HOST_IP> --port 80 --no-open --trusted-host <HOST_IP>
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

参数解释:

| 参数 | 作用 |
|---|---|
| `--host <HOST_IP>` | 绑定 LAN IP(0.2.1 原生支持;0.2.0 依赖补丁 1) |
| `--port 80` | HTTP 端口 |
| `--no-open` | 服务器上不尝试拉起浏览器 |
| `--trusted-host <HOST_IP>` | 0.2.0 修复 403 必需;0.2.1 起可选 |

启用:

```bash
systemctl daemon-reload
systemctl enable --now dsh-web
systemctl is-active dsh-web        # active
```

防火墙:

```bash
firewall-cmd --permanent --add-port=80/tcp
firewall-cmd --permanent --add-port=3080/tcp
firewall-cmd --reload
```

---

## 10. 接入本地模型(pi-ai)

### 10.1. 本地端点

先探测模型服务器(`/v1/models`)拿到真实信息:

```json
{"id":"qwen-local","object":"model","owned_by":"llamacpp",
 "meta":{"n_ctx":262144,"n_ctx_train":262144,"n_params":27320697856,
         "size":20207181824,"ftype":"Q5_K - Medium"}}
```

| 项 | 值 |
|---|---|
| 服务 | `http://<MODEL_SERVER_IP>:8080/v1`(llama.cpp) |
| 协议 | OpenAI 兼容 chat completions |
| 模型 id | `qwen-local` |
| 上下文 | 262144 |
| 量化 | Q5_K_M(约 20GB) |
| 鉴权 | `sk-no-key-required`(服务端不校验) |
| GGUF | `<MODEL_FILE>` |

用 `curl` 直接验证过:非流式返回 `200`,流式 SSE 正常(该模型会先输出 `reasoning_content` 增量)。

### 10.2. 确认适配器已挂载

dsh 里负责 OpenAI 兼容接入的是 `@deepseek-ai/dsh-llm-pi-ai`,随 `web` profile 挂载(默认「已挂载但未配置」):

```bash
dsh --profile web --dump-config | grep -A2 -i "pi-ai"
# - id: llm-pi-ai
#   name: '@deepseek-ai/dsh-llm-pi-ai'
```

### 10.3. 通过 profile 补丁层声明路由

**不改 `cordis.yml`,而是改补丁层** `<DSH_HOME>/profiles/web/cordis.patch.yml`(它在所有 bundle 层之后应用):

```yaml
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      local-qwen:                       # 手写路由名:小写连字符
        displayName: "Qwen Local (llama.cpp)"
        api: openai-completions         # 线协议
        baseURL: "http://<MODEL_SERVER_IP>:8080/v1"
        apiKeyEnv: LOCAL_QWEN_KEY       # 凭据引用名
        models:                         # 手写路由必须显式给模型列表
          - id: qwen-local
            name: "Qwen3.8-27B Uncensored"
            contextWindow: 262144
            reasoningEfforts: false     # 声明为非思考模型(无思考等级)
```

改完用 `--dump-config` 确认已组合进最终配置:

```bash
dsh --profile web --dump-config | grep -A15 "id: llm-pi-ai"
```

### 10.4. 注入凭据

`apiKeyEnv: LOCAL_QWEN_KEY` 是**凭据引用**,必须能解析出真实值,否则请求以 `MISSING_CREDENTIAL` 失败。凭据解析顺序:环境变量 → `~/.dsh/.credentials.yaml` → `~/.dsh/.env`。两处都写好:

```bash
umask 077
printf 'LOCAL_QWEN_KEY=sk-no-key-required\n' > <DSH_HOME>/.env
chmod 600 <DSH_HOME>/.env
# 同时在 dsh-web.service 里设置 Environment=LOCAL_QWEN_KEY=...

systemctl daemon-reload
systemctl restart dsh-web
```

---

## 11. 端到端验证(含 RPC 调试方法)

页面能开并不等于模型能用,必须真跑一轮。dsh Web 前后端通过桥接端点 `/api/<namespace>/<method>` 通信,调试它本身就是一段「踩坑」。

### 11.1. 请求信封

```jsonc
{
  "type": "client-request",
  "rpcId": "<任意字符串>",
  "method": "<namespace>/<method>",   // 如 llm/listProviders
  "payload": { "args": { ... } }      // 注意 payload 必须且只能有 args
}
```

- 信封字段不对 → 返回 `rpcId: "invalid-request"`;
- `payload` 不是「恰好一个 plain-object 的 `args` 字段」→ 报
  `Remote payload must contain exactly one plain-object args field`;
- 字段不符 → 报
  `typert gateway: <method>: args fields do not match the descriptor: missing "x", unexpected "y"`
  (可借助此报错**迭代发现**所需字段)。

### 11.2. 验证 provider 与目录

```bash
curl -s -b cookie.txt -X POST "http://<HOST_IP>/api/llm/listProviders" \
  -H "content-type: application/json" \
  -d '{"type":"client-request","rpcId":"1","method":"llm/listProviders","payload":{"args":{}}}'
# → deepseek-official, deepseek-account, local-qwen
```

```bash
curl -s -b cookie.txt -X POST "http://<HOST_IP>/api/session/modelCatalog" \
  -H "content-type: application/json" \
  -d '{"type":"client-request","rpcId":"2","method":"session/modelCatalog","payload":{"args":{}}}'
```

0.2.0 时返回(节选):

```json
{"default":{"provider":"deepseek-official","model":"deepseek-flash"},
 "routableProviders":["deepseek-official","local-qwen"],
 "groups":[{"id":"local-qwen","name":"Qwen Local (llama.cpp)",
            "models":[{"id":"qwen-local","name":"Qwen3.8-27B Uncensored"}]}]}
```

> 升级到 0.2.1 后,`default` 已变为 `{"provider":"local-qwen","model":"qwen-local"}`,`routableProviders` 仅剩 `["local-qwen"]`。

### 11.3. 坑:会话默认模型不生效时,用 `session/selectModel`

0.2.0 时,直接 `session/create` 把模型塞进 `request.model`,接口返回 `ok` 但会话仍用默认的 `deepseek-official`(无 key):

```
sessionStats: { turns:1, steps:1, llmMs:0 }   ← 没真跑
turnOutline:  [{ response: "" }]              ← 输出为空
modelSelection.lastUsed: { provider: "deepseek-official", model: "deepseek-flash" }
```

正确做法:先建会话,再用专门接口 `session/selectModel` 切模型:

```bash
# 1) 建会话
curl ... /api/session/create \
  -d '{"type":"client-request","rpcId":"c1","method":"session/create","payload":{"args":{"request":{}}}}'
# ⇒ sessionId

# 2) 切到本地模型
curl ... /api/session/selectModel \
  -d '{"type":"client-request","rpcId":"sm","method":"session/selectModel",
       "payload":{"args":{"request":{"sessionId":"<sid>","provider":"local-qwen","model":"qwen-local"}}}}'
# ⇒ {"selected":{"provider":"local-qwen","model":"qwen-local"}}

# 3) 发提示
curl ... /api/session/prompt \
  -d '{"type":"client-request","rpcId":"p2","method":"session/prompt",
       "payload":{"args":{"request":{"requestId":"req-2","sessionId":"<sid>","mode":"queue",
                    "content":[{"type":"text","text":"Reply with exactly: OK"}],"clientTimeZone":"UTC"}}}}'
```

`session/prompt` 的参数结构(从客户端 bundle 源码查到):

```js
remote.session.prompt({
  requestId, sessionId, mode,      // mode 常用 "queue"
  content,                         // [{ type:"text", text }]
  clientTimeZone
}, signal)
```

### 11.4. 最终证据

读取 `session/list`(`args` 需为 `{"_request":{}}`)。

0.2.0-rc.2:

```json
{"modelSelection":{"lastUsed":{"provider":"local-qwen","model":"qwen-local"},
                   "next":{"provider":"local-qwen","model":"qwen-local"}},
 "sessionStats":{"turns":2,"steps":2,"llmMs":11963,
                 "ttftMs":10598,"decodeMs":1365,"decodeTokens":29},
 "turnOutline":[{"turn":2,"prompt":"Reply with exactly: OK","response":"OK"}]}
```

0.2.1-rc.2(升级后复测):

```json
{"sessionStats":{"turns":1,"steps":1,"llmMs":30763,
                 "ttftMs":22908,"decodeMs":7855,"decodeTokens":168},
 "turnOutline":[{"turn":1,"prompt":"Reply with exactly: OK","response":"OK"}]}
```

本地模型确实在跑,回复 `OK`。

---

## 12. 版本升级记录(0.2.0-rc.2 → 0.2.1-rc.2)

### 12.1. 升级前:先备份补丁与整包

升级会覆盖 `node_modules`,原有补丁全部丢失。因此先把「补丁 diff」和「整包」备份到 `node_modules` 之外:

```bash
BASE=<NODE_PREFIX>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
mkdir -p <BACKUP_DIR>/patches
cd $BASE
for f in dsh-host-webserver/lib/index.js \
         dsh-client-connection/lib/index.js \
         dsh-client-connection/lib/client.js \
         dsh-client-ui-settings/lib/client.js \
         dsh-client-ui-settings-general/lib/client.js ; do
  safe=$(echo "$f" | tr '/' '_')
  diff -u "$f.bak" "$f" > <BACKUP_DIR>/patches/$safe.diff
done
systemctl stop dsh-web
tar czf <BACKUP_DIR>/node_modules-@deepseek-ai-0.2.0-rc.2.tgz \
    -C <NODE_PREFIX>/lib/node_modules @deepseek-ai
```

> 注意:补丁文件的真实位置是 **`.../dsh/node_modules/@deepseek-ai/...`**(嵌套一层),不是顶层的 `@deepseek-ai`。

### 12.2. 执行升级

```bash
npm i -g @deepseek-ai/dsh@0.2.1-rc.2     # 或 @next
dsh --version                             # 0.2.1-rc.2
```

### 12.3. 上游变化与补丁影响

| 旧补丁 | 0.2.1-rc.2 结果 | 说明 |
|---|---|---|
| 1 host 校验 | **删除** | host 改为「接受任意具体 IP,拒绝通配」 |
| 2 固定令牌 | **保留** | `dsh-client-connection/lib/index.js:297` |
| 3 loopback | **迁移并保留** | 文件 `client.js` → `client.browser.js:1424` |
| 4 persistence | **删除** | `SettingsDescribeMirror` 不再接收该参数 |
| 5 无条件 store | **可选** | `isLoopback:true` 已使条件成立 |

### 12.4. 重打补丁(0.2.1)

```bash
BASE=<NODE_PREFIX>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai

# 补丁 A:固定令牌
cp -n $BASE/dsh-client-connection/lib/index.js $BASE/dsh-client-connection/lib/index.js.bak
sed -i 's#const created = encodeBase64Url(randomBytes(SECRET_BYTES));#const created = "<REDACTED_TOKEN>";#' \
  $BASE/dsh-client-connection/lib/index.js

# 补丁 B:浏览器端 loopback
cp -n $BASE/dsh-client-connection/lib/client.browser.js $BASE/dsh-client-connection/lib/client.browser.js.bak
sed -i 's#isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),#isLoopback: true,#' \
  $BASE/dsh-client-connection/lib/client.browser.js

systemctl start dsh-web
```

### 12.5. 升级后验证要点

```bash
journalctl -u dsh-web --no-pager | tail            # 应见 dsh web: http://<HOST_IP>/?token=<REDACTED_TOKEN>
curl -s -o /dev/null -w "%{http_code}\n" "http://<HOST_IP>/"            # 401
curl -s -c c.txt -L "http://<HOST_IP>/?token=<REDACTED_TOKEN>" -o page.html -w "%{http_code}\n"  # 200
grep -o "<title>[^<]*</title>" page.html           # DeepSeek Harness
```

确认补丁 B 已下发到浏览器 —— 从首页 HTML 取模块 URL 并 grep:

```bash
url=$(python3 - <<'PY'
import re,html
t=open('page.html',encoding='utf-8').read()
for m in re.findall(r'(?:src|href)="([^"]+)"', t):
    u=html.unescape(m)
    if 'dsh-client-connection/client.js' in u: print(u); break
PY
)
curl -s -b c.txt "http://<HOST_IP>/${url#./}" | grep -c "isLoopback: true"   # ≥1
```

---

## 13. 故障复盘表

| # | 现象 / 报错原文 | 根因 | 定位手段 | 修复 | 版本 |
|---|---|---|---|---|---|
| 1 | `npm i -g` 引擎报错 | 系统 Node 12.x,`engines` 要求 `^22.19.0\|\|>=24` | 看 `engines.node` | 装 Node 22.23.3 到 `<NODE_PREFIX>` | 通用 |
| 2 | `--host <HOST_IP>` 启动被拒 | host schema 只允许 loopback | 读 `dsh-host-webserver` | 补丁 1(**0.2.1 已作废**) | 0.2.0 |
| 3 | 无 token `401`;重启后链接失效 | launch token 每次随机 | 看启动日志的 token | 补丁 A:固定 `<REDACTED_TOKEN>` | 通用 |
| 4 | `/api/*` `403` | 非可信来源被拒 | 逐接口尝试 | `--trusted-host`(0.2.1 起可省) | 0.2.0 |
| 5 | `settings are unavailable in this browser` | 非 loopback 判定关闭设置能力 | 抓模块 + 源码 | 补丁 B(0.2.0 还需补丁 4/5) | 通用 |
| 6 | `discoverModels` 报 `... answered 503`,直连 `200` | `NO_PROXY` 用 CIDR,Node `EnvHttpProxyAgent` 不识别 → 私网地址被送进代理 | 服务器直连对比 + 查服务 env | `NO_PROXY` 改显式 IP | 通用 |
| 7 | 会话没跑本地模型(`llmMs:0`、输出空) | `session/create` 里的 model 不生效 | 读 `session/list` 投影 | 用 `session/selectModel` 切换 | 0.2.0 |
| 8 | RPC 各种 `arguments-invalid` | 信封/字段不符 typert 描述符 | 借助报错 `missing/unexpected` 迭代 | `payload.args`,查客户端 bundle | 通用 |
| 9 | 升级后补丁全失效 | 升级覆盖 `node_modules` | — | 升级前备份 diff,升级后重打(降为 2 处) | 升级 |

---

## 14. 回归 / 排错小抄

- **看组合后的配置**:`dsh --profile web --dump-config`
- **看服务日志**:`journalctl -u dsh-web --no-pager -n 50`
- **确认服务发的模块是打过补丁的**:抓首页 HTML 里的 `dsh-client-*` 模块 URL,grep `isLoopback: true`
- **对比连通性**:服务器上 `curl --noproxy '*' <target>` 与经服务内代理的结果对比,快速区分「网络/代理」与「配置」问题
- **不要** `pkill -f "dsh web"`:会匹配到自身命令行
- **改 RPC 参考**:客户端 bundle 在
  `<NODE_PREFIX>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-*/lib/client.js`,
  搜 `remote.<ns>.<method>(` 即可看到真实入参结构
- **0.2.1 起浏览器端连接文件为 `dsh-client-connection/lib/client.browser.js`**(不再是 `client.js`)

---

## 15. 回滚

- 每个被改文件都留了 `.bak`(如 `index.js.bak`、`client.browser.js.bak`),`cp` 回去即可;
- profile 配置改的是补丁层 `cordis.patch.yml`(备份为 `cordis.patch.yml.bak`),删掉 `llm-pi-ai` 段即可移除本地模型;
- 升级前的整包与补丁 diff 在 `<BACKUP_DIR>/`
  (`node_modules-@deepseek-ai-0.2.0-rc.2.tgz` + `patches/`);
- 回退版本:`npm i -g @deepseek-ai/dsh@0.2.0-rc.2`,再把该备份解回。

---

## 16. 关键文件清单(0.2.1-rc.2)

| 路径 | 说明 |
|---|---|
| `<NODE_PREFIX>/` | Node 22.23.3 |
| `<SYSTEMD_UNIT_PATH>` | dsh Web 服务(host/port/trusted-host/NO_PROXY/凭据) |
| `<DSH_HOME>/profiles/web/cordis.patch.yml` | profile 补丁(含本地模型路由) |
| `<DSH_HOME>/.credentials.yaml` | 浏览器会话签名密钥(0600) |
| `<DSH_HOME>/.env` | CLI 环境变量(`LOCAL_QWEN_KEY`) |
| `…/dsh-client-connection/lib/index.js:297` | 补丁 A(固定 token) |
| `…/dsh-client-connection/lib/client.browser.js:1424` | 补丁 B(loopback) |
| `…/dsh-client-ui-settings-general/lib/client.js` | 补丁 C(可选,无条件设置存储) |
| `<BACKUP_DIR>/` | 升级前整包 + 补丁 diff |
| `…/dsh-host-webserver/lib/index.js` | host 校验(0.2.1 原生支持具体 IP,无需改) |

---

## 17. 日常使用与后续可选项

- 访问:`http://<HOST_IP>/?token=<REDACTED_TOKEN>`(cookie 约 30 天)
- 选本地模型:模型选择器 → `Qwen Local (llama.cpp)` → `Qwen3.8-27B Uncensored`
- 默认模型:0.2.1 升级后已是 `local-qwen/qwen-local`(0.2.0 时为 DeepSeek)
- 可选后续:
  - 用 `session/initializeDefaultModel` 初始化默认模型;
  - 去掉已冗余的 `--trusted-host`(0.2.1 起绑定地址自动受信);
  - 若上游进一步官方支持固定令牌/远程设置能力,可去掉补丁 A/B。
