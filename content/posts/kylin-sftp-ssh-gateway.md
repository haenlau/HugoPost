+++
author = "haenlau"
title = "SFTP 网闸连接失败排查"
url = "/kylin-sftp-ssh-gateway/"
date = "2026-08-27T06:36:24+00:00"
description = "记录安全隔离网闸连接 SFTP 服务器时因 Host Key 算法不兼容导致失败的现象、抓包证据和修复方法。"
tags = [
  "记录",
]
+++

问题发生在一套安全隔离与信息交换系统的 SFTP 文件同步配置中。网闸管理界面已经配置了文件交换任务，但任务无法正常启动或连接服务器，页面提示前置机资源连接异常。

## 故障现象

网闸“文件交换”页面中有一条名为 `sync` 的同步配置，状态为“停止”，同步方向为“双向”，轮询间隔为 `3000` 毫秒。可编辑类型和不可编辑类型均为 `SFTP`。

![img_4ffde9f3e018.jpg](https://pic.air1.cn/file/post/kylin-sftp-ssh-gateway/1787812584319_img_4ffde9f3e018.jpg)

从页面上看，SFTP 类型已经选择正确，问题不是把 SFTP 误配置成 FTP，而是网闸与服务器建立 SSH 会话时失败。

## 抓包确认连接过程

从网闸侧抓取 TCP 流，并使用 Wireshark 过滤：

```text
tcp.stream eq 0
```

可以看到客户端和服务端已经完成 TCP 连接以及 SSH 版本交换：

```text
客户端：SSH-2.0-JSCH-0.1.54
服务端：SSH-2.0-OpenSSH_8.2
```

随后双方发送 SSH `KEXINIT`，开始交换密钥交换、主机密钥、加密和 MAC 算法列表。客户端在算法列表交换后立即断开，并返回：

```text
com.jcraft.jsch.JSchException: Algorithm negotiation fail
```

之后服务端出现 `FIN/ACK` 和 `RST/ACK`。

![Wireshark 显示 SSH 算法协商失败](https://pic.air1.cn/file/post/kylin-sftp-ssh-gateway/1787812112199_img_a24c324f08ac.jpg)

这说明：

- TCP 22 端口可以连接；
- SSH 版本交换成功；
- 故障发生在 SSH 算法协商阶段；
- 用户认证和 SFTP 子系统还没有开始执行。

## 故障原因

本次失败的具体类别是 SSH 的 Host Key 算法（主机密钥算法）不兼容。

麒麟服务器上的 OpenSSH 提供：

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

两端没有共同的 Host Key 算法：

| 端点 | Host Key 算法 |
| --- | --- |
| OpenSSH 服务端 | `rsa-sha2-512`、`rsa-sha2-256`、`ssh-ed25519` |
| 网闸侧 JSch 客户端 | `ssh-rsa`、`ssh-dss`、`ecdsa-sha2-nistp256`、`ecdsa-sha2-nistp384`、`ecdsa-sha2-nistp521` |
| 共同算法 | 无 |

因此，网闸虽然可以连通服务器的 TCP `22` 端口，但无法完成 SSH 会话协商。

## 处理方法

在服务器 `/etc/ssh/sshd_config` 中追加：

```conf
# 兼容网闸侧老版本 JSch 客户端
HostKeyAlgorithms +ssh-rsa
```

使用 `+` 是为了保留 OpenSSH 原有的现代算法，只额外增加 `ssh-rsa`。不需要开启 `ssh-dss`，也不要为了这个问题整体覆盖 `KexAlgorithms`、`Ciphers` 或 `MACs`。

修改后先检查配置：

```bash
sshd -t
```

确认没有错误后重启服务：

```bash
systemctl restart sshd
```

检查实际生效的 Host Key 算法：

```bash
sshd -T | grep -i hostkeyalgorithms
```

输出中应包含：

```text
ssh-rsa
```

然后重新启用网闸的 SFTP 同步任务，并再次抓包确认连接是否能够继续进入密钥交换和 `NEWKEYS` 阶段。

## 结论

这次故障不是网卡绑定错误、TCP `22` 端口不通、SFTP 子系统未启用或用户密码错误，而是 `sshd` 的 `HostKeyAlgorithms` 没有包含网闸客户端支持的 `ssh-rsa`。

服务端提供 `rsa-sha2-512`、`rsa-sha2-256`、`ssh-ed25519`，网闸客户端提供 `ssh-rsa`、`ssh-dss` 和 ECDSA 算法，双方没有交集，最终触发 `Algorithm negotiation fail`。在保留原有安全算法的前提下追加 `HostKeyAlgorithms +ssh-rsa`，是本次问题的最小兼容修复。
