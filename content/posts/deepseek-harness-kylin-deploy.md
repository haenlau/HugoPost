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
> 目标地址:http://<HOST_IP>/?token=<REDACTED_TOKEN>
> 记录范围:安装、坑点排查与根因分析、dsh 功能修复(补丁)、本地模型接入、端到端验证。

---

## 0. 结论速览

这台机器的 dsh 部署包含多项源码改造:

- dsh `0.2.0-rc.2` **原生只监听 loopback、每次启动随机生成访问令牌、对非本机来源关闭设置能力**;
- 为了做到「绑定 LAN IP + 固定令牌 + 设置面板可用 + 接入局域网里的本地大模型」,一共需要 **5 处源码补丁**、1 个启动参数、1 处 profile 配置;
- 另外踩了一个非常隐蔽的坑:**Node 的 `NO_PROXY` 不认 CIDR**,导致 dsh 访问同网段的模型服务器时被错误地送进代理,报 `503`。

---

## 1. 背景与目标

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

dsh 这版以「本机(loopback)」作为安全前提，监听地址、令牌签发和设置能力均由 loopback 判定决定。启用 LAN 访问后，这些限制需要通过补丁调整。

---

## 2. 环境准备

### 2.1 Node.js —— 系统源版本过旧

麒麟系统源里的 Node.js 只有 `12.x`,而 dsh 的 `package.json` 明确要求:

```
engines.node = ^22.19.0 || >=24.0.0
```

直接用系统 Node 安装会因引擎不满足而失败,所以手动安装 Node `22.23.3`(aarch64):

```bash
tar -xJf node-v22.23.3-linux-arm64.tar.xz -C /opt
mv <NODE_ARCHIVE_DIR> <NODE_PREFIX>

ln -sf <NODE_PREFIX>/bin/node     /usr/local/bin/node
ln -sf <NODE_PREFIX>/bin/npm      /usr/local/bin/npm
ln -sf <NODE_PREFIX>/bin/npx      /usr/local/bin/npx
ln -sf <NODE_PREFIX>/bin/corepack /usr/local/bin/corepack

cat > /etc/profile.d/node.sh <'EOF'
export PATH=<NODE_PREFIX>/bin:$PATH
EOF

node -v   # v22.23.3
```

### 2.2 出网问题

该机器需要出网才能下载 Node 与 npm 包,相关网络方案不在此处展开。后续 dsh 服务同样可能通过 `HTTP_PROXY/HTTPS_PROXY` 出网,而这一点会在 §6.4 引出一个大坑。

---

## 3. 安装 dsh

```bash
npm i -g @deepseek-ai/dsh
```

- 安装版本:`0.2.0-rc.2`(最新稳定版;当时 alpha 已到 `0.2.1-alpha.4`,未采用)
- 可执行文件:`<NODE_PREFIX>/bin/dsh` → 软链 `/usr/local/bin/dsh`

---

## 4. 改造一:让 dsh 监听 LAN IP

### 4.1 现象

```bash
dsh web --host <HOST_IP> --port 80
# 启动被 host 校验拒绝
```

### 4.2 根因

dsh 的 host 校验器(`@deepseek-ai/dsh-host-webserver`)在 schema 层把允许的 host 限制为 loopback 集合,`<HOST_IP>` 不在其中,启动即被拒。

### 4.3 定位

```bash
cd <NODE_GLOBAL_MODULES>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib
# 打开 index.js,定位到被校验的 host 枚举(第 142 行附近)
```

### 4.4 修复(补丁 1)

- 文件:`@deepseek-ai/dsh-host-webserver/lib/index.js:142`
- 改动:把 `<HOST_IP>` 加入允许的 host 列表
- 备份:`cp -n index.js index.js.bak`

---

## 5. 改造二:固定访问令牌

### 5.1 现象

- 浏览器访问不带 token → `401`;
- 服务重启后,原来带 token 的链接全部失效(令牌每次随机)。

### 5.2 根因

`@deepseek-ai/dsh-client-connection` 启动时调用 `processLaunchToken` 生成一个**随机** launch token,并在日志里打印形如:

```
dsh web: http://127.0.0.1/?token=<random>
```

### 5.3 修复(补丁 2)

- 文件:`@deepseek-ai/dsh-client-connection/lib/index.js`
- 改动:`processLaunchToken` 直接返回固定字符串 `"<REDACTED_TOKEN>"`
- 备份:`cp -n index.js index.js.bak`

### 5.4 效果

访问地址固定为 http://<HOST_IP>/?token=<REDACTED_TOKEN>,首次访问返回 303 并下发 cookie,后续 cookie 有效期约 30 天。

---

## 6. 修复 dsh 功能

### 6.1 现象:客户端判定为非本机 → 设置能力被关闭

LAN 打开页面后,设置面板报:

```
settings are unavailable in this browser
```

### 6.2 根因

客户端(`dsh-client-connection`)有一段 loopback 判定,并把「是否本机」的结果分发给设置模块。客户端判定为非 loopback 时:

- 设置的持久化模式被降级(不是 `host`);
- 设置文档存储(`SettingsDocumentStore`)被跳过,导致「设置不可用」。

### 6.3 修复(补丁 3 / 4 / 5)

| 补丁 | 文件:行 | 改动 | 作用 |
|---|---|---|---|
| 3 | `dsh-client-connection/lib/client.js:1404` | `isLoopback: true` | 让客户端按本机处理,放开被关闭的能力 |
| 4 | `dsh-client-ui-settings/lib/client.js:1509` | `const persistence = "host";` | 设置持久化到 Host 端 |
| 5 | `dsh-client-ui-settings-general/lib/client.js:992` | 无条件 `new SettingsDocumentStore(ctx, ctx.configForms.describe())` | 强制创建设置文档存储 |

```bash
cd <NODE_GLOBAL_MODULES>/@deepseek-ai/dsh/node_modules/@deepseek-ai
cp -n dsh-client-connection/lib/client.js          dsh-client-connection/lib/client.js.bak
cp -n dsh-client-ui-settings/lib/client.js         dsh-client-ui-settings/lib/client.js.bak
cp -n dsh-client-ui-settings-general/lib/client.js dsh-client-ui-settings-general/lib/client.js.bak
```

### 6.4 坑:`/api/*` 返回 403,以及 `NO_PROXY` 不支持 CIDR 导致的 503

**(a) 403 —— 非可信来源**

改造后页面能开,但所有 `/api/*` 请求 `HTTP 403`。原因是 host 校验通过后,还有一层「可信来源(trusted host)」校验。解决方式是启动参数:

```
--trusted-host <HOST_IP>
```

加上后 `/api/*` 带 cookie 返回 `200`。

**(b) 503 —— 需要靠边站的「大坑」**

接本地模型时,`llm/discoverModels` 报:

```
http://<MODEL_SERVER_IP>:8080/v1/models answered 503
```

但**在服务器上直接 curl 该地址却是 `200`**:

```bash
curl -s -o /dev/null -w "%{http_code}\n" --noproxy '*' http://<MODEL_SERVER_IP>:8080/v1/models
# 200
```

根因:服务以 `HTTP_PROXY/HTTPS_PROXY` 出网,`NO_PROXY` 最初写成网段 CIDR:

```
NO_PROXY=localhost,127.0.0.1,<LAN_CIDR>
```

**Node 的 `undici` `EnvHttpProxyAgent` 不识别 CIDR 语法**(它只做主机名后缀/精确匹配),于是 `<MODEL_SERVER_IP>` 没有被排除,请求被送进代理,同网段的私网地址在代理侧不可达 → `503`。

修复:把 `NO_PROXY` 改成**显式 IP**:

```
NO_PROXY=localhost,127.0.0.1,<HOST_IP>,<MODEL_SERVER_IP>
```

改完 `discoverModels` 立即返回:

```json
{"ok":true,"value":[{"id":"qwen-local","name":"qwen-local"}]}
```

> 教训:凡是 Node 服务,`NO_PROXY` 一律用显式主机/IP,不要用 CIDR。

---

## 7. 服务化与防火墙

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
Environment=HTTP_PROXY=http://127.0.0.1:PROXY_PORT
Environment=HTTPS_PROXY=http://127.0.0.1:PROXY_PORT
# 关键:必须用显式 IP,不能用 CIDR
Environment=NO_PROXY=localhost,127.0.0.1,<HOST_IP>,<MODEL_SERVER_IP>
# 本地模型凭据(见 §8.4)
Environment=LOCAL_QWEN_KEY=<REDACTED_MODEL_API_KEY>
ExecStart=<NODE_PREFIX>/bin/dsh web --host <HOST_IP> --port 80 --no-open --trusted-host <HOST_IP>
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

参数解释:

| 参数 | 作用 |
|---|---|
| `--host <HOST_IP>` | 绑定 LAN IP(依赖补丁 1) |
| `--port 80` | HTTP 端口 |
| `--no-open` | 服务器上不尝试拉起浏览器 |
| `--trusted-host <HOST_IP>` | 放行该来源的 `/api/*`(修复 403) |

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

## 8. 接入本地模型(pi-ai)

### 8.1 本地端点

先探测模型服务器(`/v1/models`)拿到真实信息:

```json
{"id":"qwen-local","object":"model","owned_by":"llamacpp",
 "meta":{"n_ctx":262144,"n_ctx_train":262144,"n_params":27320697856,
         "size":20207181824,"ftype":"Q5_K - Medium"}}
```

| 项 | 值 |
|---|---|
| 服务 | http://<MODEL_SERVER_IP>:8080/v1(llama.cpp) |
| 协议 | OpenAI 兼容 chat completions |
| 模型 id | `qwen-local` |
| 上下文 | 262144 |
| 量化 | Q5_K_M(约 20GB) |
| 鉴权 | `<REDACTED_MODEL_API_KEY>`(服务端不校验) |
| GGUF | `<MODEL_FILE_PATH>` |

用 `curl` 直接验证过:非流式返回 `200`,流式 SSE 正常(该模型会先输出 `reasoning_content` 增量)。

### 8.2 确认适配器已挂载

dsh 里负责 OpenAI 兼容接入的是 `@deepseek-ai/dsh-llm-pi-ai`。先确认它随 `web` profile 挂载(处于「已挂载但未配置」的空闲态):

```bash
dsh --profile web --dump-config | grep -A2 -i "pi-ai"
# - id: llm-pi-ai
#   name: '@deepseek-ai/dsh-llm-pi-ai'
```

### 8.3 通过 profile 补丁层声明路由

**补丁层文件为** `<DSH_HOME>/profiles/web/cordis.patch.yml`(它在所有 bundle 层之后应用):

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

### 8.4 注入凭据

`apiKeyEnv: LOCAL_QWEN_KEY` 是一个**凭据引用**,必须能解析出真实值,否则请求会以 `MISSING_CREDENTIAL` 失败。凭据解析顺序:环境变量 → `~/.dsh/.credentials.yaml` → `~/.dsh/.env`。这里两者都写好:

```bash
umask 077
printf 'LOCAL_QWEN_KEY=<REDACTED_MODEL_API_KEY>\n' > <DSH_HOME>/.env
chmod 600 <DSH_HOME>/.env
# 同时在 dsh-web.service 里设置 Environment=LOCAL_QWEN_KEY=...

systemctl daemon-reload
systemctl restart dsh-web
```

---

## 9. 端到端验证(含 RPC 调试方法)

页面打开后,再运行一轮模型测试,确认从 Web 界面到本地模型的调用链路。dsh Web 的前后端通过一个桥接端点 `/api/<namespace>/<method>` 通信,RPC 请求结构如下。

### 9.1 请求信封

```jsonc
{
  "type": "client-request",
  "rpcId": "<任意字符串>",
  "method": "<namespace>/<method>",   // 如 llm/listProviders
  "payload": { "args": { ... } }      // 注意 payload 必须且只能有 args
}
```

- 信封字段不对 → 返回 `rpcId: "invalid-request"`;
- `payload` 未满足「恰好一个 plain-object 的 `args` 字段」→ 报
  `Remote payload must contain exactly one plain-object args field`;
- 字段不符 → 报
  `typert gateway: <method>: args fields do not match the descriptor: missing "x", unexpected "y"`
  (可以借助这个报错**迭代发现**所需字段)。

### 9.2 验证 provider 与目录

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

返回(节选):

```json
{"default":{"provider":"deepseek-official","model":"deepseek-flash"},
 "routableProviders":["deepseek-official","local-qwen"],
 "groups":[{"id":"local-qwen","name":"Qwen Local (llama.cpp)",
            "models":[{"id":"qwen-local","name":"Qwen3.8-27B Uncensored"}]}]}
```

### 9.3 坑:会话默认模型是 DeepSeek,不是本地模型

第一次调用 `session/create` 时，即使在 `request.model` 中指定模型且接口返回 `ok`，会话仍使用默认的 `deepseek-official`(无 key):

```
sessionStats: { turns:1, steps:1, llmMs:0 }   ← 没真跑
turnOutline:  [{ response: "" }]              ← 输出为空
modelSelection.lastUsed: { provider: "deepseek-official", model: "deepseek-flash" }
```

正确做法是先建会话,再用**专门的选择接口** `session/selectModel` 切模型:

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

`session/prompt` 的参数结构是从客户端 bundle 源码里查到的:

```js
remote.session.prompt({
  requestId, sessionId, mode,      // mode 常用 "queue"
  content,                         // [{ type:"text", text }]
  clientTimeZone
}, signal)
```

### 9.4 最终证据

读取 `session/list`(`args` 需为 `{"_request":{}}`):

```json
{"modelSelection":{"lastUsed":{"provider":"local-qwen","model":"qwen-local"},
                   "next":{"provider":"local-qwen","model":"qwen-local"}},
 "sessionStats":{"turns":2,"steps":2,"llmMs":11963,
                 "ttftMs":10598,"decodeMs":1365,"decodeTokens":29},
 "turnOutline":[{"turn":2,"prompt":"Reply with exactly: OK","response":"OK"}]}
```

模型确实在本地端点跑起来了(`llmMs=11963`,`decodeTokens=29`,回复 `OK`)。

---

## 10. 故障复盘表

| # | 现象 / 报错原文 | 根因 | 定位手段 | 修复 |
|---|---|---|---|---|
| 1 | `npm i -g` 引擎报错 | 系统 Node 12.x,`engines` 要求 `^22.19.0\|\|>=24` | 看 `engines.node` | 手动装 Node 22.23.3到 `<NODE_PREFIX>` |
| 2 | `--host <HOST_IP>` 启动被拒 | host schema 只允许 loopback | 读 `dsh-host-webserver` | 补丁 1:放行 LAN IP |
| 3 | 无 token `401`;重启后链接失效 | launch token 每次随机 | 看启动日志的 token | 补丁 2:固定 `<REDACTED_TOKEN>` |
| 4 | `/api/*` `403` | 非可信来源被拒 | 逐接口尝试 | 启动加 `--trusted-host <HOST_IP>` |
| 5 | `settings are unavailable in this browser` | 非 loopback 判定关闭设置能力 | 浏览器抓模块 + 源码 | 补丁 3/4/5 |
| 6 | `discoverModels` 报 `... answered 503`,但直连 `200` | `NO_PROXY` 用了 CIDR,Node `EnvHttpProxyAgent` 不识别 → 私网地址被送进代理 | 服务器直连对比 + 检查服务 env | `NO_PROXY` 改显式 IP |
| 7 | 会话没跑本地模型(`llmMs:0`、输出空) | `session/create` 里的 model 不生效,默认仍是 deepseek | 读 `session/list` 投影 | 用 `session/selectModel` 切换 |
| 8 | RPC 调用各种 `arguments-invalid` | 信封/字段不符合 typert 描述符 | 借助报错的 `missing/unexpected` 迭代 | `payload.args`,查客户端 bundle 参数结构 |

---

## 11. 回归 / 排错小抄

- **看组合后的配置**:`dsh --profile web --dump-config`
- **看服务日志**:`journalctl -u dsh-web --no-pager -n 50`
- **确认服务发的模块是打过补丁的**:浏览器里抓 `dsh-client-*` 模块,检查 `persistence = "host"`、`isLoopback` 是否为新 revision
- **对比连通性**:服务器上 `curl --noproxy '*' <target>` 与经服务内代理的结果对比,能快速区分「网络/代理问题」与「配置问题」
- **不要** `pkill -f "dsh web"`:会匹配到自身命令行
- **改 RPC 参考**:客户端 bundle 在
  `<NODE_GLOBAL_MODULES>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-*/lib/client.js`,
  搜 `remote.<ns>.<method>(` 即可看到真实入参结构

---

## 12. 回滚

- 每个被改文件都留了 `.bak`(如 `index.js.bak`),`cp` 回去即可;
- profile 配置改的是补丁层 `cordis.patch.yml`(备份为 `cordis.patch.yml.bak`),删掉 `llm-pi-ai` 段即可移除本地模型;
- 注意:升级/重装 `@deepseek-ai/dsh` 会覆盖 `node_modules`,**所有补丁需重新打**。

---

## 13. 关键文件清单

| 路径 | 说明 |
|---|---|
| `<NODE_PREFIX>/` | Node 22.23.3 |
| `<SYSTEMD_UNIT_PATH>` | dsh Web 服务(host/port/trusted-host/NO_PROXY/凭据) |
| `<DSH_HOME>/profiles/web/cordis.patch.yml` | profile 补丁(含本地模型路由) |
| `<DSH_HOME>/.credentials.yaml` | 浏览器会话签名密钥(0600) |
| `<DSH_HOME>/.env` | CLI 环境变量(`LOCAL_QWEN_KEY`) |
| `…/dsh-host-webserver/lib/index.js:142` | 补丁 1(LAN host) |
| `…/dsh-client-connection/lib/index.js` | 补丁 2(固定 token) |
| `…/dsh-client-connection/lib/client.js:1404` | 补丁 3(loopback) |
| `…/dsh-client-ui-settings/lib/client.js:1509` | 补丁 4(persistence=host) |
| `…/dsh-client-ui-settings-general/lib/client.js:992` | 补丁 5(无条件设置存储) |

---

## 14. 日常使用与后续可选项

- 访问:http://<HOST_IP>/?token=<REDACTED_TOKEN>(cookie 约 30 天)
- 选本地模型:模型选择器 → `Qwen Local (llama.cpp)` → `Qwen3.8-27B Uncensored`
- 默认模型目前仍是 DeepSeek(需联网且能直连其 API)
- 可选后续:
  - 把本地模型设为默认(调整默认模型选择);
  - 用 `session/initializeDefaultModel` 初始化默认模型;
  - 若上游 dsh 版本支持官方 LAN/固定令牌配置,可去掉补丁 1/2/3/4/5。
