+++
title = "Film Vault 部署与维护记录"
date = "2026-05-11"
lastmod = "2026-05-11"
description = "记录Film Vault影视墙从代码拉取、本地预览、维护生成，到Cloudflare Pages部署、KV/Secrets配置，以及管理员权限、线上逻辑与常见问题排查的全流程，助力高效部署与稳定维护。"
url = "/film-vault-deployment-and-maintenance-note/"
aliases = ["/posts/film-vault-deployment-and-maintenance-note/"]
categories = ["笔记"]
draft = false
+++
本文覆盖范围：

- 拉取代码
- 理解目录结构
- 本地预览
- 本地维护
- 重新生成静态片库
- 部署到 Cloudflare Pages
- 配置 KV / Secrets
- 理解管理员登录与线上写入逻辑
- 排查搜索、分页、KV 覆盖、静态数据同步等问题

---

## 1. 项目定位

Film Vault 是一个个人长期使用的**影视墙**项目。

核心目标：

- 公开展示自己已经看过的影视作品
- 允许访客搜索和浏览片库
- 只有管理员登录后，才可以添加或删除影视
- 本地双击可以预览
- Cloudflare Pages 上线后可以在线维护
- 线上数据以 **Cloudflare KV** 为主，但仓库里的 `data/*` 仍然保留作为静态基线

项目已经支持：

- 电影（movie）
- 电视剧（tv）

管理员搜索支持分页，方便处理重名作品。

---

## 2. 仓库目录

仓库根目录：

`C:\Users\haenl\Documents\Codex\2026-04-23-d-1a-web-films-web-tmdb`

### 2.1 目录说明

```text
.
├─ .github/
│  └─ workflows/
│     └─ rebuild-library.yml          # GitHub Actions（可选，用于重建片库）
├─ data/
│  ├─ library.json                    # 源片单（title / year / tmdbId / media_type）
│  ├─ library.resolved.json           # 前端完整静态片库
│  ├─ library.source.js               # 本地 file:// 预览用的数据脚本
│  └─ library.resolved.js             # 本地 file:// 预览用的数据脚本
├─ scripts/
│  ├─ add-movie.mjs                   # 本地命令行搜索并添加影视
│  ├─ rebuild-library.mjs             # 根据源片单重建完整静态片库
│  └─ lib/
│     ├─ movie-db.mjs                 # TMDB 请求封装
│     └─ library-files.mjs            # 片库文件读写
├─ index.html                         # 页面结构
├─ styles.css                         # 样式
├─ app.js                             # 前端逻辑
├─ _worker.js                         # Cloudflare Pages / Workers 管理接口
├─ favicon.svg                        # 网站图标
├─ wrangler.example.toml              # Cloudflare 配置模板
├─ admin.local.example.js             # 本地管理员配置模板
├─ package.json                       # npm scripts
├─ README.md                          # GitHub 首页说明
└─ FilmVault-博客版部署笔记.md         # 这份详细笔记
```


---

## 3. 为什么 `data/*` 文件不能删

这是项目里一个容易误判的点。

线上虽然主要读写 Cloudflare KV，但仓库里的 `data/*` 文件依然必须保留，因为它们承担了 4 个作用：

1. **初始种子数据**
   - 新环境第一次部署时，KV 可能是空的
   - 这时 Worker 需要仓库里的静态片库做初始数据源

2. **KV 自动纠偏**
   - 如果 KV 里残留了旧数据，Worker 会比较静态文件的 `generatedAt`
   - 当 GitHub 中的静态片库更新时，会自动覆盖旧 KV

3. **本地 `file://` 预览**
   - 双击 `index.html` 时，页面优先读 `library.source.js` / `library.resolved.js`

4. **版本化备份**
   - 仓库里的静态片库是可以追踪、回滚、审计的

结论：

- 线上：以 KV 为主
- 仓库：保留 `data/*` 作为基线

---

## 4. 获取项目

### 4.1 克隆仓库

```bash
git clone https://github.com/haenlau/films.git
cd films
```


### 4.2 Node.js 版本

推荐：

- Node.js 18+

虽然本地纯预览不依赖 Node，但脚本维护和片库重建需要。

---

## 5. 本地预览

### 5.1 直接双击打开

直接双击：

`index.html`

项目已经兼容 `file://` 打开方式。

页面优先读取：

- `data/library.source.js`
- `data/library.resolved.js`

所以即使没有本地 HTTP 服务，也能正常显示片库。

### 5.2 本地管理员模式

本地管理员模式用于：

- 本地登录
- 控制台添加影视
- 导出片单
- 导出完整数据

#### 步骤一：创建本地配置文件

复制模板：

```bash
copy admin.local.example.js admin.local.js
```


#### 步骤二：填写本地配置

```js
window.FILM_VAULT_ADMIN = {
  apiKey: "YOUR_TMDB_API_KEY",
  password: "YOUR_LOCAL_ADMIN_PASSWORD"
};
```


注意：

- `admin.local.js` **不要提交到 Git**
- 它已经在 `.gitignore` 中

#### 步骤三：本地使用流程

1. 双击打开 `index.html`
2. 右上角点击 `登录管理`
3. 输入 `admin.local.js` 中的本地密码
4. 登录成功后，出现 `控制台`
5. 控制台中可用：
   - `添加影视`
   - `导出片单`
   - `导出数据`

---

## 6. 源片单与完整片库

### 6.1 `data/library.json`

这是“源片单”，适合人工维护或脚本维护。

推荐结构：

```json
{
  "title": "我的影视墙",
  "subtitle": "一面为私人观影史准备的影视墙。",
  "generatedAt": "2026-05-11T14:30:48.507Z",
  "entries": [
    {
      "title": "黑洞频率",
      "year": 2000,
      "tmdbId": 10559,
      "media_type": "movie"
    },
    {
      "title": "怪奇物语",
      "year": 2016,
      "tmdbId": 66732,
      "media_type": "tv"
    }
  ]
}
```


字段说明：

- `title`：片名或剧名
- `year`：年份，可选但强烈建议保留
- `tmdbId`：TMDB 唯一 ID，可选但推荐保留
- `media_type`：`movie` 或 `tv`

建议：

- 手工维护时，优先保留 `tmdbId`
- 如果没有 `tmdbId`，脚本会搜索匹配，但重名作品有误匹配风险

### 6.2 `data/library.resolved.json`

这是前端直接使用的完整片库数据。

包含：

- 海报
- 背景图
- 评分
- 上映/首播时间
- 地区
- 类型
- 制作公司
- 演员
- 简介
- `media_type`

这个文件不建议手工维护，推荐脚本生成。

### 6.3 本地预览用的 JS 数据文件

为了兼容 `file://`，项目会额外生成：

- `data/library.source.js`
- `data/library.resolved.js`

格式示例：

```js
window.__FILM_VAULT_SOURCE__ = {
  "title": "我的影视墙",
  "subtitle": "一面为私人观影史准备的影视墙。",
  "entries": [...]
};

window.__FILM_VAULT_RESOLVED__ = {
  "title": "我的影视墙",
  "subtitle": "一面为私人观影史准备的影视墙。",
  "movies": [...]
};
```


---

## 7. 命令行维护片库

### 7.1 配置 `.dev.vars`

在项目根目录创建：

`.dev.vars`

内容示例：

```env
TMDB_API_KEY=YOUR_TMDB_API_KEY
```


### 7.2 按名称搜索并添加影视

```bash
npm run add:movie -- 怪奇物语
```


### 7.3 根据源片单重建完整片库

```bash
npm run rebuild:library
```


### 7.4 `package.json` 中的脚本

```json
{
  "name": "film-vault-wall",
  "private": true,
  "type": "module",
  "scripts": {
    "rebuild:library": "node ./scripts/rebuild-library.mjs",
    "add:movie": "node ./scripts/add-movie.mjs"
  }
}
```


---

## 8. TMDB 接口支持范围

这个项目最终不是“电影墙”，而是“影视墙”。

所以当前搜索和详情逻辑支持：

- 电影：`movie`
- 电视剧：`tv`

### 8.1 搜索逻辑

管理员控制台中的“添加影视”搜索支持：

- `movie`
- `tv`

并且支持分页。

当前实现策略：

- 云端 Worker：`/search/multi?page=...`
- 本地浏览器：`/search/multi?page=...`
- 最终只保留 `movie/tv` 类型结果

### 8.2 详情逻辑

添加时按 `media_type` 分流：

- `movie -> /movie/{id}`
- `tv -> /tv/{id}`

这是为了保证：

- 搜电影时拿电影详情
- 搜电视剧时拿剧集详情

---

## 9. 控制台中的搜索分页

这是当前版本的重要能力。

### 9.1 行为规则

- 未搜索时：不显示分页控件
- 搜索后只有 1 页：不显示分页控件
- 搜索后有多页：显示分页控件

分页控件包括：

- `上一页`
- `第 X / Y 页`
- `下一页`

### 9.2 为什么需要分页

很多影视作品存在：

- 同名电影
- 同名电视剧
- 不同年份重拍
- 不同地区翻拍

如果不支持翻页，第一页找不到时就无法继续筛选。

### 9.3 关键实现思路

```js
state.searchQuery = query;
state.searchPage = 1;
state.searchPerformed = true;

const payload = state.admin.mode === "remote"
  ? await remoteSearchMovies(state.searchQuery, state.searchPage)
  : await localSearchMovies(state.searchQuery, state.searchPage);

state.searchResults = payload.results || [];
state.searchTotalPages = Math.max(1, Number(payload.total_pages || 1));
renderSearchResults();
renderSearchPagination();
```


```js
const page = Math.max(1, Number(body.page || 1));

const response = await fetch(buildTmdbUrl("/search/multi", env.TMDB_API_KEY, {
  language: "zh-CN",
  query,
  include_adult: "false",
  page: String(page),
}));

return json({
  results,
  total_pages: Number(payload.total_pages || 1),
});
```


---

## 10. Cloudflare 部署

推荐使用 **Cloudflare Pages**。

### 10.1 为什么不是纯 Workers

因为这个项目是：

- 静态站点：`index.html` / `styles.css` / `app.js`
- 服务端接口：`_worker.js`

所以最适合：

- Pages 托管静态资源
- `_worker.js` 提供管理员接口

### 10.2 Pages 构建配置

连接 GitHub 仓库后：

| 项目 | 值 |
|------|----|
| Framework preset | `None` |
| Build command | 留空 |
| Build output directory | `.` |

### 10.3 `wrangler.example.toml`

```toml
name = "films"
compatibility_date = "2026-04-23"

pages_build_output_dir = "."

[[kv_namespaces]]
binding = "FILM_VAULT_KV"
id = "replace-with-your-kv-namespace-id"
preview_id = "replace-with-your-preview-kv-namespace-id"
```


### 10.4 必要的 KV 配置

创建一个 KV namespace，并绑定：

| 项目 | 值 |
|------|----|
| KV namespace binding | `FILM_VAULT_KV` |

### 10.5 必要的 Secrets

在 Cloudflare Pages 中配置：

| Secret | 用途 |
|--------|------|
| `TMDB_API_KEY` | TMDB API 密钥 |
| `ADMIN_PASSWORD` | 线上管理员登录密码 |
| `SESSION_SECRET` | 会话签名密钥 |

### 10.6 Worker 的职责

`_worker.js` 主要负责：

- 公开读取片库：`/api/library`
- 管理员登录：`/api/admin/session`
- 管理员搜索影视：`/api/admin/search`
- 管理员添加影视：`/api/admin/add`
- 管理员删除影视：`/api/admin/remove`

### 10.7 线上数据读写逻辑

线上优先读 Cloudflare KV。

但为了避免 KV 停留在旧数据，Worker 还会：

- 读取仓库静态文件 `data/library.json`
- 读取仓库静态文件 `data/library.resolved.json`
- 比较 `generatedAt`
- 如果仓库静态数据更“新”，就自动覆盖旧 KV

这个机制很重要，因为它保证：

- GitHub 中的片库更新后
- Cloudflare 重新构建
- 线上不会永远停留在旧 KV

---

## 11. 管理员使用逻辑

### 11.1 普通访客

- 只能浏览片库
- 只能搜索已添加的影视
- 看不到管理功能

### 11.2 管理员

1. 点击 `管理员登录`
2. 输入密码
3. 登录成功后出现 `控制台`
4. 控制台中可执行：
   - `添加影视`
   - `导出片单`
   - `导出数据`
5. 在线上环境中，添加/删除会直接写入 Cloudflare KV

---

## 12. 默认排序与前端说明

### 12.1 默认排序

站点默认按：

`上映时间`

而不是评分优先。

### 12.2 当前文案说明

当前项目已经统一到“影视”语义，而不是“电影”：

- 我的影视墙
- 影视库搜索
- 添加影视
- 已看影视

---

## 13. Git 提交流程

### 13.1 进入仓库目录

```bash
cd C:\Users\haenl\Documents\Codex\2026-04-23-d-1a-web-films-web-tmdb
```


### 13.2 查看状态

```bash
git status
```


### 13.3 提交全部改动

```bash
git add .
git commit -m "your commit message"
git push
```


### 13.4 只提交部分文件

```bash
git add app.js _worker.js index.html styles.css README.md
git commit -m "your commit message"
git push
```


---

## 14. 隐私与敏感信息

### 14.1 不应提交到 GitHub 的文件

- `admin.local.js`
- `.dev.vars`
- `.env`
- `.env.local`
- 任何真实 API Key、密码、会话密钥

### 14.2 可以提交到仓库的内容

- `admin.local.example.js`
- `.dev.vars.example`
- `README.md` 中的变量名说明
- `_worker.js` 中的环境变量读取代码

注意：

- 变量名不是敏感信息
- 真正敏感的是“实际值”

---

## 15. 常见问题与排查

### 15.1 线上为什么还是旧片库

先检查：

- Cloudflare 当前部署对应的 commit 是否最新
- `FILM_VAULT_KV` 是否绑定正确
- `data/library.resolved.json` 是否带最新 `generatedAt`

### 15.2 为什么搜索不到目标作品

常见原因：

- 同名作品太多
- 目标在后面的分页中
- 中文名和原名差异较大
- 目标是剧集、番组、特别篇而不是电影

解决方式：

- 继续翻页查找
- 在源片单中明确 `tmdbId`
- 明确 `media_type`

### 15.3 为什么本地能搜，线上添加失败

常见原因：

- Cloudflare 没部署到最新 commit
- Worker 仍在跑旧逻辑
- `TMDB_API_KEY` 未配置
- `ADMIN_PASSWORD` / `SESSION_SECRET` 未配置
- KV 绑定不正确

### 15.4 为什么 `data/*` 不能删

因为它们负责：

- 初始种子
- KV 纠偏
- 本地预览
- 可追踪版本基线

---

## 16. 推荐维护方式

### 方案 A：本地页面维护

适合直接在浏览器里操作：

1. 配置 `admin.local.js`
2. 双击打开 `index.html`
3. 登录管理
4. 添加影视
5. 导出片单 / 导出数据
6. 提交到 GitHub

### 方案 B：命令行批量维护

适合大规模调整：

1. 修改 `data/library.json`
2. 执行 `npm run rebuild:library`
3. 提交到 GitHub

### 方案 C：线上 Cloudflare 管理

适合日常在线维护：

1. 打开线上站点
2. 管理员登录
3. 在控制台里添加或删除影视
4. 数据直接写入 KV

---

## 17. 推荐环境

- Node.js 18+
- Cloudflare Pages
- Chrome / Edge / Safari 最新版本
- Windows PowerShell 或任意可用终端

---

## 18. 结论

这个项目最终是一个：

- 本地可预览
- 线上可部署
- 管理员可登录
- 支持电影和电视剧
- 支持分页搜索
- 线上数据由 Cloudflare KV 托管
- 仓库静态数据用于基线和纠偏

的个人影视墙系统。

只要保留好：

- 仓库代码
- `data/*`
- Cloudflare 的 KV 和 Secrets

几年后重新看到这份笔记，依然可以完整恢复。
