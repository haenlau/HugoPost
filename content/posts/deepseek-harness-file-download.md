+++
author = "haenlau"
title = "DeepSeek Harness 文件下载改造"
url = "/deepseek-harness-file-download/"
date = "2026-10-19"
description = "记录 DeepSeek Harness 文件下载功能的实现方案、前端组件改造、补丁管理、验证与回滚。"
tags = [
  "记录",
]
+++

> 目标:让 dsh Web 里**产出的文件能一键下载到本地电脑**。
> 部署环境见配套文档 `deepseek-harness-kylin-deploy.md`(本机 `dsh 0.2.1-rc.2`,LAN 地址 `http://<HOST_IP>/?token=<REDACTED_TOKEN>`)。

---

## 1. 问题:文件「出不来」

dsh 在浏览器里能用,但原版**没有把服务端文件下载到本地的入口**:

- agent 用官方 `present` 工具产出「交付卡片」,卡片动作只有 `open` / `reveal`——它们在**服务器桌面**上打开/定位文件(需要「Host desktop available」),对远程浏览器毫无用处;
- 右侧「文件」侧栏、文档预览面板都只能看,不能存;
- 官方唯一能触发**浏览器下载**的机制是 `session.export`(把会话导出成 ZIP 下载),说明「浏览器下载」这条路本身是通的,只是没人把它接到「文件」上。

---

## 2. 关键发现:官方已有「取任意文件字节」的路由

`@deepseek-ai/dsh-api-session-controller` 注册了:

```
GET|HEAD  /api/file?path=<绝对路径>
```

它按组合文件系统读取文件字节并原样返回(带 `Content-Type`),走同一套连接层鉴权:**无 cookie → `401`**。这正是图片/预览用的底层通道。

于是方案定为:

```
客户端拿到文件绝对路径
  → fetch('/api/file?path=' + encodeURIComponent(绝对路径))   // 同源,自动带 cookie
  → response.blob()
  → URL.createObjectURL(blob)
  → 造一个 <a download="文件名"> 点击
  → 释放 URL
```

**全程走官方路由,服务端零改动。** 文件名由 `a.download` 指定,且不受 `/api/file` 响应头里 `Content-Security-Policy: sandbox; default-src 'none'` 的影响(那是响应自身的 CSP,不作用于发起 fetch 的页面)。

---

## 3. 三处改动

> 核心逻辑完全一样(上面的 fetch+Blob),差别只在「在哪个组件上挂按钮」,以及「绝对路径怎么来」。

### 3.1. 右侧「文件」侧栏

- 文件:`@deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js`
- 该侧栏是**完整目录树**,每个条目的绝对路径由 `childPath(parent, name)` 拼出,现成可用。
- 改动:
  1. 新增 `downloadWorkspaceFile(path, name)`;
  2. 文件条目追加一个下载按钮(`IconDownloadOutlineRegular`),绝对定位在行右侧,**悬停才显形**;
  3. 字典新增 `entry.download`(zh:「下载到本地」/ en:「Download」)。

### 3.2. 对话内「交付卡片」(来自 `present` 工具)

- 文件:`@deepseek-ai/dsh-client-ui-deliverables/lib/client.js`
- 组件 `PresentedFileCard` 手上有 `file.path` 与会话 `cwd`,用 `resolveWorkspacePath(cwd, file.path)` 得到绝对路径。
- 改动:在右侧 `.actions` 区内、原有「打开/定位」动作之前插入下载按钮;字典新增 `presented.download`。

### 3.3. 对话内「改动卡片」(agent 直接写文件时出现)

> ⚠️ **这是最容易被忽略的一处。** agent 不用 `present`、只是「改/写文件」时,dsh 显示的是 `workspace/changes` 的**改动卡片**(界面上写作「已编辑 xxx」),，页面显示改动卡片组件。最初只改了 3.1/3.2,结果用户「让 agent 写个文件」时根本看不到按钮。

- 文件:同 3.2(`dsh-client-ui-deliverables/lib/client.js`)
- 组件:`ChangedFiles`
- 改动:
  - **单文件卡**:卡片右上角加一个下载按钮;
  - **多文件卡**:每一行右侧各加一个下载按钮;
  - 字典新增 `changes.download`。

### 3.4. 定位方式(三处通用)

按钮用绝对定位叠在卡片/行上,并阻止冒泡,避免触发「打开预览/查看改动」:

```js
onClick: (event) => {
  event.stopPropagation();
  downloadDeliveredFile(resolveWorkspacePath(cwd, file.path), basename(file.path));
}
```

| 位置 | CSS 类 | 定位 |
|---|---|---|
| 侧栏文件行 | `k-1LKG_download` | `right:4px; top:50%`,悬停显形(`opacity/pointer-events`) |
| 交付卡片 | `nyYjTG_download` | 在 `.actions` 内 |
| 改动卡片(单文件) | `hz8-rW_download` | `top:30px; right:10px`(叠在 60px 高的标题行上) |
| 改动卡片(多文件) | `hz8-rW_rowDownload` | `top:50%; right:8px`(叠在行上) |

---

## 4. 补丁文件与一键脚本

所有补丁已固化成「diff + 脚本」,放在服务器 `<PATCH_DIR>/`:

| 文件 | 作用 |
|---|---|
| `dsh-client-connection__lib__index.js.diff` | 补丁 A:固定令牌 `<REDACTED_TOKEN>` |
| `dsh-client-connection__lib__client.browser.js.diff` | 补丁 B:浏览器端 `isLoopback: true` |
| `dsh-client-ui-sidebar-files__lib__client.js.diff` | **补丁 D**:侧栏「下载」按钮 |
| `dsh-client-ui-deliverables__lib__client.js.diff` | **补丁 E**:交付卡片 + 改动卡片「下载」按钮 |
| `apply-patches.sh` | 一键重打(幂等) |
| `revert-patches.sh` | 一键还原 |

> 注意补丁文件真实路径是 **`.../dsh/node_modules/@deepseek-ai/...`**(嵌套一层 `@deepseek-ai`),实际位于嵌套一层的 `@deepseek-ai` 目录中。

---

## 5. 升级后如何恢复

升级会覆盖 `node_modules`,补丁全部丢失。重打:

```bash
bash <PATCH_DIR>/apply-patches.sh     # 逐个 patch -p0;已应用的自动跳过
systemctl restart dsh-web
# 浏览器 Ctrl+F5 强刷
```

`apply-patches.sh` 逻辑:对每个 diff 先 `--dry-run --forward`,失败再试 `--reverse`(即「已应用」);两者都失败才报 `FAILED`(说明上游改了上下文,需重新生成该 diff)。

---

## 6. 验证方法(无需点浏览器)

**6.1 确认改动已下发到浏览器**——从首页 HTML 取到包含对应 `client.js` 的模块 URL,`curl` 回来后 grep 关键符号:

```bash
curl -s -c jar.txt -L "http://<HOST_IP>/?token=<REDACTED_TOKEN>" -o home.html
# 从 home.html 里找到 plugins/??... 的模块 URL 后:
grep -c downloadWorkspaceFile bundle.js       # 侧栏:2
grep -c downloadDeliveredFile bundle.js       # 卡片:2
grep -c IconDownloadOutlineRegular bundle.js  # ≥1
```

**6.2 确认下载通道本身可用**:

```bash
echo hi > <TEMP_FILE>
# 带 cookie:200 + 原字节
curl -s -b jar.txt -o /dev/null -w "%{http_code}\n" \
  "http://<HOST_IP>/api/file?path=%2Ftmp%2Fx.txt"
# 无 cookie:401
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://<HOST_IP>/api/file?path=%2Ftmp%2Fx.txt"
```

---

## 7. 使用说明

- 右侧「文件」侧栏(`Ctrl+Alt+P`):目录树里把鼠标移到某个文件行上 → 出现**下载按钮** → 点击;
- 对话里 agent 写/改了文件:出现「已编辑 xxx」**改动卡片** → 卡片右上角(单文件)或每行右侧(多文件)**下载按钮**;
- 对话里 agent 用 `present` 交付文件:**交付卡片**右侧**下载按钮**。

下载走浏览器原生下载,保存到本机默认下载目录,文件名与原文件一致。

---

## 8. 取舍:为什么不用共享目录 / 单独静态服务

试过在 `8090` 上跑 `python3 -m http.server` 指向一个共享目录。这种方案需要额外端口和入口,每次还要让 agent 把文件写入共享目录。上面的做法**同一端口、同一鉴权、文件在哪下哪里**,体验才顺。

---

## 9. 回滚

- 每个被改文件都同时留有 `.bak` / `.orig` 原件,直接 `cp` 回去即可;
- 或用 `<PATCH_DIR>/revert-patches.sh` 一键还原该目录下所有补丁;
- 升级前的整包备份在 `<BACKUP_DIR>/`。

---

## 10. 教训

做前端改造,**先确认用户实际会看到哪个组件**。dsh 里「产出文件」会因 agent 是否调用 `present` 而落到不同卡片上;只按自己设想的组件去改,很可能用户根本看不到。
