+++
title = "B/S架构机房巡检系统技术文档"
date = "2026-06-23"
lastmod = "2026-06-23"
description = "基于 FastAPI + Vue3 的每日值班巡检系统，支持 20 个巡检点数据采集、图片压缩、Word 报告生成及 SMB 共享归档。"
url = "/inspection-system-architecture/"
aliases = ["/posts/inspection-system-architecture/"]
draft = false
+++
<h2 id="系统概述">系统概述</h2>

<p>为生产机房值班监控开发的 B/S 架构巡检系统。核心流程：前端采集 20 个巡检点数据 → 图片压缩 → 生成 Word 报告 → 上传 SMB 共享目录归档。</p>

<p>技术栈：</p>

<table><thead><tr><th>组件</th><th>技术</th></tr></thead><tbody><tr><td>后端</td><td>Python FastAPI</td></tr><tr><td>前端</td><td>Vue 3 + Element Plus</td></tr><tr><td>数据库</td><td>SQLite</td></tr><tr><td>图片处理</td><td>Pillow</td></tr><tr><td>文档生成</td><td>python-docx</td></tr><tr><td>远程传输</td><td>smbprotocol</td></tr><tr><td>部署</td><td>Nginx + Systemd</td></tr></tbody></table>

<h2 id="服务器配置">服务器配置</h2>

<table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody><tr><td>IP 地址</td><td><code>YOUR_SERVER_IP</code></td></tr><tr><td>操作系统</td><td>Ubuntu 26.04 LTS</td></tr><tr><td>Python</td><td>3.14.4</td></tr><tr><td>Node.js</td><td>22.23.0</td></tr><tr><td>内存</td><td>7.2 GB</td></tr><tr><td>磁盘</td><td>62 GB</td></tr><tr><td>CPU</td><td>4 核</td></tr></tbody></table>

<p>访问入口：</p>

<table><thead><tr><th>服务</th><th>地址</th></tr></thead><tbody><tr><td>前端页面</td><td><code>http://YOUR_SERVER_IP</code></td></tr><tr><td>API 文档</td><td><code>http://YOUR_SERVER_IP/api/docs</code></td></tr><tr><td>健康检查</td><td><code>http://YOUR_SERVER_IP/api/health</code></td></tr></tbody></table>

<p>SMB 共享配置：</p>

<table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody><tr><td>服务器</td><td><code>YOUR_SMB_SERVER</code></td></tr><tr><td>共享名</td><td><code>YOUR_SHARE_NAME</code></td></tr><tr><td>用户名</td><td><code>YOUR_DOMAIN\YOUR_USER</code></td></tr><tr><td>密码</td><td><code>YOUR_PASSWORD</code></td></tr></tbody></table>

<h2 id="目录结构">目录结构</h2>

<pre><code class="language-text">/opt/inspection/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI 入口
│   │   ├── config.py            # 配置
│   │   ├── database.py          # 数据库连接
│   │   ├── models.py            # SQLAlchemy 模型
│   │   ├── schemas.py           # Pydantic 模型（20 个巡检点定义）
│   │   ├── api/
│   │   │   ├── shift.py         # 班次信息接口
│   │   │   ├── inspection.py    # 提交/查询接口
│   │   │   └── upload.py        # 图片上传接口
│   │   └── services/
│   │       ├── image_processor.py   # Pillow 图片压缩
│   │       ├── report_generator.py  # Word 报告生成
│   │       ├── smb_writer.py        # SMB 写入
│   │       └── cleanup.py           # 临时文件清理
│   ├── data/        # SQLite 数据库
│   ├── reports/     # 生成的报告
│   ├── tmp/         # 临时文件（图片）
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.vue              # 主页面
│   │   ├── main.js              # 入口
│   │   └── utils/
│   │       ├── api.js           # API 调用
│   │       └── definitions.js   # 巡检点定义
│   ├── dist/        # 构建产物
│   ├── package.json
│   └── vite.config.js
└── deploy.sh</code></pre>

<h2 id="巡检点清单20-个">巡检点清单（20 个）</h2>

<table><thead><tr><th>序号</th><th>巡检点名称</th><th>类型</th><th>基线范围</th></tr></thead><tbody><tr><td>1</td><td>办公机房环境</td><td>温度+湿度</td><td>温度 18-27℃ / 湿度 35%-60%</td></tr><tr><td>2</td><td>办公机房消防</td><td>状态</td><td>无故障灯告警</td></tr><tr><td>3</td><td>Prometheus</td><td>状态</td><td>运行正常 / 各设备在线</td></tr><tr><td>4</td><td>Zabbix</td><td>状态+流量</td><td>运行正常 / 各设备流量正常</td></tr><tr><td>5</td><td>主动威胁欺骗防御系统（谛听）</td><td>状态+数值</td><td>无新增事件</td></tr><tr><td>6</td><td>云工作负载保护平台（牧云）</td><td>状态</td><td>无外部或明显恶意行为</td></tr><tr><td>7</td><td>官网华为防火墙（6630E）</td><td>状态</td><td>流量统计 10 Mbps-60 Mbps</td></tr><tr><td>8</td><td>长亭 WEB 应用防火墙（雷池）</td><td>状态+数值</td><td>无外部或明显恶意行为</td></tr><tr><td>9</td><td>绿盟 WEB 应用防火墙（WAF）</td><td>状态</td><td>无外部或明显恶意行为</td></tr><tr><td>10</td><td>北单外网 TLS 防火墙（6625F）</td><td>数值</td><td>CT 和 CNC 均 0.8 Mbps 左右</td></tr><tr><td>11</td><td>北单 K8S 负载均衡连接数</td><td>数值</td><td>-</td></tr><tr><td>12</td><td>北单 TiDB 负载均衡连接数</td><td>数值</td><td>-</td></tr><tr><td>13</td><td>威胁监测与分析系统（天眼）</td><td>状态</td><td>无外部或外访恶意行为</td></tr><tr><td>14</td><td>综合监控大屏</td><td>状态×3</td><td>各模块运行正常</td></tr><tr><td>15</td><td>NTP 服务器</td><td>状态</td><td>卫星数量正常，时间无偏移</td></tr><tr><td>16</td><td>生产机房环境</td><td>温度+湿度</td><td>温度 18-27℃ / 湿度 35%-60%</td></tr><tr><td>17</td><td>计通监控平台</td><td>状态</td><td>无新增事件</td></tr><tr><td>18</td><td>电池室环境</td><td>状态</td><td>无渗漏无异常</td></tr><tr><td>19</td><td>柴油发电机</td><td>状态</td><td>候命中，无漏油</td></tr><tr><td>20</td><td>生产机房消防</td><td>状态</td><td>无故障灯告警</td></tr></tbody></table>

<p>字段类型说明：</p>

<table><thead><tr><th>类型</th><th>说明</th><th>前端组件</th></tr></thead><tbody><tr><td><code>status</code></td><td>正常/异常单选</td><td>Radio.Group</td></tr><tr><td><code>numeric</code></td><td>必填数值</td><td>InputNumber</td></tr><tr><td><code>numeric_optional</code></td><td>选填数值</td><td>InputNumber</td></tr></tbody></table>

<p>条件高亮规则：</p>

<table><thead><tr><th>条件</th><th>效果</th></tr></thead><tbody><tr><td>状态异常</td><td>整行红底</td></tr><tr><td>温湿度异常（超出基线）</td><td>整行黄底</td></tr><tr><td>CNC 数量 &gt; 0</td><td>数值红字 + 二次确认弹窗</td></tr></tbody></table>

<h2 id="api-接口">API 接口</h2>

<table><thead><tr><th>方法</th><th>路径</th><th>说明</th></tr></thead><tbody><tr><td>GET</td><td><code>/api/health</code></td><td>健康检查</td></tr><tr><td>GET</td><td><code>/api/shift-info</code></td><td>获取班次信息</td></tr><tr><td>GET</td><td><code>/api/smb-paths</code></td><td>获取 SMB 路径选项</td></tr><tr><td>POST</td><td><code>/api/upload-image</code></td><td>上传图片</td></tr><tr><td>POST</td><td><code>/api/inspection/submit</code></td><td>提交巡检记录</td></tr><tr><td>GET</td><td><code>/api/report/{record_id}</code></td><td>下载报告</td></tr><tr><td>GET</td><td><code>/api/inspection/records</code></td><td>获取巡检记录列表</td></tr></tbody></table>

<h3 id="提交巡检请求体示例">提交巡检请求体示例</h3>

<pre><code class="language-json">{
  "record_date": "2026-06-23",
  "shift": "morning",
  "inspector_name": "YOUR_NAME",
  "points": {
    "p01_office_env": {"temp_status": "normal", "humidity_status": "normal"},
    "p02_office_fire": {"status": "normal"}
  },
  "remarks": {
    "p02_office_fire": "消防设备正常"
  },
  "image_temp_paths": {
    "p01_office_env": ["/tmp/xxx/yyy.jpg"]
  },
  "smb_path": "\\\\YOUR_SMB_SERVER\\YOUR_SHARE_NAME\\YOUR_NAME",
  "skip_smb": false
}</code></pre>

<p>参数说明：</p>

<table><thead><tr><th>参数</th><th>说明</th></tr></thead><tbody><tr><td><code>smb_path</code></td><td>支持完整 UNC 路径或相对路径</td></tr><tr><td><code>skip_smb</code></td><td>为 <code>true</code> 时只生成报告，不上传 SMB</td></tr></tbody></table>

<h2 id="服务管理">服务管理</h2>

<table><thead><tr><th>操作类别</th><th>命令</th><th>说明</th></tr></thead><tbody><tr><td>状态检查</td><td><code>systemctl status inspection</code></td><td>检查后端服务状态</td></tr><tr><td></td><td><code>systemctl status nginx</code></td><td>检查 Nginx 状态</td></tr><tr><td></td><td><code>systemctl is-enabled inspection</code></td><td>检查是否开机自启</td></tr><tr><td>启停操作</td><td><code>systemctl restart/stop/start inspection</code></td><td>重启/停止/启动后端</td></tr><tr><td>查看日志</td><td><code>journalctl -u inspection -f</code></td><td>实时跟踪后端日志</td></tr><tr><td></td><td><code>journalctl -u inspection -n 100</code></td><td>查看最近 100 行</td></tr><tr><td></td><td><code>tail -f /var/log/nginx/access.log</code></td><td>实时跟踪 Nginx 日志</td></tr></tbody></table>

<h3 id="systemd-服务配置">Systemd 服务配置</h3>

<pre><code class="language-ini">[Unit]
Description=Inspection System Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/inspection/backend
ExecStart=/usr/bin/python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target</code></pre>

<h2 id="数据备份与恢复">数据备份与恢复</h2>

<table><thead><tr><th>操作</th><th>命令</th></tr></thead><tbody><tr><td>备份数据库</td><td><code>cp /opt/inspection/backend/data/inspection.db /opt/inspection/backend/data/inspection_\$(date +%Y%m%d).db</code></td></tr><tr><td>备份报告</td><td><code>tar -czf /tmp/reports_\$(date +%Y%m%d).tar.gz /opt/inspection/backend/reports/</code></td></tr><tr><td>恢复数据库</td><td><code>systemctl stop inspection &amp;&amp; cp /opt/inspection/backend/data/inspection.db.bak /opt/inspection/backend/data/inspection.db &amp;&amp; systemctl start inspection</code></td></tr></tbody></table>

<h2 id="常见问题排查">常见问题排查</h2>

<p><strong>服务无法启动：</strong></p>

<pre><code class="language-bash">journalctl -u inspection -n 50     # 查看详细错误
lsof -i :8000                      # 检查端口占用
# 手动启动测试（前台运行，观察报错）
cd /opt/inspection/backend &amp;&amp; python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000</code></pre>

<p><strong>SMB 上传失败：</strong></p>

<pre><code class="language-bash">python3 -c "
import smbclient
smbclient.register_session('YOUR_SMB_SERVER', username='YOUR_DOMAIN\\\\YOUR_USER', password='YOUR_PASSWORD')
print('SMB 连接成功')
"
journalctl -u inspection | grep -i smb</code></pre>

<p><strong>图片上传失败：</strong></p>

<pre><code class="language-bash">ls -la /opt/inspection/backend/tmp/   # 检查权限
rm -rf /opt/inspection/backend/tmp/*  # 清理临时文件
df -h /                               # 检查磁盘空间</code></pre>

<p><strong>前端无法访问：</strong></p>

<pre><code class="language-bash">nginx -t                              # 检查 Nginx 配置
ls -la /opt/inspection/frontend/dist/ # 检查构建产物
# 重新构建前端
cd /opt/inspection/frontend &amp;&amp; npm run build</code></pre>

<h2 id="部署流程">部署流程</h2>

<table><thead><tr><th>部署类型</th><th>操作</th></tr></thead><tbody><tr><td>后端更新</td><td><code>scp -r ./backend/* root@YOUR_SERVER_IP:/opt/inspection/backend/ &amp;&amp; ssh root@YOUR_SERVER_IP "systemctl restart inspection"</code></td></tr><tr><td>前端更新</td><td><code>scp -r ./frontend/* root@YOUR_SERVER_IP:/opt/inspection/frontend/ &amp;&amp; ssh root@YOUR_SERVER_IP "cd /opt/inspection/frontend &amp;&amp; npm run build"</code></td></tr></tbody></table>

<h3 id="一键部署脚本">一键部署脚本</h3>

<pre><code class="language-bash">#!/bin/bash
SERVER="YOUR_SERVER_IP"
USER="root"

echo "=== 1. 上传后端代码 ==="
scp -r ./backend/* $USER@$SERVER:/opt/inspection/backend/

echo "=== 2. 上传前端代码 ==="
scp -r ./frontend/* $USER@$SERVER:/opt/inspection/frontend/

echo "=== 3. 构建前端 ==="
ssh $USER@$SERVER "cd /opt/inspection/frontend &amp;&amp; npm run build"

echo "=== 4. 重启服务 ==="
ssh $USER@$SERVER "systemctl restart inspection"

echo "=== 5. 检查状态 ==="
ssh $USER@$SERVER "systemctl status inspection --no-pager | head -5"

echo "=== 部署完成 ==="</code></pre>

<h2 id="巡检点配置修改">巡检点配置修改</h2>

<p>添加新巡检点需要同步修改三个文件：</p>

<table><thead><tr><th>序号</th><th>文件</th><th>说明</th></tr></thead><tbody><tr><td>1</td><td><code>backend/app/schemas.py</code></td><td>Pydantic 模型 + <code>POINT_DEFINITIONS</code></td></tr><tr><td>2</td><td><code>backend/app/models.py</code></td><td>SQLAlchemy 数据库模型</td></tr><tr><td>3</td><td><code>frontend/src/utils/definitions.js</code></td><td>前端定义</td></tr></tbody></table>

<p>修改后需要删除旧数据库并重启服务：</p>

<pre><code class="language-bash">rm /opt/inspection/backend/data/inspection.db
systemctl restart inspection</code></pre>

<p>修改基线范围或字段名称：只需改 <code>schemas.py</code> 和 <code>definitions.js</code> 中对应字段的 <code>standard</code> 或 <code>label</code> 值。</p>

<h2 id="python-依赖">Python 依赖</h2>

<table><thead><tr><th>依赖</th><th>版本</th><th>用途</th></tr></thead><tbody><tr><td>fastapi</td><td>0.118.0</td><td>Web 框架</td></tr><tr><td>uvicorn</td><td>latest</td><td>ASGI 服务器</td></tr><tr><td>sqlalchemy</td><td>2.0.45</td><td>ORM 数据库操作</td></tr><tr><td>python-multipart</td><td>latest</td><td>文件上传解析</td></tr><tr><td>python-docx</td><td>1.2.0</td><td>Word 报告生成</td></tr><tr><td>Pillow</td><td>12.1.1</td><td>图片压缩处理</td></tr><tr><td>smbprotocol</td><td>1.16.1</td><td>SMB 共享上传</td></tr><tr><td>pydantic</td><td>2.12.5</td><td>数据校验</td></tr><tr><td>pydantic-settings</td><td>latest</td><td>配置管理</td></tr><tr><td>apscheduler</td><td>latest</td><td>定时任务</td></tr></tbody></table>

<h2 id="前端依赖">前端依赖</h2>

<table><thead><tr><th>依赖</th><th>版本</th></tr></thead><tbody><tr><td>Vue</td><td>3.5+</td></tr><tr><td>Element Plus</td><td>2.8+</td></tr><tr><td>Axios</td><td>1.7+</td></tr><tr><td>vuedraggable</td><td>4.1+</td></tr><tr><td>SortableJS</td><td>1.15+</td></tr></tbody></table>
