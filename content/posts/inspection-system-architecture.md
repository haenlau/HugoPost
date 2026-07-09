+++
title = "机房巡检系统架构说明"
date = "2026-06-23"
lastmod = "2026-06-23"
description = "基于 FastAPI + Vue3 的每日值班巡检系统，支持 20 个巡检点数据采集、图片压缩、Word 报告生成及 SMB 共享归档。"
url = "/inspection-system-architecture/"
aliases = ["/posts/inspection-system-architecture/"]
categories = ["运维"]
draft = false
+++
## 系统概述

为生产机房值班监控开发的 B/S 架构巡检系统。核心流程：前端采集 20 个巡检点数据 → 图片压缩 → 生成 Word 报告 → 上传 SMB 共享目录归档。

技术栈：

| 组件 | 技术 |
|------|------|
| 后端 | Python FastAPI |
| 前端 | Vue 3 + Element Plus |
| 数据库 | SQLite |
| 图片处理 | Pillow |
| 文档生成 | python-docx |
| 远程传输 | smbprotocol |
| 部署 | Nginx + Systemd |

## 服务器配置

| 项目 | 值 |
|------|-----|
| IP 地址 | `YOUR_SERVER_IP` |
| 操作系统 | Ubuntu 26.04 LTS |
| Python | 3.14.4 |
| Node.js | 22.23.0 |
| 内存 | 7.2 GB |
| 磁盘 | 62 GB |
| CPU | 4 核 |

访问入口：

| 服务 | 地址 |
|------|------|
| 前端页面 | `http://YOUR_SERVER_IP` |
| API 文档 | `http://YOUR_SERVER_IP/api/docs` |
| 健康检查 | `http://YOUR_SERVER_IP/api/health` |

SMB 共享配置：

| 项目 | 值 |
|------|-----|
| 服务器 | `YOUR_SMB_SERVER` |
| 共享名 | `YOUR_SHARE_NAME` |
| 用户名 | `YOUR_DOMAIN\YOUR_USER` |
| 密码 | `YOUR_PASSWORD` |

## 目录结构

```text
/opt/inspection/
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
└── deploy.sh
```

## 巡检点清单（20 个）

| 序号 | 巡检点名称 | 类型 | 基线范围 |
|------|-----------|------|----------|
| 1 | 办公机房环境 | 温度+湿度 | 温度 18-27℃ / 湿度 35%-60% |
| 2 | 办公机房消防 | 状态 | 无故障灯告警 |
| 3 | Prometheus | 状态 | 运行正常 / 各设备在线 |
| 4 | Zabbix | 状态+流量 | 运行正常 / 各设备流量正常 |
| 5 | 主动威胁欺骗防御系统（谛听） | 状态+数值 | 无新增事件 |
| 6 | 云工作负载保护平台（牧云） | 状态 | 无外部或明显恶意行为 |
| 7 | 官网华为防火墙（6630E） | 状态 | 流量统计 10 Mbps-60 Mbps |
| 8 | 长亭 WEB 应用防火墙（雷池） | 状态+数值 | 无外部或明显恶意行为 |
| 9 | 绿盟 WEB 应用防火墙（WAF） | 状态 | 无外部或明显恶意行为 |
| 10 | 北单外网 TLS 防火墙（6625F） | 数值 | CT 和 CNC 均 0.8 Mbps 左右 |
| 11 | 北单 K8S 负载均衡连接数 | 数值 | - |
| 12 | 北单 TiDB 负载均衡连接数 | 数值 | - |
| 13 | 威胁监测与分析系统（天眼） | 状态 | 无外部或外访恶意行为 |
| 14 | 综合监控大屏 | 状态×3 | 各模块运行正常 |
| 15 | NTP 服务器 | 状态 | 卫星数量正常，时间无偏移 |
| 16 | 生产机房环境 | 温度+湿度 | 温度 18-27℃ / 湿度 35%-60% |
| 17 | 计通监控平台 | 状态 | 无新增事件 |
| 18 | 电池室环境 | 状态 | 无渗漏无异常 |
| 19 | 柴油发电机 | 状态 | 候命中，无漏油 |
| 20 | 生产机房消防 | 状态 | 无故障灯告警 |

字段类型说明：

| 类型 | 说明 | 前端组件 |
|------|------|----------|
| `status` | 正常/异常单选 | Radio.Group |
| `numeric` | 必填数值 | InputNumber |
| `numeric_optional` | 选填数值 | InputNumber |

条件高亮规则：

| 条件 | 效果 |
|------|------|
| 状态异常 | 整行红底 |
| 温湿度异常（超出基线） | 整行黄底 |
| CNC 数量 > 0 | 数值红字 + 二次确认弹窗 |

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/shift-info` | 获取班次信息 |
| GET | `/api/smb-paths` | 获取 SMB 路径选项 |
| POST | `/api/upload-image` | 上传图片 |
| POST | `/api/inspection/submit` | 提交巡检记录 |
| GET | `/api/report/{record_id}` | 下载报告 |
| GET | `/api/inspection/records` | 获取巡检记录列表 |

### 提交巡检请求体示例

```json
{
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
}
```

参数说明：

| 参数 | 说明 |
|------|------|
| `smb_path` | 支持完整 UNC 路径或相对路径 |
| `skip_smb` | 为 `true` 时只生成报告，不上传 SMB |

## 服务管理

### 状态检查

```bash
systemctl status inspection
systemctl status nginx
systemctl is-enabled inspection
```

### 启停操作

```bash
systemctl restart inspection
systemctl stop inspection
systemctl start inspection
```

### 日志查看

```bash
journalctl -u inspection -f
journalctl -u inspection -n 100
tail -f /var/log/nginx/access.log
```

### Systemd 服务配置

```ini
[Unit]
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
WantedBy=multi-user.target
```

## 数据备份与恢复

### 备份数据库

```bash
cp /opt/inspection/backend/data/inspection.db \
  /opt/inspection/backend/data/inspection_$(date +%Y%m%d).db
```

### 备份报告

```bash
tar -czf /tmp/reports_$(date +%Y%m%d).tar.gz /opt/inspection/backend/reports/
```

### 恢复数据库

```bash
systemctl stop inspection
cp /opt/inspection/backend/data/inspection.db.bak /opt/inspection/backend/data/inspection.db
systemctl start inspection
```

## 常见问题排查

**服务无法启动：**

```bash
journalctl -u inspection -n 50     # 查看详细错误
lsof -i :8000                      # 检查端口占用
# 手动启动测试（前台运行，观察报错）
cd /opt/inspection/backend && python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**SMB 上传失败：**

```bash
python3 -c "
import smbclient
smbclient.register_session('YOUR_SMB_SERVER', username='YOUR_DOMAIN\\\\YOUR_USER', password='YOUR_PASSWORD')
print('SMB 连接成功')
"
journalctl -u inspection | grep -i smb
```

**图片上传失败：**

```bash
ls -la /opt/inspection/backend/tmp/   # 检查权限
rm -rf /opt/inspection/backend/tmp/*  # 清理临时文件
df -h /                               # 检查磁盘空间
```

**前端无法访问：**

```bash
nginx -t                              # 检查 Nginx 配置
ls -la /opt/inspection/frontend/dist/ # 检查构建产物
# 重新构建前端
cd /opt/inspection/frontend && npm run build
```

## 部署流程

### 后端更新

```bash
scp -r ./backend/* root@YOUR_SERVER_IP:/opt/inspection/backend/
ssh root@YOUR_SERVER_IP "systemctl restart inspection"
```

### 前端更新

```bash
scp -r ./frontend/* root@YOUR_SERVER_IP:/opt/inspection/frontend/
ssh root@YOUR_SERVER_IP "cd /opt/inspection/frontend && npm run build"
```

### 一键部署脚本

```bash
#!/bin/bash
SERVER="YOUR_SERVER_IP"
USER="root"

echo "=== 1. 上传后端代码 ==="
scp -r ./backend/* $USER@$SERVER:/opt/inspection/backend/

echo "=== 2. 上传前端代码 ==="
scp -r ./frontend/* $USER@$SERVER:/opt/inspection/frontend/

echo "=== 3. 构建前端 ==="
ssh $USER@$SERVER "cd /opt/inspection/frontend && npm run build"

echo "=== 4. 重启服务 ==="
ssh $USER@$SERVER "systemctl restart inspection"

echo "=== 5. 检查状态 ==="
ssh $USER@$SERVER "systemctl status inspection --no-pager | head -5"

echo "=== 部署完成 ==="
```

## 巡检点配置修改

添加新巡检点需要同步修改三个文件：

| 序号 | 文件 | 说明 |
|------|------|------|
| 1 | `backend/app/schemas.py` | Pydantic 模型 + `POINT_DEFINITIONS` |
| 2 | `backend/app/models.py` | SQLAlchemy 数据库模型 |
| 3 | `frontend/src/utils/definitions.js` | 前端定义 |

修改后需要删除旧数据库并重启服务：

```bash
rm /opt/inspection/backend/data/inspection.db
systemctl restart inspection
```

修改基线范围或字段名称：只需改 `schemas.py` 和 `definitions.js` 中对应字段的 `standard` 或 `label` 值。

## Python 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| fastapi | 0.118.0 | Web 框架 |
| uvicorn | latest | ASGI 服务器 |
| sqlalchemy | 2.0.45 | ORM 数据库操作 |
| python-multipart | latest | 文件上传解析 |
| python-docx | 1.2.0 | Word 报告生成 |
| Pillow | 12.1.1 | 图片压缩处理 |
| smbprotocol | 1.16.1 | SMB 共享上传 |
| pydantic | 2.12.5 | 数据校验 |
| pydantic-settings | latest | 配置管理 |
| apscheduler | latest | 定时任务

## 前端依赖

| 依赖 | 版本 |
|------|------|
| Vue | 3.5+ |
| Element Plus | 2.8+ |
| Axios | 1.7+ |
| vuedraggable | 4.1+ |
| SortableJS | 1.15+ |
