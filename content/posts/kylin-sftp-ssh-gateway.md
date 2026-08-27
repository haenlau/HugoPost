+++
author = "haenlau"
title = "麒麟 V10 上的 SFTP 与网闸排查"
url = "/kylin-sftp-ssh-gateway/"
date = "2026-08-27T06:28:28+00:00"
description = "记录银河麒麟 V10 上 SFTP、双网卡、隔离网闸和老版 JSch 因 Host Key 算法不兼容导致连接失败的排查过程。"
tags = [
  "记录",
]
+++

这是一份围绕银河麒麟 V10、OpenSSH、SFTP 和安全隔离网闸的排查记录。问题最初表现为：网闸侧测试 TCP 22 端口可以连通，但文件同步或 SFTP 会话无法建立。最终定位到的根因不是网卡绑定、SFTP 子系统或端口监听，而是 SSH 主机密钥算法协商失败：麒麟服务器的 `sshd` 配置只提供 `rsa-sha2-512`、`rsa-sha2-256` 和 `ssh-ed25519`，网闸侧客户端提供 `ssh-rsa`、`ssh-dss`、`ecdsa-sha2-nistp256`、`ecdsa-sha2-nistp384` 和 `ecdsa-sha2-nistp521`，双方在 Host Key 算法这一项没有交集。\n\n这类问题容易被误判为“端口不通”或“网闸不支持 SFTP”。排查时应把网络连通、`sshd` 服务、SFTP 子系统、网闸文件交换策略和 SSH 算法协商分开验证。

## 1. 先确认操作系统版本

面对一台可能使用国产操作系统的 Linux 主机，首先不要凭界面或登录提示猜发行版，直接查看标准版本文件：

```bash
cat /etc/os-release
```

重点关注：

- `NAME`：产品名称；
- `VERSION`：版本和代号；
- `ID`：发行版标识；
- `VERSION_ID`：主版本号；
- `PRETTY_NAME`：完整显示名称。

常见国产系统的标识大致包括：

- 统信 UOS：`uniontech` 或 `uos`；
- 银河麒麟：`kylin` 或 `openkylin`；
- 欧拉：`openEuler`；
- 龙蜥：`anolis`；
- 深度：`deepin`；
- 中科方德：`NFSChina`。

如果标准文件提供的信息不够完整，可以继续查看系统专属文件：

```bash
cat /etc/kylin-version
cat /etc/.productinfo
cat /etc/neokylin-release
cat /etc/openEuler-release
cat /etc/anolis-release
cat /etc/deepin-version
cat /etc/iSoft-release
```

辅助确认命令：

```bash
lsb_release -a
uname -r
uname -m
ls /etc/*release* /etc/*version* 2>/dev/null
```

国产系统常见的硬件架构包括：

- `x86_64`；
- `aarch64`，常见于鲲鹏、飞腾等平台；
- `loongarch64`，龙芯架构；
- `sw_64`，申威架构；
- `mips64el`，部分旧平台。

一次实际检查中，`/etc/os-release` 返回了类似下面的内容：

```text
NAME="Kylin Linux Advanced Server"
VERSION="V10 (Halberd)"
ID="kylin"
VERSION_ID="V10"
PRETTY_NAME="Kylin Linux Advanced Server V10 (Halberd)"
```

这可以确认系统是银河麒麟高级服务器操作系统 V10，代号为 `Halberd`。仅凭代号判断具体 SP 和补丁级别仍不够，最好结合 `/etc/kylin-version`、`/etc/.productinfo` 和内核版本继续确认。

## 2. SFTP 不是独立服务

在银河麒麟 V10 上，SFTP 通常不是一个单独的服务，而是 OpenSSH 服务端 `sshd` 提供的子系统。因此，“SFTP 有没有部署”本质上要检查三件事：

1. `sshd` 是否运行；
2. SFTP 子系统是否在配置中启用；
3. 是否可以实际建立 SFTP 会话。

### 2.1 检查 sshd

```bash
systemctl status sshd
```

正常状态应类似：

```text
Active: active (running)
```

如果系统服务名称不同，也可以检查：

```bash
systemctl status ssh
```

### 2.2 检查 SFTP 子系统

```bash
grep -i "subsystem.*sftp" /etc/ssh/sshd_config
```

常见的有效配置有两种：

```text
Subsystem sftp /usr/libexec/openssh/sftp-server
```

或者：

```text
Subsystem sftp internal-sftp
```

`internal-sftp` 由 `sshd` 直接处理，不依赖外部 `sftp-server` 二进制，通常也更方便配合 `ChrootDirectory` 做目录隔离。

不要只看有没有匹配文本，还要确认配置行没有被 `#` 注释，并且实际运行配置确实读取到了它。可以使用：

```bash
sshd -t
sshd -T | grep -i subsystem
```

如果使用外部 `sftp-server`，还需要确认实际路径：

```bash
find /usr -name sftp-server 2>/dev/null
```

### 2.3 实际连接测试

```bash
sftp <sftp-user>@127.0.0.1
```

能进入：

```text
sftp>
```

才算实际验证 SFTP 可用。若出现不同错误，含义通常不同：

- `Connection refused`：`sshd` 没运行、端口不对或被防火墙拒绝；
- `Subsystem request failed`：SFTP 子系统配置有误；
- `Permission denied`：网络和协议已经通，问题转到用户认证或目录权限；
- 登录后无法进入目标目录：检查 `ChrootDirectory`、属主和权限。

## 3. Windows 连接 SFTP

### 3.1 WinSCP

WinSCP 是比较直接的图形化方案。新建会话时填写：

- 文件协议：`SFTP`；
- 主机名：服务器在客户端可达的地址；
- 端口：`22`，或者实际配置的 SSH 端口；
- 用户名：专用 SFTP 用户；
- 密码：从受控凭据系统取得，不写进普通文档。

不建议生产环境直接使用 `root` 进行文件传输。更合适的方式是创建专用用户，并根据需要限制其 Shell、目录和权限。

### 3.2 FileZilla、MobaXterm、Xshell 和 Xftp

FileZilla 可以使用类似下面的地址格式：

```text
sftp://<server-address>:22
```

如果已经使用 Xshell 连接服务器，Xshell 的 SFTP 面板通常可以直接复用 SSH 会话，不需要另行部署 FTP 服务。

### 3.3 Windows 原生命令行

Windows 10 较新版本和 Windows 11 通常自带 OpenSSH 客户端：

```powershell
sftp <sftp-user>@<server-address>
```

进入 `sftp>` 后常用命令：

```text
ls
pwd
cd /remote/path
lcd C:\local\path
lpwd
get remote.txt
put local.txt
mget *.log
mput *.txt
mkdir new-directory
rm old-file.txt
rename old.txt new.txt
bye
```

如果提示 `sftp` 不是命令，需要在“设置 → 应用 → 可选功能”中安装 OpenSSH 客户端。

单文件传输也可以用：

```powershell
scp C:\local\file.txt <sftp-user>@<server-address>:/remote/path/
scp <sftp-user>@<server-address>:/remote/file.txt C:\local\
```

### 3.4 连接前检查

Windows 侧可以先检查网络和端口：

```powershell
ping <server-address>
Test-NetConnection <server-address> -Port 22
```

如果端口测试成功，但 SFTP 仍失败，不要继续只检查防火墙。TCP 端口可达只证明三次握手成功，后面还可能卡在 SSH 版本交换、算法协商、认证或 SFTP 子系统阶段。

## 4. 查看 SFTP / SSH 绑定了哪些网卡

SFTP 继承 `sshd` 的监听设置，没有独立的网卡绑定配置。查看监听：

```bash
ss -tlnp | grep ':22'
```

典型输出含义：

| 监听地址 | 含义 |
| --- | --- |
| `0.0.0.0:22` | 监听所有 IPv4 网卡 |
| `[::]:22` | 监听所有 IPv6 网卡 |
| `<specific-ip>:22` | 只监听该 IP 对应的接口 |

如果看到：

```text
0.0.0.0:22
[::]:22
```

说明当前所有处于可用状态并拥有地址的网卡，都可能提供 SSH / SFTP 服务。

查看接口和地址：

```bash
ip -4 addr show
ip route
```

如果只希望 SSH / SFTP 绑定指定接口，可以在 `/etc/ssh/sshd_config` 中使用：

```conf
ListenAddress <management-or-business-ip>
```

需要绑定多个地址时可以写多行：

```conf
ListenAddress <first-ip>
ListenAddress <second-ip>
```

修改前要特别小心：如果当前 SSH 会话正是通过将要删除的地址建立的，错误修改会直接切断远程管理。建议先准备控制台、IPMI 或快照，再执行：

```bash
sshd -t
systemctl restart sshd
ss -tlnp | grep ':22'
```

## 5. 双网卡与安全隔离网闸的地址关系

这是整个问题中最容易混淆的部分。网闸两侧各有一个接口，服务器也可能分别连接两个网络。不能只看到“端口 22 可达”就推断客户端可以直接建立普通 SSH 会话。

一次实际拓扑可以抽象为：

```text
可信端服务器                         安全隔离网闸                         不可信端服务器
<trusted-server-ip>  ←→  <trusted-interface>   <untrusted-interface>  ←→  <untrusted-server-ip>
```

在该拓扑中：

- 网闸可信接口连接内网服务器；
- 网闸不可信接口连接外网或隔离区服务器；
- 两侧服务器的地址属于不同网络；
- 网闸不是普通交换机，也不一定是简单的三层路由或四层 NAT；
- 文件交换通常由网闸两侧的同步程序或代理分别建立连接。

因此需要区分：

1. 可信端服务器地址；
2. 网闸可信侧接口地址；
3. 网闸不可信侧接口地址；
4. 不可信端服务器地址；
5. 文件交换策略中填写的源服务器和目标服务器。

文件交换策略一般填写的是**两端服务器的真实地址**，不是把网闸接口地址当作服务器地址。网闸接口用于连接链路，策略中的远程服务器字段则应指向实际提供 SFTP / FTP 服务的主机。

## 6. 为什么 TCP 22 通，但 SFTP 仍然失败

如果管理界面显示端口 22 测试成功，但 SFTP 客户端不能登录，可能处于以下几种情况：

### 6.1 只验证了四层连通

TCP 探测成功只说明 SYN、SYN-ACK、ACK 完成，不能证明：

- SSH banner 能正常交换；
- SSH 算法列表存在交集；
- 网闸允许 SSH / SFTP 会话；
- 用户认证可用；
- 网闸同步程序已正确配置。

### 6.2 网闸需要配置文件交换策略

许多安全隔离网闸不是让可信端客户端直接“穿透”到不可信端服务器，而是由网闸或前置机分别连接两侧服务器，再执行文件同步。

如果厂商手册的示例是“远程 FTP”，配置逻辑通常类似：

- 进入“策略配置 → 文件交换”；
- 添加远程文件传输任务；
- 选择同步模式；
- 填写两端服务器地址、账号和目录；
- 设定同步方向；
- 配置同名文件处理方式；
- 启用任务；
- 从源端上传文件，再到目标端检查结果。

如果设备明确支持“远程 SFTP”，协议类型必须选择 `SFTP`，而不是把 SFTP 当成 FTP。两者完全不同：

- FTP 通常使用 TCP `21`，属于 FTP 协议；
- SFTP 基于 SSH，通常使用 TCP `22`；
- 网闸需要有相应的 SFTP / SSH 文件交换能力，开放 FTP 不能自动等同于支持 SFTP。

### 6.3 不要把网闸应用层问题与本次根因混在一起

如果设备采用“协议剥离 → 数据摆渡 → 协议重建”的工作方式，普通 SSH 加密会话确实可能不在支持范围内。此时即便 TCP 探测成功，也可能在应用层被拒绝。但本次排查中，网闸侧已经能够发起 SSH 连接并交换算法列表，最终失败点明确出现在 Host Key 算法协商阶段，因此不能再把“网闸不支持 SSH/SFTP”作为最终结论。

如果尚未看到 SSH 算法协商过程，仍应检查：

- 是否有“远程 SFTP”任务类型；
- 是否有 SSH / SFTP 协议模板；
- 文件交换模块是否启用；
- 同步程序或前置机是否在线；
- 网闸日志是否出现协议不支持、资源连接异常或同步程序通信失败。

如果设备只支持 FTP，可以考虑使用它原生支持的文件交换方式，但这会改变安全边界，必须按现场安全要求评估，不能为了临时连通就随意降级。本次问题并不是通过改用 FTP 解决的，而是通过补齐 SSH 主机密钥算法兼容性解决的。

## 7. 文件交换任务的配置逻辑

下面是抽象后的配置示例，所有地址、账号和密码都应替换为现场受控配置，不能照抄占位符：

| 配置项 | 内容 |
| --- | --- |
| 类型 | 远程 SFTP，前提是设备明确支持 |
| 端口 | `22`，以实际 SSH 端口为准 |
| 同步模式 | 按设备和业务要求选择专用模式 |
| 目录 | `/` 或受限的具体目录 |
| 服务名称 | 自定义名称 |
| 同步方向 | 可信端 → 不可信端，或现场批准的方向 |
| 可信端 IP | 可信服务器真实地址 |
| 可信端用户 | 专用 SFTP 用户 |
| 不可信端 IP | 不可信服务器真实地址 |
| 不可信端用户 | 专用 SFTP 用户 |
| 同名文件 | 覆盖、跳过或报错，按要求设置 |
| 过滤条件 | 默认不做过滤，按业务要求增加 |

启用策略后，验证顺序应当是：

1. 确认可信服务器的 `sshd` 和 SFTP 子系统正常；
2. 确认不可信服务器的 `sshd` 和 SFTP 子系统正常；
3. 从网闸侧确认两端网络和端口可达；
4. 检查同步程序和前置机状态；
5. 从源目录上传一个批准的测试文件；
6. 检查目标目录是否收到文件；
7. 检查网闸任务日志、服务器 `journalctl` 和 SFTP 审计记录。

## 8. “前置机资源连接异常”的排查

“与可信端同步程序通讯失败，前置机资源连接异常”这类提示，说明问题未必发生在不可信端服务器。它可能表示网闸无法与可信端的同步程序或前置机建立关系。

应先在可信端服务器检查：

```bash
systemctl status sshd
ss -tlnp | grep ':22'
sftp <sftp-user>@127.0.0.1
```

然后检查网闸可信接口到可信服务器之间是否放通：

```bash
firewall-cmd --list-all
iptables -L -n
```

如果需要抓包，可以在可信服务器连接网闸的网卡上执行：

```bash
tcpdump -i <trusted-interface> port 22 -nn
```

触发一次网闸同步任务时观察：

- 是否有来自网闸可信接口的连接；
- 是否完成 TCP 三次握手；
- 是否出现 SSH banner；
- 是服务器主动拒绝，还是网闸主动断开；
- 是否根本没有流量到达服务器。

如果可信服务器没有看到连接，优先检查网闸同步程序、前置机状态、策略地址和路由，而不是继续修改不可信端的 `sshd_config`。

## 9. sshd 启动失败时的顺序

如果是“服务启动不了”，先不要围绕网闸猜测，直接在服务器上获取事实：

```bash
systemctl status sshd --no-pager
journalctl -u sshd -b --no-pager -n 50
sshd -t
```

常见原因包括：

| 原因 | 典型现象 | 检查方式 |
| --- | --- | --- |
| 配置语法错误 | `bad configuration option`、行号错误 | `sshd -t` |
| 主机密钥缺失 | `Could not load host key` | 检查 `/etc/ssh/ssh_host_*` |
| 端口被占用 | `Address already in use` | `ss -tlnp` |
| 运行目录缺失 | `/run/sshd missing` | 检查 `/run/sshd` |
| SFTP 子系统错误 | `Subsystem request failed` | 检查 `Subsystem sftp` |
| 安全策略阻止 | AVC 或权限拒绝 | 检查 SELinux / KYSEC 审计 |

确认配置问题后，再按实际错误处理。例如：

```bash
ssh-keygen -A
mkdir -p /run/sshd
chmod 755 /run/sshd
sshd -t
```

不要在没有错误证据时直接关闭 SELinux、KYSEC 或其他安全机制。也不要把 `systemctl restart sshd` 当成排查步骤的替代品；重启前必须先通过 `sshd -t`。

## 10. 最终根因：HostKeyAlgorithms 缺少 ssh-rsa

Wireshark 抓包显示，网闸侧使用的是较老的 JSch `0.1.54`。双方完成版本交换和 `KEXINIT` 算法列表交换后，客户端发送了断开消息，原因类似：

```text
com.jcraft.jsch.JSchException: Algorithm negotiation fail
```

这不是 SFTP 账号或目录权限问题，也不能笼统地说成“加密算法不兼容”。SSH 协商包含多类算法：

- 密钥交换算法（KEX）；
- 主机密钥算法（Host Key）；
- 对称加密算法（Cipher）；
- MAC 算法；
- 压缩算法。

只要其中某一类没有交集，会话就可能在认证前失败。本次没有交集的具体类别是 **Host Key（主机密钥）算法**。

### 10.1 两端算法列表没有交集

本次抓包中，麒麟服务器上的 OpenSSH 提供：

```text
rsa-sha2-512
rsa-sha2-256
ssh-ed25519
```

网闸侧 JSch 客户端提供：

```text
ssh-rsa
ssh-dss
ecdsa-sha2-nistp256
ecdsa-sha2-nistp384
ecdsa-sha2-nistp521
```

两组列表逐项比较如下：

| 方向 | 提供的 Host Key 算法 |
| --- | --- |
| 麒麟服务器 OpenSSH | `rsa-sha2-512`、`rsa-sha2-256`、`ssh-ed25519` |
| 网闸侧 JSch | `ssh-rsa`、`ssh-dss`、`ecdsa-sha2-nistp256`、`ecdsa-sha2-nistp384`、`ecdsa-sha2-nistp521` |
| 共同算法 | 无 |

服务端没有 `ssh-rsa`，而网闸侧没有 `rsa-sha2-512`、`rsa-sha2-256` 或 `ssh-ed25519`，因此双方无法选出共同的 Host Key 算法。最小兼容方向是让服务端额外提供：

```conf
HostKeyAlgorithms +ssh-rsa
```

这就是本次 SFTP 连接失败的直接原因。TCP 连接、`sshd` 服务、SFTP 子系统和双网卡监听均不是最终故障点。

### 10.2 不要无条件覆盖默认算法

风险较大的写法是直接把系统默认列表整体替换掉：

```conf
KexAlgorithms <custom-list>
Ciphers <custom-list>
MACs <custom-list>
```

这种方式可能为了兼容一个老客户端，反而删除现代安全算法。

更稳妥的原则是：

- 保留系统默认算法；
- 只追加必要的兼容算法；
- 先确认故障到底属于哪一类算法；
- 优先修改单个最可能的关键项；
- 不为了“看起来全面”而同时开放一大批旧算法。

例如在确认确实需要时，可以采用追加形式：

```conf
KexAlgorithms +diffie-hellman-group-exchange-sha256,+diffie-hellman-group14-sha1
Ciphers +aes128-ctr,+aes192-ctr,+aes256-ctr
MACs +hmac-sha1,+hmac-sha2-256,+hmac-sha2-512
```

本次抓包已经证明 KEX、Cipher 和 MAC 存在共同算法，因此不需要为了保险扩大它们。应先只增加：

```conf
HostKeyAlgorithms +ssh-rsa
```

### 10.3 不建议开启 ssh-dss

旧版 JSch 可能支持：

```text
ssh-dss
ssh-rsa
```

但 DSA / SHA-1 已经废弃。若问题只需要 `ssh-rsa`，不要顺手把 `ssh-dss` 也开启。

### 10.4 麒麟 V10 和 OpenSSH 版本

如果系统是 OpenSSH `8.2p1`，不能简单套用“OpenSSH 8.8 默认禁用 `ssh-rsa`”的结论。需要先确认：

```bash
ssh -V
sshd -T | grep -i hostkeyalgorithms
ssh -Q HostKeyAlgorithms | grep rsa
grep -R "HostKeyAlgorithms" /etc/ssh/
```

还要留意：

- `/etc/ssh/sshd_config`；
- `/etc/ssh/sshd_config.d/*.conf`；
- 配置是否放在 `Match` 块下；
- 麒麟系统的加密策略；
- `update-crypto-policies --show`；
- 是否存在定制编译的 SSH 服务。

如果 `ssh-rsa` 在客户端查询列表中存在，但 `sshd -T` 的有效服务端列表中没有，优先检查配置覆盖和系统加密策略，而不是直接认为 OpenSSH 版本本身导致。

### 10.5 修改和验证

修改前先备份配置：

```bash
cp -a /etc/ssh/sshd_config /etc/ssh/sshd_config.before-compat
```

追加最小兼容项后，先验证语法：

```bash
sshd -t
```

没有输出通常表示语法检查通过，再按维护窗口重启：

```bash
systemctl restart sshd
```

查看有效配置：

```bash
sshd -T | grep -i hostkeyalgorithms
```

确认输出中包含：

```text
ssh-rsa
```

同时使用客户端调试模式验证：

```bash
ssh -vvv <sftp-user>@<server-address> -p 22
```

重新抓包时，期望看到客户端不再在 `KEXINIT` 后立即断开，而是继续进行密钥交换、`NEWKEYS`，然后才进入认证阶段。

### 10.6 抓包证据：故障发生在算法协商阶段

从网闸侧抓到的 TCP 流可以准确还原失败位置。过滤 `tcp.stream eq 0` 后，可以看到两端先完成 SSH 版本交换：

```text
客户端：SSH-2.0-JSCH-0.1.54
服务端：SSH-2.0-OpenSSH_8.2
```

随后双方发送 SSH `KEXINIT`，开始交换密钥交换、主机密钥、加密和 MAC 等算法列表。这个阶段说明 TCP 连接、SSH 端口监听和版本交换都已经成功，故障不是简单的网络不通。

算法列表交换后，客户端没有继续进入密钥交换，而是返回：

```text
com.jcraft.jsch.JSchException: Algorithm negotiation fail
```

紧接着可以看到客户端断开，服务端随后发送 `FIN/ACK`，并出现 `RST/ACK`。因此，失败点可以定位为：**客户端和服务端在 SSH 算法协商阶段没有选出共同的 Host Key 算法**。认证、SFTP 子系统和文件目录权限都还没有开始处理。

![img_a24c324f08ac.jpg](https://pic.air1.cn/file/post/kylin-sftp-ssh-gateway/1787812112199_img_a24c324f08ac.jpg)

抓包中的两端算法列表进一步印证了这一点：

| 端点 | Host Key 算法 |
| --- | --- |
| OpenSSH 服务端 | `rsa-sha2-512`、`rsa-sha2-256`、`ssh-ed25519` |
| 网闸侧 JSch 客户端 | `ssh-rsa`、`ssh-dss`、`ecdsa-sha2-nistp256`、`ecdsa-sha2-nistp384`、`ecdsa-sha2-nistp521` |
| 共同算法 | 无 |

这份抓包证据排除了几个容易误判的方向：端口 22 已经建立连接，SSH 版本交换已经完成，SFTP 用户还没有进入认证阶段。因此，继续修改网卡绑定、用户密码、目录权限或 SFTP 子系统，都不能解决这一次故障。真正需要调整的是服务端的 `HostKeyAlgorithms`，让它在保留原有算法的同时增加网闸客户端支持的 `ssh-rsa`。

## 11. 一个可复用的排查顺序

以后遇到“端口通但 SFTP 不通”，可以按下面的层次逐步确认：

### 第一层：操作系统和服务

```bash
cat /etc/os-release
systemctl status sshd
sshd -t
```

### 第二层：SFTP 子系统

```bash
grep -i "Subsystem.*sftp" /etc/ssh/sshd_config
sshd -T | grep -i subsystem
sftp <sftp-user>@127.0.0.1
```

### 第三层：监听地址和路由

```bash
ss -tlnp | grep ':22'
ip -4 addr show
ip route
ip route get <peer-or-client-ip>
```

### 第四层：防火墙和抓包

```bash
firewall-cmd --list-all
iptables -L -n
tcpdump -i <interface> port 22 -nn
```

### 第五层：网闸文件交换能力

确认：

- 策略是不是远程 SFTP，而不是 FTP；
- 两端填写的是服务器真实地址，不是网闸接口地址；
- 同步方向是否正确；
- 前置机和同步程序是否在线；
- 网闸是否真正支持 SSH / SFTP；
- 日志中是否有资源连接异常。

### 第六层：SSH 协议协商

```bash
ssh -vvv <sftp-user>@<server-address> -p 22
ssh -Q KexAlgorithms
ssh -Q HostKeyAlgorithms
ssh -Q Ciphers
ssh -Q MACs
sshd -T
```

如果抓包显示是 JSch `0.1.54` 在 `KEXINIT` 后断开，优先比较 Host Key 算法，而不是盲目放开所有 KEX、Cipher 和 MAC。

## 12. 安全注意事项

- 不要在普通文档中保存密码、Token、私钥或完整账号池；
- 不要把测试密码写进截图、日志或博客；
- 生产环境尽量使用专用 SFTP 用户，不直接使用 `root`；
- 使用 `ChrootDirectory` 或目录权限限制文件范围；
- 只为确实需要兼容的老客户端追加旧算法；
- 不要开启已经废弃的 `ssh-dss`；
- 不要为了验证方便关闭 SELinux、KYSEC 或主机防火墙；
- 网闸策略的写操作应使用批准的测试文件和测试账号；
- 修改监听地址或 SSH 配置前，准备控制台或带外恢复方式；
- 修改配置后先 `sshd -t`，再重启服务；
- 端口探测成功不等于 SSH、SFTP 和网闸应用层都正常。

这次排查最终把问题拆成了几个独立层次：服务器上的 SFTP 服务是否正常、双网卡监听是否覆盖目标接口、网闸是否通过文件交换策略工作，以及旧版 JSch 是否与服务端主机密钥算法不兼容。只有逐层验证，才能避免把网闸策略问题误判成服务器故障，或者为了一个老客户端把整台 SSH 服务的安全算法配置过度放开。
