+++
title = "Ocserv 跨系统安装配置指南"
date = "2025-12-22"
lastmod = "2026-01-20"
description = "CentOS、Ubuntu系统下Ocserv的安装、SSL证书配置、用户管理及防火墙设置全流程。"
url = "/ocserv-install-config/"
aliases = ["/posts/ocserv-install-config/"]
categories = ["笔记"]
draft = false
+++
## 一、CentOS 7 安装配置
### 1. 安装 EPEL 源和 Ocserv
```bash
# 安装 EPEL 源
yum -y install epel-release
# YUM 安装 Ocserv
yum -y install ocserv
```

### 2. 生成 SSL 证书
```bash
# 创建证书存放目录并进入
mkdir ssl && cd ssl

# 创建 CA 证书模板
cat > ca.tmpl << EOF
cn = "air1.cn"
organization = "air1.cn"
serial = 1
expiration_days = 9999
ca
signing_key
cert_signing_key
crl_signing_key
EOF

# 生成 CA 私钥和证书
certtool --generate-privkey --outfile ca-key.pem
certtool --generate-self-signed --load-privkey ca-key.pem --template ca.tmpl --outfile ca-cert.pem

# 创建服务器证书模板（替换为你的服务器公网IP）
cat > server.tmpl << EOF
cn = "你的服务器IP"
organization = "air1.cn"
expiration_days = 9999
signing_key
encryption_key
tls_www_server
EOF

# 生成服务器私钥和证书
certtool --generate-privkey --outfile server-key.pem
certtool --generate-certificate --load-privkey server-key.pem --load-ca-certificate ca-cert.pem --load-ca-privkey ca-key.pem --template server.tmpl --outfile server-cert.pem

# 移动证书到 Ocserv 默认目录
cp server-cert.pem /etc/pki/ocserv/public/
cp server-key.pem /etc/pki/ocserv/private/
cp ca-cert.pem /etc/pki/ocserv/cacerts/
```

### 3. 配置 Ocserv 主配置文件
编辑配置文件：
```bash
vi /etc/ocserv/ocserv.conf
```

需要修改/调整的配置项：
```ini
# 1. 验证方式改为密码验证
auth = "plain[passwd=/etc/ocserv/ocpasswd]"

# 2. 监听端口（默认443，如有占用可修改）
tcp-port = 443
udp-port = 443

# 3. 连接欢迎信息
banner = "Welcome air1.cn"

# 4. 最大连接数限制
max-clients = 16
max-same-clients = 2

# 5. 服务器证书和私钥路径
server-cert = /etc/pki/ocserv/public/server-cert.pem
server-key = /etc/pki/ocserv/private/server-key.pem

# 6. CA 证书路径
ca-cert = /etc/pki/ocserv/cacerts/ca-cert.pem

# 7. 取消 IPv4 网段注释（启用内网分配）
ipv4-network = 192.168.10.0
ipv4-netmask = 255.255.255.0

# 8. 启用 DNS 并设置公共 DNS
tunnel-all-dns = true
dns = 8.8.8.8
dns = 8.8.4.4
```

### 4. 创建/管理 VPN 用户
```bash
# 创建用户（将 air1 替换为你要使用的用户名）
ocpasswd -c /etc/ocserv/ocpasswd air1
# 删除用户
ocpasswd -c /etc/ocserv/ocpasswd -d air1
```

### 5. 系统网络配置
```bash
# 启用 IPv4 转发
echo 1 > /proc/sys/net/ipv4/ip_forward
# 永久生效（可选）
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf && sysctl -p

# 启动并配置防火墙
systemctl start firewalld.service
# 放行端口（如果修改了端口，替换 443 为自定义端口）
firewall-cmd --permanent --zone=public --add-port=443/tcp
firewall-cmd --permanent --zone=public --add-port=443/udp
# 启用伪装转发（NAT）
firewall-cmd --permanent --add-masquerade
firewall-cmd --permanent --direct --passthrough ipv4 -t nat -A POSTROUTING -o eth0 -j MASQUERADE
# 重新加载防火墙配置
firewall-cmd --reload
```

### 6. 启动并设置开机自启
```bash
# 测试运行（前台模式，可查看日志）
ocserv -f -d 1

# 后台运行并设置开机自启
systemctl enable ocserv
systemctl start ocserv
# 重启服务（配置修改后）
systemctl restart ocserv
```

## 二、Ubuntu 安装配置
### 1. 安装 Ocserv
```bash
# 更新软件源
apt update
# 安装 Ocserv
apt install -y ocserv gnutls-bin
```

### 2. 生成 SSL 证书（与 CentOS 步骤一致）
```bash
# 创建证书目录
mkdir ssl && cd ssl

# 创建 CA 模板
cat > ca.tmpl << EOF
cn = "air1.cn"
organization = "air1.cn"
serial = 1
expiration_days = 9999
ca
signing_key
cert_signing_key
crl_signing_key
EOF

# 生成 CA 证书
certtool --generate-privkey --outfile ca-key.pem
certtool --generate-self-signed --load-privkey ca-key.pem --template ca.tmpl --outfile ca-cert.pem

# 创建服务器证书模板（替换为服务器IP）
cat > server.tmpl << EOF
cn = "你的服务器IP"
organization = "air1.cn"
expiration_days = 9999
signing_key
encryption_key
tls_www_server
EOF

# 生成服务器证书
certtool --generate-privkey --outfile server-key.pem
certtool --generate-certificate --load-privkey server-key.pem --load-ca-certificate ca-cert.pem --load-ca-privkey ca-key.pem --template server.tmpl --outfile server-cert.pem

# 移动证书到 Ubuntu 下的 Ocserv 目录
mkdir -p /etc/ocserv/certs
cp server-cert.pem /etc/ocserv/certs/
cp server-key.pem /etc/ocserv/certs/
cp ca-cert.pem /etc/ocserv/certs/
```

### 3. 配置 Ocserv 主配置文件
Ubuntu 下配置文件路径为 `/etc/ocserv/ocserv.conf`，编辑配置：
```bash
vi /etc/ocserv/ocserv.conf
```

核心配置项调整（与 CentOS 一致，仅证书路径需适配）：
```ini
# 验证方式
auth = "plain[passwd=/etc/ocserv/ocpasswd]"

# 监听端口
tcp-port = 443
udp-port = 443

# 证书路径（Ubuntu 路径适配）
server-cert = /etc/ocserv/certs/server-cert.pem
server-key = /etc/ocserv/certs/server-key.pem
ca-cert = /etc/ocserv/certs/ca-cert.pem

# 其他配置（同 CentOS）
banner = "Welcome air1.cn"
max-clients = 16
max-same-clients = 2
ipv4-network = 192.168.10.0
ipv4-netmask = 255.255.255.0
tunnel-all-dns = true
dns = 8.8.8.8
dns = 8.8.4.4
```

### 4. 创建 VPN 用户（同 CentOS）
```bash
ocpasswd -c /etc/ocserv/ocpasswd air1
```

### 5. 系统网络配置
```bash
# 启用 IPv4 转发
echo 1 > /proc/sys/net/ipv4/ip_forward
# 永久生效
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.conf && sysctl -p

# Ubuntu 防火墙配置（UFW）
# 放行端口
ufw allow 443/tcp
ufw allow 443/udp
# 启用 NAT 转发（需先安装 iptables）
apt install -y iptables
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
# 保存 iptables 规则（永久生效）
iptables-save > /etc/iptables/rules.v4
```

### 6. 启动并设置开机自启
```bash
# 测试运行
ocserv -f -d 1

# 后台运行
systemctl enable ocserv
systemctl start ocserv
systemctl restart ocserv
```

## 三、常见问题

| 问题 | 处理建议 |
|------|----------|
| 端口占用 | 若 443 端口被 Nginx / Apache 占用，可将 `tcp-port` / `udp-port` 改为其他端口（如 4433），并同步更新防火墙规则。 |
| 网卡名称不一致 | Ubuntu / CentOS 的网卡名称可能为 `ens33`、`eth0` 等，先用 `ip addr` 确认实际网卡名。 |
| 证书生成失败 | 确保已安装 `gnutls-bin`（Ubuntu）或 `gnutls-utils`（CentOS）。 |

### 总结
1. **CentOS** 依赖 EPEL 源安装 Ocserv，证书默认存放路径为 `/etc/pki/ocserv/`，防火墙使用 firewalld；
2. **Ubuntu** 直接通过 apt 安装，证书需手动创建目录 `/etc/ocserv/certs/`，防火墙默认使用 UFW，需配置 iptables 实现 NAT 转发；
3. 核心配置项（认证方式、端口、DNS、证书路径）在两个系统中基本一致，仅需适配证书存放路径和防火墙命令。
