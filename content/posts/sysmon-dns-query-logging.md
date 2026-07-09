+++
title = "使用 Sysmon 监控 DNS 查询定位恶意域名访问进程"
date = "2026-05-22"
lastmod = "2026-05-22"
description = "通过安装配置 Sysmon 开启 DNS 查询日志（事件 ID 22），在 Windows 事件查看器中定位频繁外联恶意域名的进程。"
url = "/sysmon-dns-query-logging/"
aliases = ["/posts/sysmon-dns-query-logging/"]
categories = ["笔记"]
draft = false
+++
## 背景

有电脑频繁外联恶意域名，需要定位是哪个进程发起的 DNS 查询。Sysmon 的 DNS 查询日志（事件 ID 22）可以记录每次 DNS 查询对应的进程，是解决此类问题的标准工具。

## Sysmon 安装

Sysmon 是微软 Sysinternals 套件中的系统监控工具，下载地址：

> https://learn.microsoft.com/zh-cn/sysinternals/downloads/sysmon

下载后解压，以管理员身份打开 PowerShell，进入解压目录执行安装：

```powershell
.\Sysmon64.exe -i -n
```

参数说明：

| 参数 | 说明 |
|------|------|
| `-i` | 安装服务和驱动程序，可选择配置文件 |
| `-c` | 更新已安装的 Sysmon 驱动程序配置，或转储当前配置 |
| `-m` | 安装事件清单（服务安装时自动安装） |
| `-s` | 打印配置架构定义 |
| `-u` | 卸载服务和驱动程序（`-u force` 强制卸载） |

`-n` 表示不安装事件清单（已通过 `-i` 安装），可减少安装步骤。

## 配置 DNS 查询监控

在 Sysmon 同目录下创建配置文件 `sysmon_dns.xml`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Sysmon schemaversion="4.90">
  <HashAlgorithms>md5,sha256,IMPHASH</HashAlgorithms>
  <CheckRevocation/>
  <EventFiltering>
    <ProcessCreate onmatch="exclude">
      <Image condition="is">C:\Windows\System32\backgroundTaskHost.exe</Image>
    </ProcessCreate>
    <NetworkConnect onmatch="include">
      <Image condition="end with">.exe</Image>
    </NetworkConnect>
    <!-- 开启 DNS 查询日志，排除系统常见进程 -->
    <DnsQuery onmatch="exclude">
      <Image condition="is">C:\Windows\System32\svchost.exe</Image>
      <Image condition="is">C:\Windows\System32\SearchProtocolHost.exe</Image>
    </DnsQuery>
  </EventFiltering>
</Sysmon>
```

配置逻辑：

- **NetworkConnect**：只记录 `.exe` 进程的网络连接，过滤掉非可执行文件的连接噪声
- **DnsQuery**：排除 `svchost.exe` 和 `SearchProtocolHost.exe` 这两个系统进程的高频 DNS 查询，减少日志量
- **ProcessCreate**：排除 `backgroundTaskHost.exe`，避免后台任务进程的干扰

应用配置：

```powershell
.\Sysmon64.exe -c sysmon_dns.xml
```

## 查看日志

打开事件查看器（`Win + R` → `eventvwr.msc`），路径：

```text
应用程序和服务日志 → Microsoft → Windows → Sysmon → Operational
```

过滤事件 ID 22（DNS 查询），可以看到每次 DNS 查询的：

- 查询的域名
- 发起查询的进程路径和 PID
- 查询类型（A、AAAA、CNAME 等）
- 查询结果

## Sysmon 事件 ID 速查

以下是 Sysmon 所有事件类型的简要说明：

| ID | 事件类型 | 说明 |
|----|----------|------|
| 1 | ProcessCreate | 进程创建，含完整命令行、哈希、ProcessGUID |
| 2 | FileCreateTime | 进程修改文件创建时间 |
| 3 | NetworkConnect | TCP/UDP 网络连接（默认禁用） |
| 4 | ServiceStateChange | Sysmon 服务状态变更（启动/停止） |
| 5 | ProcessTerminate | 进程终止 |
| 6 | DriverLoad | 驱动程序加载 |
| 7 | ImageLoad | 模块加载（默认禁用，日志量大） |
| 8 | CreateRemoteThread | 跨进程创建线程（代码注入检测） |
| 9 | RawAccessRead | 原始驱动器读取（绕过文件审计） |
| 10 | ProcessAccess | 进程访问其他进程（凭据窃取检测） |
| 11 | FileCreate | 文件创建或覆盖 |
| 12 | RegistryEvent (Key/Value Create/Delete) | 注册表键/值的创建和删除 |
| 13 | RegistryEvent (Value Set) | 注册表值修改 |
| 14 | RegistryEvent (Key/Value Rename) | 注册表键/值重命名 |
| 15 | FileCreateStreamHash | 命名文件流创建（Zone.Identifier 检测） |
| 16 | ServiceConfigurationChange | Sysmon 配置变更 |
| 17 | PipeEvent (Pipe Created) | 命名管道创建 |
| 18 | PipeEvent (Pipe Connected) | 命名管道连接 |
| 19 | WmiEvent (Filter) | WMI 事件筛选器注册 |
| 20 | WmiEvent (Consumer) | WMI 消费者注册 |
| 21 | WmiEvent (ConsumerToFilter) | WMI 消费者绑定到筛选器 |
| **22** | **DNSEvent** | **DNS 查询（Windows 8.1+）** |
| 23 | FileDelete (Archived) | 文件删除并归档到 `C:\Sysmon` |
| 24 | ClipboardChange | 剪贴板内容变化 |
| 25 | ProcessTampering | 进程篡改检测（hollow/herpaderp） |
| 26 | FileDeleteDetected | 文件删除检测（不保存文件） |
| 27 | FileBlockExecutable | 阻止创建可执行文件（PE 格式） |
| 28 | FileBlockShredding | 阻止文件粉碎操作 |
| 29 | FileExecutableDetected | 检测到新建可执行文件 |
| 255 | Error | Sysmon 错误 |

## 卸载

如需卸载 Sysmon：

```powershell
.\Sysmon64.exe -u
```
