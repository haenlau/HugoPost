+++
author = "haenlau"
title = "Debian Hysteria2 端口跳跃"
url = "/debian-hysteria2-port-hop/"
date = "2026-10-30T07:35:20+00:00"
description = "在 Debian 上使用 nftables 为 3X-UI Hysteria2 配置 UDP 端口跳跃，包含持久化、验证、回滚和故障排查。"
tags = [
  "记录",
]
+++

端口跳跃适合放在 Hysteria2 已经正常监听的节点上单独配置。本文记录 Debian 13 环境中的手工方案：使用 `nftables` 将一段 UDP 端口重定向到 3X-UI 中 Hysteria2 的实际监听端口，并通过 `nftables.service` 保证重启后自动恢复。

示例环境中的 Hysteria2 入站端口为 `14444/udp`，跳跃端口范围为 `30000-40000/udp`。实际部署时，应按自己的入站端口和 Hop Ports 替换变量。

## 1. 工作方式

端口跳跃规则只处理 UDP 端口转换：

```text
UDP 30000-40000 → UDP 14444
```

客户端连接跳跃范围内的任意 UDP 端口后，内核会把流量重定向到本机的 `14444/udp`。Hysteria2 进程仍然只监听实际入站端口，3X-UI 数据库也不需要修改。

这套方法会修改以下系统内容：

- 安装 `nftables` 软件包（如果系统尚未安装）；
- 创建独立的 nftables 表和 NAT 规则；
- 创建 `/etc/nftables.d/hcloudlab-hy2hop.nft`；
- 在 `/etc/nftables.conf` 中加载该目录；
- 启用并重启 `nftables.service`。

不会执行 `nft flush ruleset`，也不会覆盖其他表中的规则。

## 2. 环境检查

先确认系统版本、Hysteria2 监听端口和 nftables 状态：

```bash
. /etc/os-release
printf '%s %s\n' "$ID" "$VERSION_ID"

sudo ss -lunp
command -v nft || true
sudo nft -a list ruleset
```

确认 Hysteria2 的 UDP 监听端口确实存在。例如本次配置使用：

```bash
HY2_PORT=14444
HOP_START=30000
HOP_END=40000
TABLE_NAME=hcloudlab_hy2hop
```

跳跃范围不能包含实际监听端口：

```bash
if [ "$HOP_START" -le "$HY2_PORT" ] && [ "$HY2_PORT" -le "$HOP_END" ]; then
  echo '错误：跳跃端口范围包含实际监听端口'
  exit 1
fi
```

如果已有其他 `DNAT` 或 `redirect` 规则，先确认它们属于哪个服务：

```bash
sudo nft list ruleset | grep -Ei 'dnat|redirect|masquerade'
```

Docker、其他代理程序或已有端口转发规则可能与新的 NAT 规则产生冲突。确认前不要直接覆盖已有规则。

## 3. 安装 nftables

Debian 上执行：

```bash
sudo apt-get update
sudo apt-get install -y nftables
```

确认安装结果：

```bash
command -v nft
sudo systemctl status nftables --no-pager
```

## 4. 创建独立规则文件

创建配置目录：

```bash
sudo install -d -m 0755 /etc/nftables.d
```

写入端口跳跃规则：

```bash
sudo tee /etc/nftables.d/hcloudlab-hy2hop.nft >/dev/null <<EOF
table inet ${TABLE_NAME} {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        udp dport ${HOP_START}-${HOP_END} counter redirect to :${HY2_PORT}
    }
}
EOF

sudo chmod 0644 /etc/nftables.d/hcloudlab-hy2hop.nft
```

文件内容可以直接检查：

```bash
sudo sed -n '1,80p' /etc/nftables.d/hcloudlab-hy2hop.nft
```

规则使用独立的 `inet` 表，能够同时处理 IPv4 和 IPv6 流量。`counter` 用于观察跳跃端口是否收到实际数据包。

## 5. 让 Debian 加载规则文件

部分 Debian 默认的 `/etc/nftables.conf` 只包含基础过滤表，不会自动读取 `/etc/nftables.d/`。先检查：

```bash
sudo grep -nE 'include.*nftables\.d|include' /etc/nftables.conf
```

如果没有输出，追加目录加载语句：

```bash
printf '\ninclude "/etc/nftables.d/*.nft"\n' | sudo tee -a /etc/nftables.conf
```

检查完整配置语法：

```bash
sudo nft -c -f /etc/nftables.conf
```

这一步没有报错后再启用服务：

```bash
sudo systemctl enable nftables
sudo systemctl restart nftables
```

## 6. 验证规则是否生效

查看服务状态：

```bash
sudo systemctl is-enabled nftables
sudo systemctl is-active nftables
```

读取目标表：

```bash
sudo nft list table inet "$TABLE_NAME"
```

正常结果类似：

```text
table inet hcloudlab_hy2hop {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        udp dport 30000-40000 counter packets 0 bytes 0 redirect to :14444
    }
}
```

确认 Hysteria2 仍然监听实际端口：

```bash
sudo ss -lunp | grep -E ':14444([[:space:]]|$)'
```

`nftables` 规则中的计数器初始为 `0` 是正常现象。客户端完成一次连接后，再查看：

```bash
sudo nft list chain inet "$TABLE_NAME" prerouting
```

如果 `packets` 和 `bytes` 增加，说明跳跃端口已经收到流量。

## 7. 云安全组放行

服务器本机没有 UFW 时，仍需在云厂商控制台放行对应 UDP 端口：

```text
UDP 30000-40000
UDP 14444
```

`14444/udp` 是实际监听端口，建议保留放行；`30000-40000/udp` 是客户端连接使用的跳跃范围。只放行服务器本机防火墙而忽略云安全组，外部连接仍然会超时。

如果使用 UFW，则补充：

```bash
sudo ufw allow 30000:40000/udp
sudo ufw allow 14444/udp
sudo ufw status numbered
```

## 8. 客户端端口

客户端节点的端口应填写跳跃范围：

```text
30000-40000
```

具体填写方式取决于客户端实现。有些客户端支持端口范围，有些客户端需要填写范围中的一个端口并配合订阅配置。客户端更新订阅后，使用实际跳跃端口进行连接，再观察服务器端的 nftables 计数器。

## 9. 配置变更

如果要把实际监听端口改为其他值，需要同步修改变量和规则文件。例如：

```bash
HY2_PORT=<new-hysteria2-port>
HOP_START=<new-hop-start>
HOP_END=<new-hop-end>
```

修改 `/etc/nftables.d/hcloudlab-hy2hop.nft` 后，先验证再重载：

```bash
sudo nft -c -f /etc/nftables.conf
sudo systemctl restart nftables
sudo nft list table inet hcloudlab-hy2hop
```

同时检查 3X-UI 中的 Hysteria2 入站已经监听新的实际端口，并在云安全组中同步放行。

## 10. 删除端口跳跃

删除规则文件并重新加载 nftables：

```bash
sudo rm -f /etc/nftables.d/hcloudlab-hy2hop.nft
sudo systemctl restart nftables
```

如果 `/etc/nftables.d/` 中已经没有其他规则，可以删除目录加载语句；如果还有其他配置文件，应保留该语句：

```bash
sudo grep -nE 'include.*nftables\.d|include' /etc/nftables.conf
```

也可以先临时删除目标表：

```bash
sudo nft delete table inet hcloudlab_hy2hop
```

删除后确认：

```bash
sudo nft list ruleset | grep -Ei 'hcloudlab_hy2hop|30000-40000|14444' || true
```

## 11. 常见问题

### 11.1 规则文件存在，但目标表不存在

通常是 `/etc/nftables.conf` 没有加载 `/etc/nftables.d/*.nft`。检查并追加：

```bash
sudo grep -n 'nftables.d' /etc/nftables.conf
```

然后执行：

```bash
sudo nft -c -f /etc/nftables.conf
sudo systemctl restart nftables
```

### 11.2 客户端连接超时

按顺序检查：

```bash
sudo systemctl is-active nftables
sudo nft list table inet hcloudlab_hy2hop
sudo ss -lunp | grep -E ':14444([[:space:]]|$)'
sudo nft list chain inet hcloudlab_hy2hop prerouting
```

重点确认：

- Hysteria2 仍监听实际端口；
- 云安全组放行了整个跳跃范围；
- 客户端使用的是 UDP；
- 客户端配置中的端口范围与服务器规则一致；
- NAT 计数器是否增加。

### 11.3 已有 NAT 规则

不要执行以下危险操作：

```bash
sudo nft flush ruleset
```

它会清空整套 nftables 规则，可能影响 Docker、代理、容器网络和其他服务。应使用独立表，并先确认已有 NAT 规则的归属。

### 11.4 重启后规则消失

检查服务是否启用，以及主配置是否包含目录：

```bash
sudo systemctl is-enabled nftables
sudo grep -n 'nftables.d' /etc/nftables.conf
sudo nft -c -f /etc/nftables.conf
```

## 12. 回退检查清单

- [ ] 删除或停用跳跃规则文件；
- [ ] 重启 `nftables.service`；
- [ ] 确认目标表已经消失；
- [ ] 确认 Hysteria2 实际监听端口仍然存在；
- [ ] 删除云安全组中的跳跃范围放行规则；
- [ ] 客户端恢复使用原始入站端口；
- [ ] 检查其他 nftables 表和业务连接没有受到影响。
