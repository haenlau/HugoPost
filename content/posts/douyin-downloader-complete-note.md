+++
author = "haenlau"
title = "Douyin Downloader 完整技术笔记"
url = "/douyin-downloader-complete-note/"
date = "2026-10-20"
description = "抖音视频下载服务的实现原理、完整源码、部署配置、API 接口与运维验证记录。"
tags = [
  "记录",
]
+++

> **抖音无水印视频下载服务 —— 原理、全部源码、部署方法、ttwid 申请方法**
>
> 版本:2026-10 验证版 · 语言:Python 3.7–3.12 兼容 · 依赖:fastapi / uvicorn / httpx / playwright(可选)
>
> 一句话:贴入任意抖音分享链接(或整段分享文案/裸视频 ID)→ 服务返回**无水印、最高清晰度**的原视频文件。
> 纯 HTTP 主链路(无需浏览器)+ 无头浏览器兜底层;带 API Key 鉴权、nginx 反代、systemd 服务化。

---

## 目录

1. [项目概述](#1-项目概述)
2. [核心原理:数据是怎么拿到的](#2-核心原理数据是怎么拿到的)
3. [ttwid 申请方法(重点)](#3-ttwid-申请方法重点)
4. [无水印最高清 URL 规则](#4-无水印最高清-url-规则)
5. [完整源码](#5-完整源码)
   - 5.1 项目结构 / 5.2 requirements.txt / 5.3 dy/config.py / 5.4 dy/core.py / 5.5 dy/browser.py / 5.6 dy/__init__.py / 5.7 app.py / 5.8 deploy/ 三件套 / 5.9 Dockerfile + docker-compose.yml
6. [部署方法](#6-部署方法)
7. [API 文档](#7-api-文档)
8. [实测验证结果](#8-实测验证结果)
9. [运维与故障排查](#9-运维与故障排查)

---

## 1. 项目概述

### 1.1 它做什么

输入(三选一,自动识别):

- 短链 `https://v.douyin.com/xxxxx/`
- 整段分享文案:`4.66 复制打开抖音,看看【xxx的作品】标题… https://v.douyin.com/xxxxx/ Abc:/`
- 桌面链接 `https://www.douyin.com/video/<19位ID>` 或裸 ID `7687202250602976234`

输出:

- 视频:直接下载 MP4(无水印、源视频最高清晰度;平台上限一般 1080p)
- 图集:打包成 ZIP(原图)
- 元数据 JSON:标题 / 作者 / 时长 / 分辨率 / 点赞数 / 可直接使用的 CDN 链接

### 1.2 架构

```
                        ┌────────────────────────────────────────────────┐
  分享链接 ───────────► │  FastAPI 服务 (app.py, 127.0.0.1:8931)         │
  (UI / curl / API)     │                                                │
                        │  /api/*  ◄── API Key 鉴权 (X-Api-Key / ?key=)  │
                        └──────┬───────────────────────────┬─────────────┘
                               │                           │
                    ┌──────────▼──────────┐     ┌──────────▼──────────────┐
                    │ HTTP 主链路 (core)  │     │ 浏览器兜底层 (browser)  │
                    │                    │     │ playwright + chromium   │
                    │ 1. 申请/复用 ttwid │     │ 专用 worker 线程        │
                    │ 2. 分享页 SSR 取数 │     │ 预置 ttwid cookie      │
                    │ 3. CDN 直链下载    │     │ 读 DOM / 抓 iteminfo   │
                    └──────────┬──────────┘     └──────────┬──────────────┘
                               │                           │
        ttwid.bytedance.com ───┤                           ├── iesdouyin.com
        www.iesdouyin.com ─────┘                           └── aweme.snssdk.com → douyinvod CDN
```

- **双层抓取**:HTTP 层 ~2 秒出结果;浏览器层 ~10 秒兜底(仅 HTTP 层拿不到数据时触发)。
- **代理分流安全**:所有出站连接 `trust_env=False`,绝不继承环境变量里的代理;只有显式的
  `DOUYIN_PROXY` 配置才会走代理 —— 和 xray 共存互不干扰。
- **部署形态**:systemd 服务 + nginx 反代 28080(或 Docker)。国内/国外服务器均可,直连即可。

### 1.3 关键验证结论(2026-10,全部实测)

| 事实 | 验证方式 |
|---|---|
| 分享页 SSR 数据(`videoInfoRes`)**必须带真实 ttwid** 才返回;假 ttwid(同格式)无效 | A/B 对照:无 cookie/假 ttwid/其他 cookie → 无数据;真 ttwid → 有数据 |
| ttwid 由 ByteDance 服务端签发,末段是服务端哈希,**本地不可伪造** | 对比 set-cookie 内容与自造值 |
| 真 ttwid + 分享页 SSR,从**北京直连**与**境外(日本)IP** 均可取到数据 | 两种出口各跑通完整下载 |
| 无水印视频使用 `/aweme/v1/play/`;带水印视频使用 `/aweme/v1/playwm/`;`ratio=1080p` 取最高档,源 720p 时自动降级 | 对照下载 play/playwm 文件 |
| CDN 跳转 302 → `*.douyinvod.com`,国内外均可直连下载 | 两种出口 md5 完全一致 |
| URL 中的 `logo_name` 参数必须剥掉,否则可能叠加 logo | 对照 md5 |
| 样例视频真实结果:**1920×1080 H.264、28.9s、13,339,408 字节、无水印** | MP4 box 解析 + 双出口字节一致 |

---

## 2. 核心原理:数据是怎么拿到的

### 2.1 请求链路

1. **短链解析**:`v.douyin.com/xxx` → 302(或 HTML `<a href>` 跳转页)→
   `https://www.iesdouyin.com/share/video/<aweme_id>/?region=CN&mid=...&did=...&...`
2. **ttwid**:首次运行向 `ttwid.bytedance.com` 注册一个 ttwid cookie(§3),缓存到
   `$TMP_DIR/.ttwid`,一年复用一次注册。
3. **取元数据**:`GET` 分享页,请求头带 `Cookie: ttwid=<token>`。
   页面 HTML 中内嵌 `window._ROUTER_DATA = {...}`,其中
   `loaderData["video_(id)/page"].videoInfoRes.item_list[0]` 就是完整视频元数据。
4. **构造无水印直链**(§4),302 跟随到 CDN,流式下载到磁盘;多个候选 URL 按
   (HTTP 200/206 + `ftyp` MP4 魔数)探测,**保留最大的合法文件**。

### 2.2 为什么以前的做法都不行(踩坑记录)

| 尝试 | 结果 |
|---|---|
| 分享页裸 GET(无 cookie) | 页面能渲染但 `videoInfoRes` **缺失**(SSR 不给数据) |
| 直接调 `/web/api/v2/aweme/iteminfo/` | 无签名 → 空 body 或 `{"status_code":11110,"status_msg":"encrypt_data_miss"}` |
| 复刻 iteminfo 完整参数 | 仍 11110 —— 真正要的是 bdms SDK 生成的 `msToken` + `a_bogus` 动态签名 |
| 无头浏览器跑页面 JS | 页面只发 `post/`(带签名)不发 `iteminfo`,渲染"请尝试在抖音内观看" |
| **ttwid cookie + 分享页 SSR** | ✅ 一次拿全,无需任何 JS 签名 —— **最终方案** |

> 页面里真正的签名器是 `_SdkGlueInit` 配置的 **bdms SDK**(
> `bdms.NVI6Q9.js`,匹配 `/aweme/v1`、`/aweme/v2`、`/web/api` 路径,给请求加
> `msToken`+`a_bogus`),外加 secsdk 行为指纹采集。绕开整条签名链的最短路径就是
> 让服务端替你渲染 —— ttwid 正是那把钥匙。

### 2.3 元数据里关键字段

```jsonc
{
  "aweme_id": "7687202250602976234",
  "desc": "一曲佳人伴孤灯,愿听完的人万事渐顺 …",
  "author": { "nickname": "应瑾笛箫", "unique_id": "dabuliufenqi" },
  "statistics": { "digg_count": 105080 },
  "video": {
    "duration": 28908,                 // ms
    "width": 1920, "height": 1080,
    "play_addr": {
      "uri": "v0300fg10000dan6pbfog65rus09c6g0",   // ← CDN 视频 ID(核心)
      "url_list": ["https://aweme.snssdk.com/aweme/v1/playwm/?line=0&logo_name=aweme_diversion_search&ratio=720p&video_id=v0300..."]
    },
    "bit_rate": [ /* 网页 detail API 才有的多码率列表 */ ]
  },
  "images": [ /* 图集帖才有 */ ]
}
```

---

## 3. ttwid 申请方法(重点)

### 3.1 接口

```
POST https://ttwid.bytedance.com/ttwid/union/register/
Content-Type: application/json

{
  "region": "cn",
  "aid": 1768,
  "needFid": false,
  "service": "www.douyin.com",
  "migrate_info": { "ticket": "", "source": "node" },
  "cbUrlProtocol": "https",
  "union": true
}
```

响应(HTTP 200):

```
set-cookie: ttwid=1%7CmJkjlOvqbBKz...%7C1792474515%7C06d3905a985a...;
            Path=/; Domain=bytedance.com; Max-Age=31536000; HttpOnly; Secure

{"status_code":0,"message":"union register success","redirect_url":"..."}
```

要点:

- **必须 JSON POST**。`application/x-www-form-urlencoded` 会返回
  `{"status_code":1001,"message":"parse params fail"}`。
- cookie 值是 **URL 编码**的,取出来要 `unquote`(`%7C` → `|`)。
- 令牌格式 `1 | <30位随机> | <unix时间戳> | <sha256>` —— 末段是**服务端哈希**,
  本地无法伪造(自造同格式令牌 → 页面不给数据)。
- `Max-Age=31536000` ≈ 1 年:注册一次,长期复用。
- 该接口对国内外 IP 均可达、无需登录;就是抖音官方前端在新浏览器上引导
  ttwid 的同一接口。

### 3.2 最小可运行示例(Python)

```python
import json, re
from urllib.parse import unquote
import httpx

def register_ttwid(proxy: str | None = None) -> str | None:
    body = {
        "region": "cn", "aid": 1768, "needFid": False,
        "service": "www.douyin.com",
        "migrate_info": {"ticket": "", "source": "node"},
        "cbUrlProtocol": "https", "union": True,
    }
    kwargs = {}
    if proxy:
        kwargs["proxies"] = {"http://": proxy, "https://": proxy}  # httpx<0.27; >=0.27 用 proxy=
    r = httpx.post(
        "https://ttwid.bytedance.com/ttwid/union/register/",
        json=body,
        headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) "
                               "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 "
                               "Mobile/15E148 Safari/604.1"},
        timeout=30, trust_env=False, **kwargs,
    )
    m = re.search(r"ttwid=([^;]+)", r.headers.get("set-cookie", ""))
    return unquote(m.group(1)) if m else None

ttwid = register_ttwid()
print(ttwid)   # 1|IfLTQStOIWS7ulSy_qkyJ2...|1792473323|09dd11e70d57...

# 用法:请求分享页时带上
html = httpx.get(
    f"https://www.iesdouyin.com/share/video/7687202250602976234/",
    headers={"Cookie": f"ttwid={ttwid}",
             "User-Agent": "Mozilla/5.0 (iPhone; ... )"},
    trust_env=False,
).text
# 此时 html 里的 window._ROUTER_DATA 包含完整 videoInfoRes
```

curl 版:

```bash
curl -s -D - -o /dev/null   -X POST "https://ttwid.bytedance.com/ttwid/union/register/"   -H 'Content-Type: application/json'   -d '{"region":"cn","aid":1768,"needFid":false,"service":"www.douyin.com",
       "migrate_info":{"ticket":"","source":"node"},"cbUrlProtocol":"https","union":true}'   | grep -i '^set-cookie'
```

### 3.3 服务里的 ttwid 生命周期

1. `get_ttwid()` 先读 `$TMP_DIR/.ttwid`(文件缓存,跨重启复用)。
2. 没有则 `register_ttwid()` 注册并写缓存。
3. 若某次分享页没取到数据,`fetch_item_http()` 会**重新注册一个 ttwid 再重试一次**
   (防御 token 过期/被风控)。
4. 浏览器兜底层会把同一 ttwid 预置到 cookie 上下文
   (`.iesdouyin.com` / `.douyin.com` / `.bytedance.com` / `.snssdk.com` 四个域)。

---

## 4. 无水印最高清 URL 规则

给定元数据里的 `video.play_addr.uri`(形如 `v0300fg10000dan6pbfog65rus09c6g0`):

```
https://aweme.snssdk.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0
```

规则(全部实测):

| 要素 | 说明 |
|---|---|
| `play` vs `playwm` | `/aweme/v1/play/` = **无水印** 干净版;`/aweme/v1/playwm/` = 带水印版(同分辨率下水印版文件更大) |
| `ratio=1080p` | 要最高档;源没有 1080p 时该 URL 返回 404 → 必须回退(用元数据里列出的 ratio,如 720p,再回退到不带 ratio 的默认档) |
| `logo_name=...` | **剥掉**。url_list 里自带 `logo_name=aweme_diversion_search` 等,保留可能叠加 logo |
| 302 跳转 | 播放端点 302 → `*.douyinvod.com`(真实 CDN),httpx 自动跟随;CDN 国内外直连均可 |
| 合法性校验 | 探测用 `Range: bytes=0-65535`,要求 HTTP 200/206 且字节 4-8 为 `ftyp`(MP4);多候选取最大 |

服务内候选优先级(`core.candidate_urls`):

1. `bit_rate` 多码率列表(网页 detail API 才有)
2. 构造直链 `ratio=1080p`(30) / 元数据列出档(28) / 默认(10)
3. `play_addr.url_list` 清洗版(去 `logo_name`、`playwm→play`、升 1080p / 原样)
4. 备用 host `www.douyin.com/aweme/v1/play/...`


## 5. 完整源码

> 以下代码与 `douyin-downloader-deploy.tar.gz` 包内文件**逐字节一致**(构建时从磁盘读入)。
> Python 版本兼容 3.7(麒麟 V10 老环境)到 3.12(现代 Ubuntu)。

### 5.1 项目结构


```
douyin-downloader/
├── app.py                     # FastAPI 应用:路由 + API Key 鉴权 + 网页 UI(可关)+ 清理线程
├── requirements.txt           # 依赖
├── README.md                  # 产品说明(双语)
├── DEPLOY.md                  # 面向部署 agent 的分步部署手册
├── COMPLETE-NOTE.md           # 本笔记
├── Dockerfile                 # 可选:Docker 镜像
├── docker-compose.yml         # 可选:compose 编排
├── dy/
│   ├── __init__.py
│   ├── config.py              # 全部环境变量配置(CFG)
│   ├── core.py                # HTTP 主链路:ttwid / SSR 取数 / CDN 下载 / 图集
│   └── browser.py             # 浏览器兜底层:worker 线程 + playwright
└── deploy/
    ├── env.example            # .env 模板(API_KEY 等)
    ├── douyin-downloader.service   # systemd 单元
    └── nginx-douyin.conf      # nginx 反代(28080)
```

### 5.2 requirements.txt

```text
fastapi>=0.110
uvicorn[standard]>=0.29
httpx>=0.27
playwright>=1.44
```

### 5.3 dy/config.py

```python
"""Runtime configuration, all overridable via environment variables.

Important (xray / proxy routing):
  Douyin hosts are domestic Chinese sites.  If the server runs inside
  mainland China, leave DOUYIN_PROXY empty so traffic goes DIRECT (this is
  what gives the best anti-bot results).  Only set DOUYIN_PROXY when the
  server is outside China (point it at a mainland exit node, e.g. your
  xray vless setup) or when your xray works in TUN mode and you want to
  force a specific route.
"""
import os


def _env(name, default):
    v = os.environ.get(name)
    if v is None or v.strip() == "":
        return default
    return v.strip()


def _env_bool(name, default):
    v = os.environ.get(name)
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


class Config(object):
    # Outbound proxy used for ALL douyin-related traffic (share page,
    # metadata APIs and video CDN).  Empty string = direct connection.
    # Examples:  http://127.0.0.1:10809   socks5://127.0.0.1:1080
    DOUYIN_PROXY = _env("DOUYIN_PROXY", "")

    # Enable the headless-browser fallback layer.  Disable if playwright /
    # chromium is not installed on the server.
    BROWSER_ENABLED = _env_bool("BROWSER_ENABLED", True)

    # How long (seconds) the browser layer waits for page data.
    BROWSER_TIMEOUT = int(_env("BROWSER_TIMEOUT", "45"))

    # Explicit chromium/chrome binary for the browser layer.  Empty = use
    # playwright's own chromium (auto-falls back to a compatible system
    # browser when playwright's build cannot start, e.g. 64KB-page ARM
    # kernels with old playwright builds).
    CHROMIUM_PATH = _env("CHROMIUM_PATH", "")

    # Directory for downloaded files.
    TMP_DIR = _env("TMP_DIR", "/tmp/douyin-downloader")

    # How long downloaded files are kept before cleanup (hours).
    FILE_TTL_HOURS = float(_env("FILE_TTL_HOURS", "4"))

    # Default user agents.
    UA_MOBILE = _env(
        "UA_MOBILE",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 "
        "Mobile/15E148 Safari/604.1",
    )
    UA_DESKTOP = _env(
        "UA_DESKTOP",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    )

    # Service
    HOST = _env("HOST", "0.0.0.0")
    PORT = int(_env("PORT", "8931"))

    # API access key. When non-empty, every /api/* endpoint requires the
    # client to present this key via the "X-Api-Key" header OR the "?key="
    # query param. /health stays open. Empty = no auth (local testing).
    API_KEY = _env("API_KEY", "")

    # Serve the web UI at "/". Set 0 for an API-only deployment.
    ENABLE_UI = _env_bool("ENABLE_UI", True)

    # Timeouts (seconds)
    HTTP_TIMEOUT = float(_env("HTTP_TIMEOUT", "30"))
    DOWNLOAD_TIMEOUT = float(_env("DOWNLOAD_TIMEOUT", "300"))


CFG = Config()
```

### 5.4 dy/core.py(HTTP 主链路)

```python
"""Core (pure-HTTP) layer of the douyin downloader.

Verified flow (2026-10)
-----------------------
1. A valid ``ttwid`` cookie (registered via ttwid.bytedance.com) makes the
   share page server-side-render the full video metadata inside
   ``window._ROUTER_DATA`` (``videoInfoRes.item_list``) — from mainland
   China *and* overseas IPs.
2. ``video.play_addr.uri`` is the CDN video id.  The watermark-free video
   is served by ``https://aweme.snssdk.com/aweme/v1/play/?video_id={uri}``
   (the watermarked twin is ``playwm``).  ``ratio=1080p`` requests the
   highest quality the source has (CDN returns 404 if the source has no
   1080p encode — fall back to the listed ratio / default).
3. The play endpoint 302-redirects to the real CDN (douyinvod.com);
   httpx follows it automatically.

If the SSR data is missing (rare: anti-bot change, unusual video state),
the browser fallback layer (dy/browser.py) is used.
"""
import json
import os
import re
import time
import uuid
import zipfile
from typing import List, Optional, Tuple

import httpx

from .config import CFG


class DouyinError(Exception):
    """User-facing error with a readable message."""


# ---------------------------------------------------------------------------
# 1. Input handling
# ---------------------------------------------------------------------------

_URL_RE = re.compile(
    r"https?://(?:[a-z0-9-]+\.)?"
    r"(?:douyin\.com|iesdouyin.com|amemv\.com|snssdk\.com)/[^\s\"'<>)\]]+",
    re.I,
)
_AWEME_ID_RE = re.compile(r"\b(\d{17,22})\b")
_HTML_LINK_RE = re.compile(r"<a\s+href=\"([^\"]+)\"", re.I)


def extract_target(text: str) -> str:
    """Return a share URL to work with, from raw pasted share text."""
    if not text:
        raise DouyinError("empty input")
    m = _URL_RE.search(text)
    url = m.group(0).rstrip(".,;!?，。；！？") if m else None
    # desktop page URLs (www.douyin.com/video/<id>) are acrawler-walled;
    # the aweme_id works identically on the mobile share page, so convert.
    if url:
        m2 = re.match(
            r"https?://(?:www\.)?douyin\.com/(?:video|note)/(\d{17,22})(?:$|[?/])",
            url, re.I,
        )
        if m2:
            return "https://www.iesdouyin.com/share/video/%s/" % m2.group(1)
    if url:
        return url
    m = re.search(r"/(?:share/)?(?:video|note)/(\d{17,22})", text)
    if m:
        return "https://www.iesdouyin.com/share/video/%s/" % m.group(1)
    m = _AWEME_ID_RE.search(text)
    if m:
        return "https://www.iesdouyin.com/share/video/%s/" % m.group(1)
    raise DouyinError(
        "could not find a douyin link in the input "
        "(expected a v.douyin.com / douyin.com URL or a numeric video id)"
    )


def _is_final_share_url(url: str) -> bool:
    return bool(re.search(r"(?:share/video|/video|/note)/\d{17,22}", url))


# ---------------------------------------------------------------------------
# httpx plumbing
# ---------------------------------------------------------------------------

# httpx renamed its client kwarg: <0.27 uses proxies=, >=0.27 uses proxy=
_PROXY_KWARG = (
    "proxies"
    if tuple(int(x) for x in httpx.__version__.split(".")[:2]) < (0, 27)
    else "proxy"
)


def make_client(proxy: Optional[str] = None, follow: bool = True,
                cookie: Optional[str] = None) -> httpx.Client:
    kwargs = {}
    if proxy:
        if _PROXY_KWARG == "proxies":  # httpx < 0.27: needs a URL map
            kwargs["proxies"] = {"http://": proxy, "https://": proxy}
        else:
            kwargs["proxy"] = proxy
    headers = {
        "User-Agent": CFG.UA_MOBILE,
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if cookie:
        headers["Cookie"] = cookie
    return httpx.Client(
        follow_redirects=follow,
        timeout=httpx.Timeout(CFG.HTTP_TIMEOUT, connect=15.0),
        headers=headers,
        # Never pick up ambient HTTP(S)_PROXY env vars: routing for this
        # service is explicit (DOUYIN_PROXY), which matters when the box
        # also runs xray for other traffic.
        trust_env=False,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# 2. ttwid
# ---------------------------------------------------------------------------

_TTWID_URL = "https://ttwid.bytedance.com/ttwid/union/register/"
_TTWID_TTL = 30 * 24 * 3600  # registered tokens live ~1 year; refresh at 30d


def _ttwid_file() -> str:
    d = CFG.TMP_DIR
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, ".ttwid")


def register_ttwid(proxy: Optional[str] = None) -> Optional[str]:
    """Register a fresh ttwid via the bytedance union register endpoint."""
    body = {
        "region": "cn",
        "aid": 1768,
        "needFid": False,
        "service": "www.douyin.com",
        "migrate_info": {"ticket": "", "source": "node"},
        "cbUrlProtocol": "https",
        "union": True,
    }
    with make_client(proxy) as client:
        r = client.post(
            _TTWID_URL,
            json=body,
            headers={"User-Agent": CFG.UA_MOBILE},
        )
    if r.status_code != 200:
        return None
    m = re.search(r"ttwid=([^;]+)", r.headers.get("set-cookie", ""))
    if not m:
        return None
    from urllib.parse import unquote
    return unquote(m.group(1))


def get_ttwid(proxy: Optional[str] = None) -> Optional[str]:
    """Return a valid ttwid (file-cached), registering a new one if needed."""
    try:
        if os.path.isfile(_ttwid_file()):
            with open(_ttwid_file()) as f:
                raw = f.read().strip()
            if "|" in raw:
                return raw
    except OSError:
        pass
    token = register_ttwid(proxy)
    if token:
        try:
            with open(_ttwid_file(), "w") as f:
                f.write(token)
        except OSError:
            pass
    return token


# ---------------------------------------------------------------------------
# 3. Short link resolution + share page fetch
# ---------------------------------------------------------------------------

def resolve_share_url(url: str) -> Tuple[str, Optional[str]]:
    """Follow redirects (including <a href> interstitials); return
    (final_share_url, aweme_id)."""
    with make_client(CFG.DOUYIN_PROXY) as client:
        try:
            r = client.get(url)
        except httpx.HTTPError as e:
            raise DouyinError("cannot reach douyin short link: %s" % e)
        if r.status_code >= 400:
            raise DouyinError("short link returned HTTP %s" % r.status_code)
        final = str(r.url)
        # some edge responses answer with an HTML <a href> interstitial
        if not _is_final_share_url(final) and r.text:
            m = _HTML_LINK_RE.search(r.text)
            if m and m.group(1).startswith("http"):
                final = m.group(1).replace("&amp;", "&")
        m = re.search(r"(?:video|note)/(\d{17,22})", final) or re.search(
            r"[?&]modal_id=(\d{17,22})", final
        )
        return final, (m.group(1) if m else None)


def fetch_share_page(url: str, ttwid: Optional[str] = None) -> Tuple[
        str, Optional[str], Optional[dict]]:
    """GET the share page; return (html, aweme_id, item_or_None)."""
    if not _is_final_share_url(url):
        url, _ = resolve_share_url(url)
    cookie = ("ttwid=%s" % ttwid) if ttwid else None
    with make_client(CFG.DOUYIN_PROXY, cookie=cookie) as client:
        try:
            r = client.get(url)
        except httpx.HTTPError as e:
            raise DouyinError("cannot fetch share page: %s" % e)
        if r.status_code >= 400:
            raise DouyinError("share page returned HTTP %s" % r.status_code)
    html = r.text
    m = re.search(r"(?:video|note)/(\d{17,22})", url)
    aweme_id = m.group(1) if m else None
    return html, aweme_id, parse_router_data(html)


def parse_router_data(html: str) -> Optional[dict]:
    """Extract videoInfoRes.item_list[0] from page HTML (may be None)."""
    m = re.search(r"window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>", html, re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return None
    loader = data.get("loaderData") or {}
    for page in loader.values():
        if not isinstance(page, dict):
            continue
        res = page.get("videoInfoRes")
        if not isinstance(res, dict):
            continue
        items = res.get("item_list") or []
        if items and isinstance(items[0], dict):
            return items[0]
        return {"_empty": True}
    return None


def fetch_item_http(share_url: str) -> Optional[dict]:
    """Return the video item dict (HTTP + ttwid flow), or None when the
    page had no data.  Raises DouyinError for a clearly dead/private video."""
    ttwid = get_ttwid(CFG.DOUYIN_PROXY)
    item = None
    for attempt in range(2):
        _html, _id, item = fetch_share_page(share_url, ttwid)
        if item is not None:
            break
        # no data: rotate the ttwid once and retry
        ttwid = register_ttwid(CFG.DOUYIN_PROXY)
        time.sleep(1)
    if item is None:
        return None
    if item.get("_empty"):
        raise DouyinError(
            "video %s is unavailable (deleted, private or region-restricted)"
            % _id
        )
    return item


# ---------------------------------------------------------------------------
# 4. Video metadata -> candidate URLs
# ---------------------------------------------------------------------------

def _set_ratio(url: str, ratio: str) -> str:
    if "ratio=" in url:
        return re.sub(r"ratio=[^&]*", "ratio=%s" % ratio, url)
    return url + "&ratio=%s" % ratio


def _clean(url: str) -> str:
    # watermark-free flavour of the CDN endpoint
    return url.replace("playwm", "play")


def _strip_logo(url: str) -> str:
    return re.sub(r"[&?]logo_name=[^&]*", "", url)


def _listed_ratio(item: dict) -> Optional[str]:
    play = (item.get("video") or {}).get("play_addr") or {}
    for u in play.get("url_list") or []:
        m = re.search(r"ratio=(\w+p)", u)
        if m:
            return m.group(1)
    return None


def candidate_urls(item: dict) -> List[Tuple[str, str, int]]:
    """Return [(url, label, priority)] for direct watermark-free download.

    Higher priority is tried first; each candidate is verified (HTTP 200 +
    MP4 header) and the biggest valid file wins, so ordering mainly saves
    time on the common happy path.
    """
    out: List[Tuple[str, str, int]] = []
    vid = item.get("video") or {}
    play = vid.get("play_addr") or {}
    uri = play.get("uri") or play.get("url_key") or None
    listed = _listed_ratio(item)

    # a) multi-bitrate list (web detail API provides this)
    for br in vid.get("bit_rate") or []:
        bp = (br or {}).get("play_addr") or {}
        for u in bp.get("url_list") or []:
            out.append((_clean(_strip_logo(u)),
                        "bitrate %s" % br.get("gear_name", "?"), 40))

    # b) play_addr.url_list entries (share-page data)
    for u in play.get("url_list") or []:
        u = _clean(_strip_logo(u))
        out.append((_set_ratio(u, "1080p"), "play 1080p", 25))
        out.append((u, "play orig", 15))

    # c) constructed CDN play endpoints from the raw video uri
    if uri:
        base = "https://aweme.snssdk.com/aweme/v1/play/?video_id=%s&line=0" % uri
        out.append((base + "&ratio=1080p", "api 1080p", 30))
        if listed and listed != "1080p":
            out.append((base + "&ratio=%s" % listed, "api %s" % listed, 28))
        out.append((base, "api default", 10))
        base2 = "https://www.douyin.com/aweme/v1/play/?video_id=%s&line=0" % uri
        out.append((base2 + "&ratio=1080p", "web 1080p", 12))
        if listed and listed != "1080p":
            out.append((base2 + "&ratio=%s" % listed, "web %s" % listed, 11))

    seen = set()
    deduped = []
    for u, label, pr in out:
        if u and u not in seen:
            seen.add(u)
            deduped.append((u, label, pr))
    deduped.sort(key=lambda t: -t[2])
    return deduped


def image_urls(item: dict) -> List[List[str]]:
    """For image (photo post) items: per-image list of URL candidates."""
    result = []
    for img in item.get("images") or []:
        urls = []
        for key in ("url_list", "web_url_list"):
            u = img.get(key)
            if isinstance(u, list):
                urls.extend(u)
            elif isinstance(u, str):
                urls.append(u)
        di = img.get("display_image")
        if isinstance(di, dict):
            urls.extend(di.get("url_list") or [])
        urls = [x for x in urls if x]
        if urls:
            result.append(urls)
    return result


# ---------------------------------------------------------------------------
# 5. Download
# ---------------------------------------------------------------------------

def _looks_like_mp4(head: bytes) -> bool:
    return len(head) >= 12 and head[4:8] == b"ftyp"


def probe_url(client: httpx.Client, url: str) -> Optional[Tuple[int, str]]:
    """Range-probe a CDN URL (fetches only the first 64 KB).

    Returns (total_size, content_type) when the URL serves an MP4, else None.
    """
    try:
        with client.stream(
            "GET",
            url,
            headers={"Range": "bytes=0-65535", "User-Agent": CFG.UA_MOBILE,
                     "Referer": "https://www.iesdouyin.com/"},
            timeout=httpx.Timeout(CFG.DOWNLOAD_TIMEOUT, connect=20.0),
        ) as r:
            if r.status_code not in (200, 206):
                return None
            head = next(r.iter_bytes(16), b"")[:16]
            if not _looks_like_mp4(head):
                return None
            m = re.search(r"/(\d+)\s*$", r.headers.get("content-range") or "")
            total = int(m.group(1)) if m else int(
                r.headers.get("content-length") or 0
            )
            return (total, r.headers.get("content-type") or "video/mp4")
    except (httpx.HTTPError, StopIteration):
        return None


def download_to_file(url: str, path: str, proxy: Optional[str] = None) -> int:
    """Stream ``url`` to ``path`` (following CDN redirects); returns bytes."""
    with make_client(proxy, follow=True) as client:
        client.headers["Referer"] = "https://www.iesdouyin.com/"
        with client.stream(
            "GET",
            url,
            headers={"User-Agent": CFG.UA_MOBILE,
                     "Referer": "https://www.iesdouyin.com/"},
            timeout=httpx.Timeout(CFG.DOWNLOAD_TIMEOUT, connect=20.0),
        ) as r:
            if r.status_code != 200:
                raise DouyinError("download failed: HTTP %s" % r.status_code)
            n = 0
            with open(path, "wb") as f:
                for chunk in r.iter_bytes(1 << 16):
                    f.write(chunk)
                    n += len(chunk)
    return n


def download_bytes(url: str, proxy: Optional[str] = None) -> bytes:
    """Small-file download (images etc.)."""
    with make_client(proxy, follow=True) as client:
        r = client.get(
            url,
            headers={"User-Agent": CFG.UA_MOBILE,
                     "Referer": "https://www.iesdouyin.com/"},
            timeout=httpx.Timeout(CFG.DOWNLOAD_TIMEOUT, connect=20.0),
        )
        if r.status_code != 200:
            raise DouyinError("download failed: HTTP %s" % r.status_code)
        return r.content


def save_video(item: dict, workdir: str) -> dict:
    """Download the best available video for ``item`` (biggest valid MP4)."""
    aweme_id = str(item.get("aweme_id") or "video")
    os.makedirs(workdir, exist_ok=True)
    desc = (item.get("desc") or "").strip().replace("\n", " ")
    title = re.sub(r"[\\/:*?\"<>|\r\n\t#]", "", desc)[:50].strip() or aweme_id
    filename = "%s_%s.mp4" % (aweme_id, title)

    cands = candidate_urls(item)
    if not cands:
        raise DouyinError("no downloadable video URL found in metadata")

    best = None  # (size, url, label, tmp_path)
    with make_client(CFG.DOUYIN_PROXY) as client:
        for url, label, _pr in cands:
            probe = probe_url(client, url)
            if probe is None:
                continue
            tmp = os.path.join(
                workdir, "dl_%s_%s.mp4" % (aweme_id, uuid.uuid4().hex[:8])
            )
            try:
                written = download_to_file(url, tmp, CFG.DOUYIN_PROXY)
            except (DouyinError, OSError):
                continue
            with open(tmp, "rb") as f:
                head = f.read(16)
            if not _looks_like_mp4(head):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                continue
            if best is None or written > best[0]:
                if best and os.path.exists(best[3]):
                    try:
                        os.remove(best[3])
                    except OSError:
                        pass
                best = (written, url, label, tmp)
            else:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            # stop after the first 1080p-tier success to save bandwidth
            if "1080p" in label and best and best[0] > 0:
                break

    if best is None:
        raise DouyinError(
            "all video URLs failed (CDN may be geo-restricted; "
            "try running on a mainland-China IP or set DOUYIN_PROXY)"
        )

    final_path = os.path.join(workdir, filename)
    os.replace(best[3], final_path)
    return {
        "aweme_id": aweme_id,
        "filename": filename,
        "path": final_path,
        "size": best[0],
        "url_used": best[1],
        "variant": best[2],
        "kind": "video",
        "meta": video_meta(item),
    }


def save_images(item: dict, workdir: str) -> dict:
    aweme_id = str(item.get("aweme_id") or "photos")
    os.makedirs(workdir, exist_ok=True)
    per_image = image_urls(item)
    if not per_image:
        raise DouyinError("no images found in metadata")
    files = []
    for i, urls in enumerate(per_image, 1):
        data = None
        for u in urls:
            try:
                data = download_bytes(u, CFG.DOUYIN_PROXY)
                if data[:3] == b"\xff\xd8\xff" or data[:4] == b"\x89PNG":
                    break
                data = None
            except DouyinError:
                continue
        if data is None:
            raise DouyinError(
                "failed to download image %d/%d" % (i, len(per_image))
            )
        ext = "jpg" if data[:3] == b"\xff\xd8\xff" else "png"
        p = os.path.join(workdir, "%s_%02d.%s" % (aweme_id, i, ext))
        with open(p, "wb") as f:
            f.write(data)
        files.append(p)
    zip_path = os.path.join(workdir, "%s_photos.zip" % aweme_id)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, arcname=os.path.basename(p))
    return {
        "aweme_id": aweme_id,
        "filename": os.path.basename(zip_path),
        "path": zip_path,
        "size": os.path.getsize(zip_path),
        "url_used": "",
        "variant": "%d photos" % len(files),
        "kind": "images",
        "meta": video_meta(item),
    }


def video_meta(item: dict) -> dict:
    vid = item.get("video") or {}
    author = item.get("author") or {}
    music = item.get("music") or {}
    stats = item.get("statistics") or {}
    return {
        "title": (item.get("desc") or "").strip(),
        "author": author.get("nickname") or "",
        "author_id": author.get("unique_id") or "",
        "duration_ms": vid.get("duration"),
        "width": vid.get("width"),
        "height": vid.get("height"),
        "music": music.get("title") or music.get("author") or "",
        "likes": stats.get("digg_count"),
        "play_addr_uri": (vid.get("play_addr") or {}).get("uri"),
    }


# ---------------------------------------------------------------------------
# 6. Top-level pipeline
# ---------------------------------------------------------------------------

def handle(text: str, workdir: str, browser_fetch=None) -> dict:
    """Full pipeline used by the API layer.

    ``browser_fetch(url)`` is an optional callable (the playwright layer)
    used as fallback when the HTTP layer finds no data.
    """
    url = extract_target(text)
    if not _is_final_share_url(url):
        url, aweme_id = resolve_share_url(url)
        if aweme_id and not url.startswith("https://www.iesdouyin.com/share/"):
            # desktop redirect target – convert to the mobile share page
            url = "https://www.iesdouyin.com/share/video/%s/" % aweme_id

    item = None
    try:
        item = fetch_item_http(url)
    except DouyinError as e:
        if "unavailable" not in str(e):
            raise
        item = None  # give the browser layer a chance

    source = "http"
    if item is None and browser_fetch is not None:
        source = "browser"
        item = browser_fetch(url)
    if item is None:
        raise DouyinError(
            "could not read video data from douyin "
            "(deleted / private / region-restricted, or anti-bot change)"
        )
    if item.get("_empty"):
        raise DouyinError(
            "video is unavailable (deleted, private or region-restricted)"
        )

    if item.get("images"):
        result = save_images(item, workdir)
    else:
        result = save_video(item, workdir)
    result["source"] = source
    result["share_url"] = url
    return result


def cleanup_old_files(workdir: str, ttl_hours: float) -> None:
    """Remove downloaded files older than ttl_hours (background janitor)."""
    if not os.path.isdir(workdir):
        return
    cutoff = time.time() - ttl_hours * 3600
    for name in os.listdir(workdir):
        if name.startswith("."):
            continue
        p = os.path.join(workdir, name)
        try:
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass
```

### 5.5 dy/browser.py(浏览器兜底层)

```python
"""Headless-browser fallback layer (playwright + chromium).

Used when the pure-HTTP layer (ttwid + server-side-rendered share page)
cannot read the video metadata.  A real browser runs douyin's own
JavaScript (secsdk/bdms signing, msToken, reflow params), which makes the
client-side API calls succeed in cases the HTTP layer cannot cover.

Architecture: all playwright calls run inside ONE dedicated worker thread
(playwright's sync API is not thread-safe).  API handlers submit jobs to
its queue and block on a per-job event.

Strategy (in order):
  1. load the share page with a valid ttwid cookie pre-set — the page may
     then server-render the data straight into ``window._ROUTER_DATA``;
  2. capture the page's own iteminfo API response from network traffic;
  3. inject an iteminfo fetch in the page context as a last resort.
"""
import asyncio
import glob
import json
import os
import queue
import re
import sys
import threading
import time
import uuid
from typing import Optional

from .config import CFG

from . import core as _core

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover  (missing / broken playwright)
    sync_playwright = None


class BrowserLayer(object):
    def __init__(self):
        self._worker_lock = threading.Lock()
        self._worker = None
        self._queue = None
        self._events = {}
        self._results = {}
        self._pw = None
        self._browser = None
        self._worker_ready = threading.Event()
        self._worker_error = None
        self._closed = False

    # -- lifecycle ---------------------------------------------------------
    def _ensure_worker(self):
        """Start the dedicated worker thread (first request triggers it)."""
        if sync_playwright is None:
            return False
        with self._worker_lock:
            if self._worker is not None:
                if not self._worker_ready.wait(90):
                    return False
                return self._worker_error is None
            self._queue = queue.Queue()
            t = threading.Thread(target=self._worker_main, name="dy-browser",
                                 daemon=True)
            self._worker = t
            t.start()
            return self._worker_ready.wait(90) and self._worker_error is None

    def _worker_main(self):
        try:
            self._prepare_thread()
            self._pw = sync_playwright().start()
            self._browser = self._launch_browser()
            self._worker_ready.set()
        except Exception as e:  # startup failure — report to callers
            self._worker_error = e
            self._worker_ready.set()
            return
        while True:
            job = self._queue.get()
            if job is None:  # shutdown sentinel
                break
            job_id, fn_name, arg = job
            try:
                result = getattr(self, fn_name)(arg)
                err = None
            except Exception as e:
                result, err = None, e
            self._results[job_id] = (result, err)
            self._events[job_id].set()
        self.close_browser()

    def _submit(self, fn_name: str, arg) -> Optional[object]:
        if not CFG.BROWSER_ENABLED or sync_playwright is None:
            return None
        if not self._ensure_worker():
            return None
        job_id = uuid.uuid4().hex
        ev = threading.Event()
        self._events[job_id] = ev
        self._queue.put((job_id, fn_name, arg))
        # job budget: page timeout + generous slack
        if not ev.wait(timeout=CFG.BROWSER_TIMEOUT * 2 + 120):
            return None
        entry = self._results.pop(job_id, (None, None))
        self._events.pop(job_id, None)
        return entry[0]

    # -- worker-thread prep & browser launch ---------------------------------
    def _prepare_thread(self):
        """Make playwright's sync API usable from this non-main thread.

        On Python 3.7 playwright's start() installs a ThreadedChildWatcher by
        closing the thread's current SafeChildWatcher, whose close() calls
        signal.signal(SIGCHLD) — main-thread only.  Pre-setting a
        ThreadedChildWatcher as the current child watcher makes playwright's
        isinstance(SafeChildWatcher) check fail, so the whole block is skipped.
        Handles both the stock per-thread-local watcher and Kylin's
        policy-level ``_watcher`` attribute.
        """
        if sys.version_info[:2] != (3, 7) or sys.platform == "win32":
            return
        try:
            from playwright.sync_api._py37ThreadedChildWatcher import ThreadedChildWatcher
        except Exception:
            return
        watcher = ThreadedChildWatcher()
        try:
            policy = asyncio.get_event_loop_policy()
        except Exception:
            return
        try:
            policy._local.child_watcher = watcher  # stock CPython 3.7
        except Exception:
            pass
        try:
            policy._watcher = watcher  # Kylin V10 style (shared attribute)
        except Exception:
            pass

    def _chromium_candidates(self):
        cands = []
        if CFG.CHROMIUM_PATH:
            cands.append(CFG.CHROMIUM_PATH)
        base = os.path.expanduser("~/.cache/ms-playwright")
        dirs = sorted(glob.glob(os.path.join(base, "chromium-*")), reverse=True)
        for d in dirs:
            for sub in ("chrome-linux-arm64", "chrome-linux", "chrome-linux64"):
                p = os.path.join(d, sub, "chrome")
                if os.path.isfile(p):
                    cands.append(p)
        for p in (
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
        ):
            if os.path.isfile(p):
                cands.append(p)
        return cands

    def _launch_browser(self):
        """Launch the first chromium that actually starts.

        Playwright's pinned chromium can be too old for some kernels (e.g.
        64KB-page ARM), so fall back to a newer playwright/system build.
        """
        args = [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
        ]
        kwargs = {
            "headless": True,
            # must not be True off the main thread (signal registration)
            "handle_sigint": False,
            "handle_sigterm": False,
            "handle_sighup": False,
            "args": args,
        }
        cands = self._chromium_candidates()
        last_err = None
        for p in cands:
            try:
                return self._pw.chromium.launch(executable_path=p, **kwargs)
            except Exception as e:
                last_err = e
        if last_err is not None:
            raise last_err
        return self._pw.chromium.launch(**kwargs)  # let playwright pick

    def close_browser(self):
        if self._browser is not None:
            try:
                self._browser.close()
            except Exception:
                pass
            self._browser = None

    def close(self):
        if self._queue is not None:
            try:
                self._queue.put(None)
            except Exception:
                pass
        if self._pw is not None:
            try:
                self._pw.stop()
            except Exception:
                pass
            self._pw = None

    # -- main entry ---------------------------------------------------------
    def fetch_item(self, share_url: str) -> Optional[dict]:
        """Return the video item dict, or None when nothing could be read."""
        return self._submit("_job_fetch_item", share_url)

    def fetch_web_detail(self, aweme_id: str) -> Optional[dict]:
        return self._submit("_job_fetch_web_detail", aweme_id)

    # -- jobs (run in the worker thread) ------------------------------------
    def _new_context(self, user_agent: str, mobile: bool):
        kwargs = {
            "user_agent": user_agent,
            "locale": "zh-CN",
            "viewport": (
                {"width": 390, "height": 844}
                if mobile
                else {"width": 1366, "height": 900}
            ),
            "extra_http_headers": {"Accept-Language": "zh-CN,zh;q=0.9"},
        }
        if CFG.DOUYIN_PROXY:
            kwargs["proxy"] = {"server": CFG.DOUYIN_PROXY}
        ctx = self._browser.new_context(**kwargs)
        # A valid ttwid makes the page server-render the data into the DOM,
        # which is the single most reliable way to get it (works from any IP).
        try:
            ttwid = _core.get_ttwid(CFG.DOUYIN_PROXY)
            if ttwid:
                cookies = []
                for domain in (".iesdouyin.com", ".douyin.com",
                               ".bytedance.com", ".snssdk.com"):
                    cookies.append({
                        "name": "ttwid",
                        "value": ttwid,
                        "domain": domain,
                        "path": "/",
                    })
                ctx.add_cookies(cookies)
        except Exception:
            pass
        return ctx

    def _job_fetch_item(self, share_url: str) -> Optional[dict]:
        ctx = None
        try:
            ctx = self._new_context(CFG.UA_MOBILE, mobile=True)
            page = ctx.new_page()
            captured = {"iteminfo": None}

            def on_response(resp):
                try:
                    u = resp.url
                except Exception:
                    return
                if "iteminfo" in u:
                    try:
                        j = resp.json()
                    except Exception:
                        return
                    items = (j or {}).get("item_list") if isinstance(j, dict) else None
                    if items and items[0]:
                        captured["iteminfo"] = j

            page.on("response", on_response)
            try:
                page.goto(share_url, wait_until="domcontentloaded",
                          timeout=CFG.BROWSER_TIMEOUT * 1000)
            except Exception:
                pass  # navigation hiccups are fine; we only need the API call

            start = time.time()
            deadline = start + CFG.BROWSER_TIMEOUT
            tried_inject = False
            while time.time() < deadline:
                if captured["iteminfo"]:
                    return self._item_from_response(captured["iteminfo"])
                # data may have been server-rendered into the DOM (ttwid)
                item = self._parse_dom_router_data(page)
                if item:
                    return item
                if not tried_inject and time.time() > start + 12:
                    tried_inject = True
                    j = self._inject_iteminfo_fetch(page)
                    if j:
                        return self._item_from_response(j)
                time.sleep(1)
            return None
        except Exception:
            return None
        finally:
            if ctx is not None:
                try:
                    ctx.close()
                except Exception:
                    pass

    def _item_from_response(self, j: dict) -> Optional[dict]:
        items = j.get("item_list") or []
        if items and items[0]:
            return items[0]
        if j.get("filter_list") or not items:
            return {"_empty": True}
        return None

    def _inject_iteminfo_fetch(self, page) -> Optional[dict]:
        """Run the iteminfo request inside the page context (its cookies/SDK apply)."""
        js = r"""
        async () => {
          let webId = "";
          const m = document.documentElement.innerHTML.match(/"webId":"(\d+)"/);
          if (m) webId = m[1];
          const q = new URLSearchParams(location.search);
          const url = '/web/api/v2/aweme/iteminfo/?reflow_source=reflow_page'
            + '&web_id=' + webId + '&device_id=' + webId
            + '&from_did=' + (q.get('did') || '')
            + '&user_cip='
            + '&use_new_select_scope=0'
            + '&item_ids=' + ((location.pathname.match(/(\d{17,22})/) || [])[1] || '')
            + '&aweme_type=' + (q.get('aweme_type') || '')
            + '&reflow_id='
            + '&share_scene=' + (q.get('share_scene') || '')
            + '&share_token=' + (q.get('share_token') || '')
            + '&scene_from=';
          try {
            const r = await fetch(url, { credentials: 'include',
              headers: { 'Accept': 'application/json, text/plain, */*' } });
            const t = await r.text();
            return t ? JSON.parse(t) : null;
          } catch (e) { return null; }
        }
        """
        try:
            j = page.evaluate(js)
            return j if isinstance(j, dict) else None
        except Exception:
            return None

    def _parse_dom_router_data(self, page) -> Optional[dict]:
        try:
            html = page.content()
        except Exception:
            return None
        m = re.search(r"window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>", html, re.S)
        if not m:
            return None
        try:
            data = json.loads(m.group(1))
        except ValueError:
            return None
        loader = data.get("loaderData") or {}
        for page_data in loader.values():
            if not isinstance(page_data, dict):
                continue
            res = page_data.get("videoInfoRes")
            if not isinstance(res, dict):
                continue
            items = res.get("item_list") or []
            if items and items[0]:
                return items[0]
        return None

    def _job_fetch_web_detail(self, aweme_id: str) -> Optional[dict]:
        """Load www.douyin.com/video/<id> in a desktop context and capture
        the /aweme/v1/web/aweme/detail/ response.  The page's acrawler
        challenge runs for real, so the API call usually succeeds."""
        ctx = None
        try:
            ctx = self._new_context(CFG.UA_DESKTOP, mobile=False)
            page = ctx.new_page()
            captured = {}

            def on_response(resp):
                u = resp.url
                if "aweme/v1/web/aweme/detail/" in u and "aweme_id" in u:
                    try:
                        j = resp.json()
                    except Exception:
                        return
                    if isinstance(j, dict) and j.get("aweme_detail"):
                        captured["detail"] = j["aweme_detail"]

            page.on("response", on_response)
            url = "https://www.douyin.com/video/%s" % aweme_id
            try:
                page.goto(url, wait_until="domcontentloaded",
                          timeout=CFG.BROWSER_TIMEOUT * 1000)
            except Exception:
                pass
            deadline = time.time() + CFG.BROWSER_TIMEOUT
            while time.time() < deadline:
                if "detail" in captured:
                    return captured["detail"]
                time.sleep(1)
            return None
        except Exception:
            return None
        finally:
            if ctx is not None:
                try:
                    ctx.close()
                except Exception:
                    pass


_LAYER = BrowserLayer()


def get_browser_layer() -> BrowserLayer:
    return _LAYER


def browser_fetch_item(share_url: str) -> Optional[dict]:
    """Convenience: try the mobile share flow, then the web detail flow."""
    layer = get_browser_layer()
    item = layer.fetch_item(share_url)
    if item:
        return item
    m = re.search(r"(?:video|note)/(\d{17,22})", share_url)
    if m:
        detail = layer.fetch_web_detail(m.group(1))
        if detail:
            return detail
    return None
```

### 5.6 dy/__init__.py

```python
# douyin-downloader core package
```

### 5.7 app.py(FastAPI 应用)

```python
"""FastAPI service for the douyin watermark-free downloader.

Endpoints
---------
GET  /                  web UI (paste a share link, download the file)
GET  /api/info?url=…    JSON metadata + direct (watermark-free) CDN URLs
GET  /api/download?url=…   streams the downloaded file (mp4 / photos.zip)
GET  /api/files         list recently downloaded files
GET  /health            liveness probe

Run:  python app.py   (or: uvicorn app:app --host 0.0.0.0 --port 8931)
"""
import json
import os
import re
import threading
import time
from typing import Optional
from urllib.parse import quote as _url_quote

from fastapi import FastAPI, HTTPException, Query, Request, Depends
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from dy.config import CFG
from dy import core
from dy.core import DouyinError
import dy.browser  # noqa: F401  (import on the main thread at startup)

app = FastAPI(title="douyin-downloader", version="1.0")


# ---------------------------------------------------------------------------
# API key auth
# ---------------------------------------------------------------------------

def require_api_key(request: Request, key: Optional[str] = Query(None)):
    """Guard for /api/* endpoints.

    When CFG.API_KEY is set, the client must present it either as the
    ``X-Api-Key`` request header or the ``?key=`` query parameter.  When
    CFG.API_KEY is empty the endpoint is open (local testing).  /health is
    intentionally not guarded.
    """
    if not CFG.API_KEY:
        return
    presented = request.headers.get("x-api-key") or key
    if presented != CFG.API_KEY:
        raise HTTPException(status_code=401, detail="invalid or missing api key")


# ---------------------------------------------------------------------------
# background janitor
# ---------------------------------------------------------------------------

def _janitor():
    while True:
        time.sleep(15 * 60)
        try:
            core.cleanup_old_files(CFG.TMP_DIR, CFG.FILE_TTL_HOURS)
        except Exception:
            pass


threading.Thread(target=_janitor, daemon=True).start()
os.makedirs(CFG.TMP_DIR, exist_ok=True)


# ---------------------------------------------------------------------------
# pipeline
# ---------------------------------------------------------------------------

def _browser_fn(url: str):
    if not CFG.BROWSER_ENABLED:
        return None
    from dy import browser as _browser
    return _browser.browser_fetch_item(url)


def _info_for(text: str) -> dict:
    url = core.extract_target(text)
    if not core._is_final_share_url(url):
        url, _id = core.resolve_share_url(url)
        if _id and not url.startswith("https://www.iesdouyin.com/share/"):
            url = "https://www.iesdouyin.com/share/video/%s/" % _id

    item = None
    source = "http"
    try:
        item = core.fetch_item_http(url)
    except DouyinError:
        item = None
    if item is None and CFG.BROWSER_ENABLED:
        source = "browser"
        item = _browser_fn(url)
    if not item or item.get("_empty"):
        raise DouyinError(
            "could not read video data (deleted / private / region-restricted, "
            "or server IP not accepted by douyin — use a mainland-CN IP or DOUYIN_PROXY)"
        )
    return {
        "share_url": url,
        "source": source,
        "kind": "images" if item.get("images") else "video",
        "meta": core.video_meta(item),
        "candidate_urls": [
            {"url": u, "label": label} for u, label, _ in core.candidate_urls(item)
        ] if not item.get("images") else [],
        "image_count": len(core.image_urls(item)) if item.get("images") else 0,
    }


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {
        "ok": True,
        "browser_enabled": CFG.BROWSER_ENABLED,
        "proxy": CFG.DOUYIN_PROXY or "(direct)",
        "tmp_dir": CFG.TMP_DIR,
    }


@app.get("/", response_class=HTMLResponse)
def index():
    if not CFG.ENABLE_UI:
        raise HTTPException(status_code=404, detail="ui disabled")
    return UI_HTML


@app.get("/api/info")
def api_info(url: str = Query(..., description="douyin share link or raw share text"),
            _k=Depends(require_api_key)):
    try:
        return _info_for(url)
    except DouyinError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.get("/api/download")
def api_download(url: str = Query(..., description="douyin share link or raw share text"),
                _k=Depends(require_api_key)):
    try:
        result = core.handle(url, CFG.TMP_DIR, browser_fetch=_browser_fn)
    except DouyinError as e:
        raise HTTPException(status_code=422, detail=str(e))
    meta = result["meta"]

    def _hdr(v):
        # HTTP headers must be latin-1; percent-encode anything else so
        # the UI can decodeURIComponent() it back.
        v = v or ""
        try:
            v.encode("latin-1")
            return v
        except UnicodeEncodeError:
            return _url_quote(v, safe="")

    resp = FileResponse(
        result["path"],
        filename=result["filename"],
        media_type="video/mp4" if result["kind"] == "video" else "application/zip",
    )
    resp.headers["X-Douyin-Title"] = _hdr(meta.get("title", ""))
    resp.headers["X-Douyin-Author"] = _hdr(meta.get("author", ""))
    resp.headers["X-Douyin-Variant"] = _hdr(result.get("variant", ""))
    resp.headers["X-Douyin-Source"] = result.get("source", "")
    resp.headers["X-Douyin-Size"] = str(result.get("size", 0))
    return resp


@app.get("/api/files")
def api_files(_k=Depends(require_api_key)):
    out = []
    if os.path.isdir(CFG.TMP_DIR):
        for name in os.listdir(CFG.TMP_DIR):
            p = os.path.join(CFG.TMP_DIR, name)
            if not os.path.isfile(p) or name.startswith(".") or name.startswith("dl_"):
                continue
            st = os.stat(p)
            out.append(
                {
                    "name": name,
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                    "url": "/api/files/%s" % name,
                }
            )
    out.sort(key=lambda x: -x["mtime"])
    return {"files": out[:100]}


@app.get("/api/files/{name}")
def api_file(name: str, _k=Depends(require_api_key)):
    if re.search(r"[^\w.\-]", name) or "/" in name or name.startswith("."):
        raise HTTPException(status_code=400, detail="bad name")
    p = os.path.join(CFG.TMP_DIR, name)
    if not os.path.isfile(p):
        raise HTTPException(status_code=404, detail="not found")
    media = "application/zip" if name.endswith(".zip") else "video/mp4"
    return FileResponse(p, filename=name, media_type=media)


# ---------------------------------------------------------------------------
# UI
# ---------------------------------------------------------------------------

UI_HTML = r"""<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>抖音无水印下载</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; min-height: 100vh; background: #0f1117; color: #e8eaf0; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 40px 16px 80px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #8b93a7; font-size: 13px; margin-bottom: 24px; }
  textarea { width: 100%; min-height: 110px; resize: vertical; padding: 12px;
             border-radius: 10px; border: 1px solid #2a2f3d; background: #171a23;
             color: inherit; font-size: 14px; }
  .row { display: flex; gap: 10px; margin-top: 12px; align-items: center; }
  button { padding: 10px 22px; border-radius: 10px; border: 0; cursor: pointer;
           background: #fe2c55; color: #fff; font-size: 15px; font-weight: 600; }
  button:disabled { opacity: .5; cursor: wait; }
  .card { margin-top: 20px; border: 1px solid #2a2f3d; border-radius: 12px;
          padding: 14px 16px; background: #171a23; font-size: 14px; }
  .card .t { font-weight: 600; margin-bottom: 6px; word-break: break-all; }
  .card .m { color: #8b93a7; font-size: 13px; line-height: 1.7; word-break: break-all; }
  .card a { color: #4da3ff; text-decoration: none; }
  .bar { height: 6px; background: #2a2f3d; border-radius: 3px; overflow: hidden; margin-top: 10px; display: none; }
  .bar i { display: block; height: 100%; width: 0%; background: #fe2c55; transition: width .2s; }
  .err { color: #ff7a90; }
  .files { margin-top: 28px; }
  .files h2 { font-size: 15px; color: #8b93a7; font-weight: 600; }
  .files a { display: block; padding: 8px 4px; border-bottom: 1px solid #232838; color: #e8eaf0; text-decoration: none; font-size: 14px; }
  .files a:hover { color: #4da3ff; }
  .files .s { color: #8b93a7; font-size: 12px; float: right; }
</style>
</head>
<body>
<div class="wrap">
  <h1>抖音无水印下载 <span style="color:#fe2c55">Douyin Downloader</span></h1>
  <div class="sub">粘贴抖音分享链接（整段复制文本即可）→ 下载无水印、最高清晰度原视频</div>
  <textarea id="input" placeholder="例如：
4.66 复制打开抖音，看看【某某的作品】xxx #标签 ... https://v.douyin.com/xxxxx/ Abc:/"></textarea>
  <div class="row">
    <button id="go" onclick="go()">开始下载</button>
    <span id="status" class="sub"></span>
  </div>
  <div id="results"></div>
  <div class="bar" id="bar"><i></i></div>
  <div class="files" id="files"></div>
</div>
<script>
function links(text) {
  const re = /https?:\/\/(?:[a-z0-9-]+\.)?(?:douyin\.com|iesdouyin\.com|amemv\.com|snssdk\.com)\/[^\s"'<>)\]]+/gi;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[0].replace(/[.,;!?，。；！？]+$/, ''));
  return out;
}
function fmt(n) {
  if (n > 104857600) return (n/104857600).toFixed(2) + ' GB';
  if (n > 102400) return (n/1024/1024).toFixed(1) + ' MB';
  return (n/1024).toFixed(0) + ' KB';
}
function dh(v) {
  // headers with non-ASCII values are percent-encoded by the server
  try { return /%[0-9A-Fa-f]{2}/.test(v || '') ? decodeURIComponent(v) : (v || ''); }
  catch (e) { return v || ''; }
}
async function go() {
  const text = document.getElementById('input').value;
  const ls = links(text);
  const btn = document.getElementById('go');
  const status = document.getElementById('status');
  const results = document.getElementById('results');
  results.innerHTML = '';
  if (!ls.length) { status.textContent = '未识别到抖音链接 / no douyin link found'; return; }
  btn.disabled = true;
  const bar = document.getElementById('bar'); bar.style.display = 'block';
  const fill = bar.querySelector('i');
  for (let i = 0; i < ls.length; i++) {
    status.textContent = `(${i+1}/${ls.length}) 解析中… (解析慢时会自动切换到浏览器模式，请耐心等待)`;
    fill.style.width = '0%';
    const card = document.createElement('div'); card.className = 'card';
    card.innerHTML = '<div class="t">' + ls[i] + '</div><div class="m">解析中…</div>';
    results.appendChild(card);
    try {
      const r = await fetch('/api/download?url=' + encodeURIComponent(ls[i]));
      if (!r.ok) {
        let detail = '';
        try { detail = (await r.json()).detail || ''; } catch (e) {}
        card.querySelector('.m').innerHTML = '<span class="err">失败 / failed: ' + (detail || r.status) + '</span>';
        continue;
      }
      const meta = {
        title: dh(r.headers.get('X-Douyin-Title')),
        author: dh(r.headers.get('X-Douyin-Author')),
        variant: dh(r.headers.get('X-Douyin-Variant')),
        source: r.headers.get('X-Douyin-Source') || '',
      };
      const total = parseInt(r.headers.get('X-Douyin-Size') || r.headers.get('Content-Length') || '0');
      const reader = r.body.getReader();
      const chunks = []; let got = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (total) fill.style.width = Math.min(100, got / total * 100) + '%';
      }
      const blob = new Blob(chunks, { type: r.headers.get('Content-Type') || 'application/octet-stream' });
      const cd = r.headers.get('Content-Disposition') || '';
      let fname = meta.title || 'douyin';
      const m2 = cd.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
      if (m2) { try { fname = decodeURIComponent(m2[1]); } catch (e) { fname = m2[1]; } }
      fname = fname.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 80) || 'douyin';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fname;
      a.textContent = '⬇ ' + fname + ' (' + fmt(got) + ')';
      const mv = card.querySelector('.m');
      mv.innerHTML = (meta.title ? '「' + meta.title + '」' : '')
        + (meta.author ? ' · 作者: ' + meta.author : '')
        + (meta.variant ? ' · ' + meta.variant : '')
        + ' <span style="color:#8b93a7">(' + meta.source + ')</span><br>';
      mv.appendChild(a);
    } catch (e) {
      card.querySelector('.m').innerHTML = '<span class="err">请求错误 / request error: ' + e + '</span>';
    }
    refreshFiles();
  }
  btn.disabled = false;
  status.textContent = '完成 / done';
  bar.style.display = 'none';
}
async function refreshFiles() {
  try {
    const r = await fetch('/api/files');
    const j = await r.json();
    const el = document.getElementById('files');
    if (!j.files.length) { el.innerHTML = ''; return; }
    el.innerHTML = '<h2>最近下载 / recent files</h2>' + j.files.map(f =>
      '<a href="' + f.url + '" download>' + f.name + '<span class="s">' + fmt(f.size) + '</span></a>'
    ).join('');
  } catch (e) {}
}
refreshFiles();
</script>
</body>
</html>
"""


def main():
    import uvicorn

    uvicorn.run(
        app,
        host=CFG.HOST,
        port=CFG.PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
```

### 5.8 deploy/env.example

```bash
# Environment file for the douyin-downloader service (systemd EnvironmentFile).
# Copy to /home/<USER>/douyin-downloader/.env and chmod 600.
#
#   cp deploy/env.example .env
#   chmod 600 .env
#   # then edit API_KEY if you want a different secret

# --- where the app listens -------------------------------------------------
# 127.0.0.1 => only reachable via the local nginx reverse proxy (port 28080).
# Use 0.0.0.0 only if you want to expose the app directly (not recommended).
HOST=127.0.0.1
PORT=8931

# --- API authentication ----------------------------------------------------
# REQUIRED for an API-only deployment. Every /api/* call must present this
# key via the "X-Api-Key" header or the "?key=" query param.
# Generate your own:  python3 -c "import secrets;print(secrets.token_urlsafe(24))"
API_KEY=<YOUR_API_KEY>

# --- frontend --------------------------------------------------------------
# 0 => API-only (no web UI at "/").
ENABLE_UI=0

# --- douyin traffic routing ------------------------------------------------
# Empty = direct connection. On this overseas host that works for douyin
# (verified). Set a proxy only if you later add a mainland-China exit node:
#   DOUYIN_PROXY=http://127.0.0.1:10809
DOUYIN_PROXY=

# --- browser fallback (optional) -------------------------------------------
# 1 = enable the headless-Chromium fallback layer. Requires playwright +
# chromium to be installed (see DEPLOY.md). Set 0 to disable.
BROWSER_ENABLED=1
BROWSER_TIMEOUT=45

# --- storage / cleanup -----------------------------------------------------
TMP_DIR=/home/<USER>/douyin-files
FILE_TTL_HOURS=4

# --- timeouts (seconds) ----------------------------------------------------
HTTP_TIMEOUT=30
DOWNLOAD_TIMEOUT=300
```

### 5.9 deploy/douyin-downloader.service

```ini
# systemd unit for a bare-metal (non-Docker) install.
#
# Install (additive):
#   sudo cp deploy/douyin-downloader.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now douyin-downloader
#
# Assumes the project lives at /home/<USER>/douyin-downloader with a
# virtualenv at .venv and an env file at .env  (see deploy/env.example).
# Adjust User=, WorkingDirectory= and ExecStart if you put it elsewhere.
# The .env file holds API_KEY and friends — keep it private (chmod 600).

[Unit]
Description=Douyin watermark-free downloader (API-only, FastAPI)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/<USER>/douyin-downloader
# EnvironmentFile carries API_KEY / DOUYIN_PROXY / TMP_DIR etc.
EnvironmentFile=/home/<USER>/douyin-downloader/.env
ExecStart=/home/<USER>/douyin-downloader/.venv/bin/python app.py
Restart=always
RestartSec=3
# Keep the app off the public net directly; nginx (port 28080) is the
# only exposed entry point.  The app binds 127.0.0.1:8931 (set HOST in .env).
# Douyin hosts are domestic but the ttwid-based HTTP path works direct from
# overseas; leave DOUYIN_PROXY empty unless you add a mainland exit later.
# Resource caps (tune to the VM):
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### 5.10 deploy/nginx-douyin.conf

```nginx
# nginx reverse proxy for the douyin-downloader API
#
# Install (additive — does not touch existing sites):
#   sudo cp deploy/nginx-douyin.conf /etc/nginx/sites-available/douyin-downloader
#   sudo ln -sf /etc/nginx/sites-available/douyin-downloader /etc/nginx/sites-enabled/douyin-downloader
#   sudo nginx -t && sudo systemctl reload nginx
#
# (If /etc/nginx/sites-enabled does not exist, i.e. RHEL-style layout,
#  put the file in /etc/nginx/conf.d/douyin-downloader.conf instead.)
#
# The app listens on 127.0.0.1:8931 and is only reachable through this
# proxy on port 28080.

upstream douyin_downloader {
    server 127.0.0.1:8931;
}

server {
    listen 28080;
    listen [::]:28080;
    server_name _;

    # small uploads only (the app accepts query strings, not bodies)
    client_max_body_size 1m;

    # video downloads can take a while
    proxy_connect_timeout 15s;
    proxy_send_timeout    900s;
    proxy_read_timeout    900s;

    # no buffering: stream the mp4 bytes as they arrive from the CDN
    proxy_buffering off;

    location / {
        proxy_pass http://douyin_downloader;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 5.11 Dockerfile

```dockerfile
# douyin-downloader image
#
# Building in mainland China?  The default below pulls the playwright
# chromium binary from the npmmirror CDN (fast domestically).  For builds
# outside China you can instead build with:
#   docker build --build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://playwright.azureedge.net -t douyin-downloader .
#
FROM python:3.11-slim

ARG PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
ENV PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST} \
    PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && playwright install --with-deps chromium

COPY dy/ ./dy/
COPY app.py .

RUN useradd -m appuser && mkdir -p /data/douyin && chown -R appuser /data/douyin
ENV TMP_DIR=/data/douyin
USER appuser

EXPOSE 8931
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8931/health', timeout=4)"

CMD ["python", "app.py"]
```

### 5.12 docker-compose.yml

```yaml
services:
  douyin-downloader:
    build: .
    image: douyin-downloader:latest
    container_name: douyin-downloader
    ports:
      - "8931:8931"
    environment:
      # Leave DOUYIN_PROXY empty on a mainland-China server (direct is best).
      # For an overseas server, point it at a mainland exit node, e.g.:
      #   DOUYIN_PROXY: http://127.0.0.1:10809
      DOUYIN_PROXY: ""
      BROWSER_ENABLED: "1"
      PORT: "8931"
    volumes:
      - douyin-files:/data/douyin
    restart: unless-stopped

volumes:
  douyin-files:
```

---

## 6. 部署方法

> 目标形态:**纯 API(无前端)+ API Key 密码 + nginx 反代 28080**,增量部署(不动主机已有内容)。
> 已按此形态在两台机器验证:北京 x86 麒麟(开发机)与方案预演(Oracle 日本 ARM)。

### 6.1 前置要求

- Linux(x86_64 或 ARM64),Python ≥ 3.8(推荐 3.10+),可访问外网
- (可选)浏览器兜底:playwright 官方 chromium(`playwright install --with-deps chromium`,
  ARM64 有官方包,无需额外操作)
- nginx + systemd(或 Docker)

### 6.2 裸机部署(推荐,6 步)

```bash
# 1) 代码就位(把 tar 包解压到任意目录,以下以 /home/<USER>/douyin-downloader 为例)
cd /home/<USER>
tar xzf douyin-downloader-deploy.tar.gz
cd douyin-downloader

# 2) venv + 依赖(境外主机直连 PyPI 即可;国内主机把 pip 源换成清华/阿里镜像)
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3)(可选)浏览器兜底
.venv/bin/playwright install --with-deps chromium

# 4) 环境配置 = 密码 + 开关
cp deploy/env.example .env && chmod 600 .env
#    按需修改 .env:API_KEY(密码)、DOUYIN_PROXY(一般留空=直连)、BROWSER_ENABLED 等
mkdir -p /home/<USER>/douyin-files

# 5) systemd
sudo cp deploy/douyin-downloader.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now douyin-downloader

# 6) nginx 反代 28080
sudo apt-get install -y nginx
sudo cp deploy/nginx-douyin.conf /etc/nginx/sites-available/douyin-downloader
sudo ln -sf /etc/nginx/sites-available/douyin-downloader /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
#    RHEL 系:直接放 /etc/nginx/conf.d/douyin-downloader.conf
```

`.env` 关键项:

```ini
HOST=127.0.0.1            # 只绑回环,nginx 是唯一入口
PORT=8931
API_KEY=<你的密码>        # 所有 /api/* 必须携带
ENABLE_UI=0               # 关网页前端
DOUYIN_PROXY=             # 留空=直连(国内外均可);境外想要"国内体验"再填 CN 出口代理
BROWSER_ENABLED=1
TMP_DIR=/home/<USER>/douyin-files
```

### 6.3 服务器出口与 xray 分流

| 场景 | DOUYIN_PROXY | 说明 |
|---|---|---|
| 国内服务器(如北京) | 留空(直连) | 最优。xray 只给 GitHub/PyPI 这类境外流量用 |
| 境外服务器(如日本/新加坡) | 留空(直连) | **已实测与直连字节级一致**;想要 CN 出口再设代理 |
| 与 xray 端口模式共存 | 留空 | 服务 `trust_env=False`,不吃环境里的 HTTP_PROXY,xray 怎么配都不影响它 |
| 想强制 CN 出口 | `http://127.0.0.1:10809` 等 | 对分享页/元数据/CDN/浏览器全部生效 |

xray 规则建议(国内机):`douyin.com / iesdouyin.com / m.douyin.com / *.bytecdn.com /
*.bytedance.com / *.zijieapi.com / aweme.snssdk.com / ttwid.bytedance.com` → DIRECT;
`github.com / pypi.org / playwright.azureedge.net` → vless。

### 6.4 防火墙 / 云安全组

- 主机防火墙:放行 **28080/tcp**(ufw: `sudo ufw allow 28080/tcp`)。
- 云安全组(Oracle VCN / 阿里云安全组等):**入站放行 28080** —— 只能在控制台做,
  否则外部访问必超时。
- 8931 永远只绑 127.0.0.1,无需对外。

### 6.5 Docker(可选)

```bash
docker compose up -d --build        # 国内构建可保持默认 npmmirror;境外:
# docker compose build --build-arg PLAYWRIGHT_DOWNLOAD_HOST=https://playwright.azureedge.net
```

`docker-compose.yml` 暴露 8931;如需 nginx 形态,在前面同样加一层反代即可。
镜像 python:3.11-slim(多架构,ARM64 可用)。

### 6.6 部署验证(验收清单)

```bash
B=http://127.0.0.1:28080
KEY=<你的API_KEY>

curl -s $B/health                                   # 200 {"ok":true,...}
curl -s -o /dev/null -w "%{http_code}\n" "$B/api/info?url=x"            # 401
curl -s -o /dev/null -w "%{http_code}\n" "$B/"                            # 404 (无前端)
curl -s -H "X-Api-Key: $KEY" -o t.mp4 -w "%{http_code}\n"   "$B/api/download?url=https%3A%2F%2Fv.douyin.com%2FtI_NEaY3RG4%2F"        # 200
# t.mp4 应为 ~13,339,408 字节、ftyp 合法 MP4、1920x1080
# 再从第二台机器 curl http://<主机IP>:28080/... 验证公网可达
```

---

## 7. API 文档

Base:`http://<host>:28080`。所有 `/api/*` 需要 API Key(头 `X-Api-Key: <key>` 或查询参数
`?key=<key>`),否则 `401 {"detail":"invalid or missing api key"}`。`/health` 免鉴权。

| 端点 | 说明 |
|---|---|
| `GET /health` | `{"ok":true,"browser_enabled":...,"proxy":"(direct)","tmp_dir":...}` |
| `GET /api/info?url=` | 元数据 JSON:`meta`(标题/作者/时长/分辨率/点赞/uri)、`candidate_urls`(可用的无水印 CDN 直链)、`source`(`http`/`browser`)、`kind`(`video`/`images`)、`share_url` |
| `GET /api/download?url=` | 流式返回文件(mp4 或 photos.zip)。响应头:`X-Douyin-Title` / `X-Douyin-Author` / `X-Douyin-Variant` / `X-Douyin-Source` / `X-Douyin-Size`;`Content-Disposition` 用 RFC 5987 编码中文文件名;非 ASCII 头值为百分号编码(UI 会解码) |
| `GET /api/files` | 最近下载文件列表 |
| `GET /api/files/<name>` | 重新下载已保留文件 |

`url` 参数接受:短链 / 整段分享文案 / `www.douyin.com/video/<id>` / 19 位裸 ID。

```bash
# 下载(带密码)
curl -L -H "X-Api-Key: $KEY" -o video.mp4 \
  "http://<HOST_IP>:28080/api/download?url=https%3A%2F%2Fv.douyin.com%2FtI_NEaY3RG4%2F"
```

错误约定:业务错误返回 422 + `{"detail":"<可读原因>"}`(链接无效/视频被删/私有/地区限制/CDN 全挂等)。

---

## 8. 实测验证结果

样例:`https://v.douyin.com/tI_NEaY3RG4/`(aweme_id `7687202250602976234`,
"一曲佳人伴孤灯,愿听完的人万事渐顺",作者 应瑾笛箫)

| 出口 | 结果 |
|---|---|
| 北京直连(麒麟 x86,py3.7 venv) | 200,13,339,408 B,1920×1080 H.264,28.9s,md5 `1c35a9c1...`,ftyp ✓ |
| 日本出口(经 <HOST_IP> 的 xray,模拟境外部署) | 200,**md5 完全一致** |
| 输入形态 | 短链 ✓ / 整段分享文案 ✓ / 裸 ID ✓ / 桌面链接 ✓(自动转分享页) |
| 浏览器兜底层 | worker 线程内 9.6s 取到数据(ttwid 预置 → SSR DOM) |
| 鉴权矩阵 | 无 key 401 / 错 key 401 / 对 key 通过 / health 开放 / UI 关闭时 404 |

---

## 9. 运维与故障排查

```bash
systemctl restart douyin-downloader     # 重启
journalctl -u douyin-downloader -f      # 日志
```

| 症状 | 原因 / 处理 |
|---|---|
| `could not read video data (deleted / private ...)` | 视频本身不可用(已删/私有/地区限)。换一条公开视频验证链路 |
| SSR 偶发无数据 | 风控波动:服务会自动重注册 ttwid 重试一次;持续失败可重启或设 CN 出口 `DOUYIN_PROXY` |
| 28080 公网不通 | 云安全组未放行 28080(控制台)/ ufw 未放行 |
| nginx 502 | 应用没起来:`systemctl status douyin-downloader` |
| 401 但 key 正确 | 客户端 key 与 `.env` 不一致(空格/换行);`?key=` 需 URL 编码 |
| 麒麟 py3.7 + 老 playwright | 已内置:worker 线程注入 ThreadedChildWatcher 绕开 py3.7 signal 限制;chromium 自动降级链(`CHROMIUM_PATH` → ms-playwright 缓存最新 → 系统浏览器) |
| 改密码 | 改 `.env` 后 `systemctl restart douyin-downloader` |
| ttwid 失效 | 删 `$TMP_DIR/.ttwid`,下次请求自动重注册 |

回滚(增量部署 → 删除即还原):

```bash
sudo systemctl disable --now douyin-downloader
sudo rm /etc/systemd/system/douyin-downloader.service
sudo rm /etc/nginx/sites-enabled/douyin-downloader /etc/nginx/sites-available/douyin-downloader
sudo nginx -t && sudo systemctl reload nginx
rm -rf /home/<USER>/douyin-downloader /home/<USER>/douyin-files
```

---

*笔记生成:2026-10;源码快照与 `douyin-downloader-deploy.tar.gz` 一致。*
