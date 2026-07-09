+++
title = "网站架构与部署说明"
date = "2025-11-02"
lastmod = "2025-11-02"
description = "记录这个 Hugo + Cloudflare Pages 站点的目录结构、渲染方式、部署链路和日常发布流程。"
url = "/site-architecture-and-deployment/"
draft = false
+++

这篇文章专门用来说明当前这个站点是怎样组织、怎样构建、又怎样发布到线上去的。它不是泛泛而谈的 Hugo 教程，而是针对这个仓库本身的一份工程说明。

{{< toc >}}

## 一、项目定位

这个项目是一个非常轻量的静态博客站点，核心技术栈只有三层：

1. 内容层：使用 Markdown 维护页面和文章。
2. 构建层：使用 Hugo 把内容、模板和样式编译成静态文件。
3. 部署层：使用 Cloudflare Pages 连接 GitHub 仓库，在每次推送后自动构建并发布。

这意味着整个站点没有传统意义上的后端服务，也没有数据库依赖。页面访问时，用户拿到的是已经提前生成好的 HTML、CSS 和其他静态资源，所以结构简单、上线稳定、访问速度也比较容易保证。

## 二、仓库结构

当前仓库的核心结构很简单：

```text
config.toml
content/
  _index.md
  about/
    index.md
  posts/
themes/
  air1/
    assets/css/
    layouts/
```

可以把它理解成三块：

### 1. `config.toml`

这是全站配置入口，负责定义站点级参数，例如：

- `baseURL`：站点主地址。
- `title`：站点标题。
- `theme`：当前使用的主题名称，这里是 `air1`。
- `languageCode` 和 `defaultContentLanguage`：语言设置。
- `relativeURLs = true`：尽量使用相对链接，方便站点在不同域名或预览域下工作。
- `enableRobotsTXT = true`：自动生成 `robots.txt`。
- `pagination.pagerSize = 10`：文章列表每页展示数量。
- `[menu]`：顶部导航，目前主要是 `post` 和 `about`。
- `[params]`：自定义参数，比如站点描述、页脚文案、作者名和 favicon 地址。

站点很多“可改但不需要改模板”的信息，都会放在这里。

### 2. `content/`

这里是站点内容本体。

- `content/_index.md`：首页内容。
- `content/about/index.md`：关于页内容。
- `content/posts/*.md`：博客文章。

Hugo 会把这些 Markdown 文件读取进来，再根据模板渲染成最终页面。换句话说，写文章、改页面，本质上都是在维护这个目录。

### 3. `themes/air1/`

这里放的是站点主题，也就是页面结构和视觉表现层。

这个项目没有把主题单独当成远程依赖，而是直接把主题代码放在仓库里一起维护。这样做有两个好处：

1. 主题改动和站点改动可以一起提交，版本一致。
2. Cloudflare Pages 在构建时不需要额外拉子模块，流程更直接。

## 三、页面渲染架构

这个站点虽然简单，但结构是清晰分层的。

### 1. 页面骨架：`layouts/_default/baseof.html`

这是全站最外层的 HTML 骨架，负责把页面拆成几个固定区域：

- `<head>`：由 `partials/head.html` 输出。
- `<header>`：由 `partials/header.html` 输出。
- `<main id="content">`：由不同页面模板填充主体内容。
- `<footer>`：由 `partials/footer.html` 输出。

可以把它理解成站点的总框架，所有页面最终都会套在这个壳子里。

### 2. 头部与元信息：`layouts/partials/head.html`

这个文件负责页面 SEO 和资源装配，主要包括：

- 页面标题计算。
- 页面描述提取。
- 作者信息。
- `robots` 元信息。
- favicon 输出。
- RSS 链接。
- Open Graph 和 Twitter Card 元信息。
- 样式表拼接与压缩。

这里还有一个很实用的设计：主题会把 `assets/css/main.css`、`min770px.css`、`dark.css`、`syntax.css` 通过 Hugo 的资源管线拼接后再输出。这样线上拿到的是合并和压缩后的 CSS，而不是零散文件。

### 3. 顶部导航：`layouts/partials/header.html`

顶部区域会读取 `config.toml` 里的菜单配置，按权重输出导航链接。现在导航本身非常简洁，只有站点标题和少量菜单项，符合这个项目“轻量、低干扰”的风格。

### 4. 文章列表：`layouts/partials/posts.html`

这个文件负责首页或列表页上的文章集合展示。它做了几件事：

1. 从 `site.RegularPages` 中筛出 `Section = "posts"` 的页面。
2. 调用 `.Paginate` 做分页。
3. 使用 `li.html` 渲染每一篇文章的列表项。
4. 在文章数量超过一页时输出 `prev`、页码和 `next`。

因此，新增文章后，只要文件位于 `content/posts/`，它就会自动进入列表，不需要再手动改首页。

### 5. 文章详情：`layouts/_default/single.html`

单篇文章页负责输出：

- 标题。
- 发布时间或更新时间。
- 正文内容。
- 底部返回文章列表的导航。

当前主题的思路很明确：重点是阅读，不做复杂装饰，所以文章详情页的结构也非常克制。

### 6. 样式层：`themes/air1/assets/css/`

当前样式主要分成四份：

- `main.css`：基础布局与常规样式。
- `min770px.css`：较宽屏幕下的样式调整。
- `dark.css`：深色模式相关样式。
- `syntax.css`：代码高亮样式。

这种拆分方式能让样式职责更明确，也方便后续逐块维护。

## 四、内容到页面的生成流程

当仓库里新增或修改一篇文章时，生成过程大致是这样的：

1. 在 `content/posts/` 下新增一个 Markdown 文件。
2. 在 front matter 中写入标题、日期、描述、URL 等元信息。
3. Hugo 读取 `config.toml`、内容文件和主题模板。
4. Hugo 使用 Goldmark 把 Markdown 转成 HTML。
5. Hugo 把内容套进主题模板里，生成最终静态页面。
6. 构建结果输出到 `public/` 目录。

也就是说，内容、模板、配置三者在构建时会汇合，最终变成浏览器看到的站点。

## 五、部署架构

这个项目的线上部署链路非常直接：

```text
本地修改
-> git commit
-> git push 到 GitHub
-> Cloudflare Pages 拉取仓库
-> Hugo 构建静态文件
-> 发布到 Pages
-> 通过 pages.dev 或自定义域名访问
```

这条链路的好处是：

- 变更来源单一，所有发布都可追踪到 Git 提交。
- 不需要手动上传文件。
- 回滚方便，只要回退到历史提交重新推送即可。
- Cloudflare 会自动处理静态托管、缓存和全球分发。

## 六、Cloudflare Pages 的构建配置

根据当前项目的设计，这个站点在 Cloudflare Pages 上的关键配置应当是：

```text
Framework preset: Hugo
Build command: hugo --gc --minify
Build output directory: public
Root directory: /
```

建议环境变量：

```text
HUGO_VERSION = 0.147.7
```

这里每一项都有明确作用：

- `Framework preset: Hugo`：让 Pages 按 Hugo 项目处理。
- `hugo --gc --minify`：构建时清理未使用资源，并压缩输出。
- `public`：这是 Hugo 默认的静态输出目录。
- `Root directory: /`：说明仓库根目录就是 Hugo 项目根目录。
- `HUGO_VERSION`：固定 Hugo 版本，减少本地与线上构建差异。

## 七、为什么这个部署方式适合当前项目

对这个站点来说，GitHub + Cloudflare Pages 的组合非常合适，原因主要有四个：

### 1. 内容型站点不需要复杂运行环境

博客本质上是“写完就展示”的场景，静态站点生成非常匹配，不需要数据库、容器编排或常驻服务。

### 2. 发布动作天然适合 Git 工作流

文章、配置、主题都在同一个仓库里，提交一次就是一个完整变更单元。以后不管是追踪问题、回溯版本，还是协作维护，都很清晰。

### 3. Cloudflare Pages 几乎不增加运维负担

Pages 已经把构建触发、静态托管、CDN 分发、HTTPS 等能力打包好了。对于个人博客，这种托管方式性价比很高。

### 4. 当前主题本来就偏向“少即是多”

这个项目的主题结构简单、资源少、前端逻辑轻，因此非常适合静态分发，不需要为了部署去引入额外复杂度。

## 八、一次完整发布通常怎么做

如果按日常维护的角度看，这个站点的发布流程通常是下面这样：

1. 在本地修改 `content/`、`config.toml` 或主题文件。
2. 本地预览：

```bash
hugo server
```

3. 确认内容和样式无误后提交：

```bash
git add -A
git commit -m "Describe the change"
git push origin main
```

4. Cloudflare Pages 检测到 `main` 分支更新后自动开始构建。
5. 构建成功后，新版本自动上线。

如果只是写文章，绝大多数情况下不需要碰部署平台本身；只要把文章正确提交到仓库里，剩下的工作交给 Pages 就可以了。

## 九、当前项目里值得注意的细节

结合这个仓库本身，还有几个细节值得记录下来：

### 1. 站点使用相对链接

`relativeURLs = true` 让站点在 `*.pages.dev` 预览域名和正式域名之间切换时更从容，减少因为绝对路径写死导致的问题。

### 2. favicon 使用外部图床地址

当前 favicon 不是放在仓库本地，而是通过配置项引用外部 SVG 地址。这样改图标很方便，但也意味着图标展示会依赖图床域名的可用性。

### 3. 主题与站点同仓维护

这让“改内容”和“改主题”可以在同一次提交里完成，特别适合个人站点快速迭代。

### 4. 当前文章系统是纯文件驱动

没有后台，没有 CMS，没有数据库。要新增文章，只需要新增一个 Markdown 文件；要删除文章，直接删除对应文件即可。

## 十、总结

这个站点的核心思路其实很简单：

- 用 `content/` 管内容。
- 用 `themes/air1/` 管展示。
- 用 `config.toml` 管站点级行为。
- 用 Hugo 负责构建。
- 用 GitHub 和 Cloudflare Pages 负责发布。

这种架构的优势不在于“功能多”，而在于“路径短”。从写下文章，到提交仓库，到自动上线，整条链路清晰、稳定，而且非常适合长期维护。

后续如果这个站点要继续扩展，最自然的方向通常会是：

- 增加更多文章。
- 继续微调主题样式。
- 补充归档、标签或分类页。
- 视需要增加评论、搜索或统计能力。

但在当前阶段，这个架构已经足够支撑一个简洁、稳定、低维护成本的个人发布站点。
