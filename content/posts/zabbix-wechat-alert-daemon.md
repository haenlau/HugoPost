+++
title = "Zabbix 企业微信告警推送服务（wechat-alert）"
date = "2026-04-15"
lastmod = "2026-04-15"
description = "基于 Python 的 Zabbix 告警推送守护进程，适配网闸同步场景，轮询 Zabbix 数据库 alerts 表，通过企业微信 API 实时推送告警到手机。"
url = "/zabbix-wechat-alert-daemon/"
aliases = ["/posts/zabbix-wechat-alert-daemon/"]
draft = false
+++
<h2 id="背景">背景</h2>

<p>生产环境的 Zabbix 服务器处于内网隔离区，无法直接访问互联网，也就无法通过企业微信 API 推送告警。</p>

<p>解决方案：利用网闸将 Zabbix 数据库单向同步到一台可联网的中转服务器，告警推送脚本部署在中转服务器上，只读同步库的 <code>alerts</code> 表，通过企业微信 API 将告警推送到手机。</p>

<h2 id="一服务概述">一、服务概述</h2>

<table><thead><tr><th>项目</th><th>内容</th></tr></thead><tbody><tr><td><strong>服务器</strong></td><td><code>192.168.23.22</code></td></tr><tr><td><strong>操作系统</strong></td><td>Ubuntu Server，内核 6.8.0-85-generic</td></tr><tr><td><strong>服务名</strong></td><td><code>wechat-alert.service</code> (systemd 守护进程)</td></tr><tr><td><strong>脚本路径</strong></td><td><code>/opt/alert/wechat.py</code></td></tr><tr><td><strong>Python 环境</strong></td><td><code>/opt/alert/venv/</code></td></tr><tr><td><strong>运行用户</strong></td><td><code>root</code></td></tr><tr><td><strong>重启策略</strong></td><td><code>Restart=always</code>，失败后 10 秒自动拉起</td></tr><tr><td><strong>已运行时间</strong></td><td>98 天+（自 2026 年 3 月 3 日起）</td></tr></tbody></table>

<h3 id="工作流程">工作流程</h3>

<pre><code class="language-plaintext">┌─────────────────────┐          ┌──────────────────────┐  企业微信 API   ┌──────────────┐
│ Zabbix 数据库       │  网闸同步  │ wechat-alert 服务    │ ────────────►  │ 企业微信      │
│ 192.168.25.52:3306  │ ────────► │ 192.168.23.22       │                │ 手机通知      │
│ alerts 表           │          │ /opt/alert/wechat.py │                └──────────────┘
└─────────────────────┘          └──────────────────────┘</code></pre>

<h2 id="二架构与设计">二、架构与设计</h2>

<h3 id="21-核心机制">2.1 核心机制</h3>

<table><thead><tr><th>机制</th><th>说明</th></tr></thead><tbody><tr><td><strong>纯只读模式</strong></td><td>只 <code>SELECT</code> 不 <code>UPDATE/INSERT</code>，不影响 Zabbix 数据库状态</td></tr><tr><td><strong>增量去重</strong></td><td>基于 <code>alertid</code> 递增标记，内存中记录已处理的最大 ID</td></tr><tr><td><strong>定时轮询</strong></td><td>每 <strong>10 秒</strong> 查询一次 <code>alerts</code> 表</td></tr><tr><td><strong>失败重试</strong></td><td>发送失败会保留 ID，下一轮自动重试</td></tr><tr><td><strong>异常自检</strong></td><td>连续 3 次失败触发「自检告警」通知管理员（冷却 5 分钟）</td></tr><tr><td><strong>自动恢复</strong></td><td>systemd <code>Restart=always</code>，进程崩溃自动拉起</td></tr></tbody></table>

<h3 id="22-去重策略">2.2 去重策略</h3>

<p>基于 <code>alertid</code> 的增量进度标记：内存中记录已处理的最大 ID，查询时只取 <code>alertid &gt; last_processed_id</code> 的新增数据。发送成功才推进标记，失败则保持不动，下一轮自动重试。</p>

<h2 id="三部署配置">三、部署配置</h2>

<h3 id="31-systemd-服务单元">3.1 systemd 服务单元</h3>

<p><strong>路径</strong>: <code>/etc/systemd/system/wechat-alert.service</code></p>

<pre><code class="language-ini">[Unit]
Description=WeChat Alert Daemon for Zabbix
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/alert
ExecStart=/opt/alert/venv/bin/python /opt/alert/wechat.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target</code></pre>

<h3 id="32-服务管理命令">3.2 服务管理命令</h3>

<pre><code class="language-bash"># 查看状态
systemctl status wechat-alert.service

# 查看日志
journalctl -u wechat-alert.service -f

# 重启
systemctl restart wechat-alert.service

# 停止
systemctl stop wechat-alert.service

# 开机自启
systemctl enable wechat-alert.service</code></pre>

<h2 id="四脚本代码">四、脚本代码</h2>

<p>基于 <code>alertid</code> 增量进度标记，不依赖 <code>status</code> 字段，适配网闸同步场景。</p>

<pre><code class="language-python">#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信告警守护进程（纯只读版 - 适配网闸同步场景）
- 仅读取 Zabbix alerts 表
- 不修改数据库任何状态 (No UPDATE/INSERT)
- 基于内存记录最大 alertid 实现去重
- 自身异常时发送自检告警
"""

import time
import json
import urllib.request
import urllib.error
import pymysql
import sys
import os

# ================== 配置区 ==================
# ⚠️ 以下为敏感信息，已模糊处理。实际部署时需替换为你自己的相关信息
CORPID = 'YOUR_CORPID'           # 企业微信 CorpID
CORPSECRET = 'YOUR_CORPSECRET'   # 企业微信应用 Secret
AGENTID = '8'                    # 企业微信应用 AgentID
TOUSER = "YOUR_PHONE"            # 接收人 UserID（手机号）
TOPARTY = "6"                    # 接收部门 ID

DB_CONFIG = {
    'host': 'YOUR_DB_HOST',      # Zabbix 数据库地址（网闸同步后的中转库）
    'port': 3306,
    'user': 'zabbix',
    'password': 'YOUR_DB_PASSWORD',
    'database': 'zabbix',
    'charset': 'utf8mb4',
    'connect_timeout': 10,
    'read_timeout': 10
}

CHECK_INTERVAL = 10              # 轮询间隔（秒）
SELF_ALERT_THRESHOLD = 3         # 连续失败 N 次后发自检告警
SELF_ALERT_COOLDOWN = 300        # 自检告警冷却时间（秒）

# ================== 全局状态 ==================
db_fail_count = 0
token_fail_count = 0
last_self_alert_time = 0

# 内存中记录已处理的最大 alertid
# 初始为 0，程序启动后会立即同步为数据库当前的最大值
last_processed_id = 0

# ================== 工具函数 ==================

def log(msg):
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    print(f"[{timestamp}] {msg}", flush=True)

def send_wechat_message_raw(token, subject, message):
    """底层发送函数（不依赖数据库状态）"""
    url = f'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}'
    payload = {
        "touser": TOUSER,
        "toparty": TOPARTY,
        "msgtype": "text",
        "agentid": int(AGENTID),
        "text": {"content": f"{subject}\n{message}"},
        "safe": 0
    }
    try:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode('utf-8'))
            if result.get('errcode') == 0:
                return True
            else:
                log(f"⚠️ 微信 API 返回错误: {result.get('errmsg')}")
                return False
    except Exception as e:
        log(f"⚠️ 发送请求异常: {e}")
        return False

def get_token_for_self_alert():
    """专用于自检告警的 token 获取（独立重试）"""
    url = f'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={CORPID}&amp;corpsecret={CORPSECRET}'
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('errcode') == 0:
                return data['access_token']
    except Exception:
        pass
    return None

def send_self_alert(reason):
    """发送「告警代理自身异常」通知"""
    global last_self_alert_time
    now = time.time()
    if now - last_self_alert_time &lt; SELF_ALERT_COOLDOWN:
        return

    log(f"🚨 触发自检告警：{reason}")
    token = get_token_for_self_alert()
    if not token:
        log("❌ 自检告警：无法获取 token，放弃发送")
        return

    subject = "【系统告警】微信告警代理异常"
    message = (
        f"主机：{os.uname()[1]}\n"
        f"时间：{time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"原因：{reason}\n"
        f"请立即检查服务状态！"
    )

    if send_wechat_message_raw(token, subject, message):
        log("✅ 自检告警已发送")
        last_self_alert_time = now
    else:
        log("❌ 自检告警发送失败")

# ================== 核心逻辑 ==================

def get_wechat_token():
    global token_fail_count
    url = f'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={CORPID}&amp;corpsecret={CORPSECRET}'
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get('errcode') == 0:
                token_fail_count = 0
                return data['access_token']
            else:
                log(f"❌ 获取 token 失败：{data.get('errmsg')}")
    except Exception as e:
        log(f"💥 获取 token 异常：{e}")

    token_fail_count += 1
    if token_fail_count &gt;= SELF_ALERT_THRESHOLD:
        send_self_alert(f"连续 {token_fail_count} 次无法获取企业微信 token")
    return None

def process_alerts():
    global db_fail_count, last_processed_id

    conn = None
    cursor = None
    try:
        log("🔍 尝试连接数据库...")
        conn = pymysql.connect(**DB_CONFIG)
        cursor = conn.cursor(pymysql.cursors.DictCursor)
        log("✅ 数据库连接成功")
        db_fail_count = 0

        # 初始化：首次运行时同步到数据库当前最大 alertid
        if last_processed_id == 0:
            cursor.execute("SELECT MAX(alertid) as max_id FROM alerts")
            row = cursor.fetchone()
            current_max = row['max_id'] if row and row['max_id'] else 0

            if current_max &gt; 0:
                last_processed_id = current_max
                log(f"🚀 初始化完成：当前数据库最大 alertid 为 {last_processed_id}")
                log(f"   将仅监控 ID &gt; {last_processed_id} 的新增告警")
                return
            else:
                log("⚠️ 数据库中暂无告警数据")
                return

        # 查询新增告警（只查 alertid &gt; last_processed_id 的数据）
        cursor.execute("""
            SELECT alertid, subject, message
            FROM alerts
            WHERE alertid &gt; %s
            ORDER BY alertid ASC
            LIMIT 50
        """, (last_processed_id,))

        alerts = cursor.fetchall()

        if not alerts:
            return

        log(f"📬 发现 {len(alerts)} 条新告警 (ID 范围：{alerts[0]['alertid']} - {alerts[-1]['alertid']})")

        token = get_wechat_token()
        if not token:
            log("⚠️ 无法获取 Token，跳过本次发送")
            return

        success_count = 0
        for alert in alerts:
            alert_id = alert['alertid']
            subject = alert['subject'] or '[无标题]'
            message = alert['message'] or '[无内容]'

            log(f"📤 发送告警 ID={alert_id}: {subject[:30]}...")

            if send_wechat_message_raw(token, subject, message):
                last_processed_id = alert_id
                log(f"✅ 告警 ID={alert_id} 发送成功 (内存标记已更新)")
                success_count += 1
            else:
                log(f"❌ 告警 ID={alert_id} 发送失败，将在下一轮重试")
                break

        log(f"📊 本次处理总结：成功 {success_count}/{len(alerts)}, 内存标记 ID: {last_processed_id}")

    except (pymysql.Error, OSError) as e:
        log(f"💥 数据库错误：{e}")
        db_fail_count += 1
        if db_fail_count &gt;= SELF_ALERT_THRESHOLD:
            send_self_alert(f"连续 {db_fail_count} 次无法连接数据库 {DB_CONFIG['host']}")
    except Exception as e:
        log(f"💥 未知异常：{e}")
        send_self_alert(f"主循环发生未预期异常：{str(e)[:100]}")
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()

# ================== 主循环 ==================
if __name__ == '__main__':
    log("🚀 微信告警守护进程（纯只读版）启动...")
    log(f"📡 监控数据库：{DB_CONFIG['host']}:{DB_CONFIG['port']}/{DB_CONFIG['database']}")
    log(f"⏱️ 轮询间隔：{CHECK_INTERVAL} 秒")
    log(f"🛡️ 模式：只读不写 (基于 alertid 增量去重)")

    while True:
        try:
            process_alerts()
        except KeyboardInterrupt:
            log("🛑 收到中断信号，退出...")
            sys.exit(0)
        except Exception as e:
            log(f"🔥 主循环崩溃：{e}")
            send_self_alert(f"主循环崩溃：{str(e)[:100]}")

        time.sleep(CHECK_INTERVAL)</code></pre>

<h2 id="五运维参考">五、运维参考</h2>

<h3 id="51-文件清单">5.1 文件清单</h3>

<table><thead><tr><th>路径</th><th>说明</th></tr></thead><tbody><tr><td><code>/opt/alert/wechat.py</code></td><td>当前运行的主脚本</td></tr><tr><td><code>/opt/alert/wechat.py.bak</code></td><td>备份（2026-02-28）</td></tr><tr><td><code>/opt/alert/venv/</code></td><td>Python 虚拟环境（含 pymysql）</td></tr><tr><td><code>/etc/systemd/system/wechat-alert.service</code></td><td>systemd 服务单元</td></tr></tbody></table>

<h3 id="52-依赖">5.2 依赖</h3>

<pre><code class="language-bash"># Python 依赖（通过 venv 管理）
pip install pymysql

# 运行时仅需
# - Python 3.x
# - pymysql（连接 MySQL）
# - urllib（标准库，调用企业微信 API）</code></pre>

<h3 id="53-企业微信-api">5.3 企业微信 API</h3>

<table><thead><tr><th>接口</th><th>用途</th></tr></thead><tbody><tr><td><code>GET /cgi-bin/gettoken</code></td><td>获取 access_token</td></tr><tr><td><code>POST /cgi-bin/message/send</code></td><td>发送应用消息</td></tr></tbody></table>
