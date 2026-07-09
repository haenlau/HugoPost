+++
title = "Film Vault 影视墙部署与维护笔记"
date = "2026-05-11"
lastmod = "2026-05-11"
description = "记录Film Vault影视墙从代码拉取、本地预览、维护生成，到Cloudflare Pages部署、KV/Secrets配置，以及管理员权限、线上逻辑与常见问题排查的全流程，助力高效部署与稳定维护。"
url = "/film-vault-deployment-and-maintenance-note/"
aliases = ["/posts/film-vault-deployment-and-maintenance-note/"]
draft = false
+++
<h1 id="film-vault-影视墙完整部署与维护笔记">Film Vault 影视墙完整部署与维护笔记</h1>

<ul>
<li>拉取代码</li>
<li>理解目录结构</li>
<li>本地预览</li>
<li>本地维护</li>
<li>重新生成静态片库</li>
<li>部署到 Cloudflare Pages</li>
<li>配置 KV / Secrets</li>
<li>理解管理员登录与线上写入逻辑</li>
<li>排查搜索、分页、KV 覆盖、静态数据同步等问题</li>
</ul>

<hr/>

<h2 id="1-项目定位">1. 项目定位</h2>

<p>Film Vault 是一个个人长期使用的<strong>影视墙</strong>项目。</p>

<p>核心目标：</p>

<ul>
<li>公开展示自己已经看过的影视作品</li>
<li>允许访客搜索和浏览片库</li>
<li>只有管理员登录后，才可以添加或删除影视</li>
<li>本地双击可以预览</li>
<li>Cloudflare Pages 上线后可以在线维护</li>
<li>线上数据以 <strong>Cloudflare KV</strong> 为主，但仓库里的 <code>data/*</code> 仍然保留作为静态基线</li>
</ul>

<p>项目已经支持：</p>

<ul>
<li>电影（movie）</li>
<li>电视剧（tv）</li>
</ul>

<p>管理员搜索支持分页，方便处理重名作品。</p>

<hr/>

<h2 id="2-仓库目录">2. 仓库目录</h2>

<p>仓库根目录：</p>

<p><code>C:\Users\haenl\Documents\Codex\2026-04-23-d-1a-web-films-web-tmdb</code></p>

<h3 id="21-目录说明">2.1 目录说明</h3>

<pre><code class="language-text">.
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
└─ FilmVault-博客版部署笔记.md         # 这份详细笔记</code></pre>

<hr/>

<h2 id="3-为什么-data-文件不能删">3. 为什么 <code>data/*</code> 文件不能删</h2>

<p>这是项目里一个容易误判的点。</p>

<p>线上虽然主要读写 Cloudflare KV，但仓库里的 <code>data/*</code> 文件依然必须保留，因为它们承担了 4 个作用：</p>

<ol>
<li>
<p><strong>初始种子数据</strong></p>
<ul>
<li>新环境第一次部署时，KV 可能是空的</li>
<li>这时 Worker 需要仓库里的静态片库做初始数据源</li>
</ul>
</li>
<li>
<p><strong>KV 自动纠偏</strong></p>
<ul>
<li>如果 KV 里残留了旧数据，Worker 会比较静态文件的 <code>generatedAt</code></li>
<li>当 GitHub 中的静态片库更新时，会自动覆盖旧 KV</li>
</ul>
</li>
<li>
<p><strong>本地 <code>file://</code> 预览</strong></p>
<ul>
<li>双击 <code>index.html</code> 时，页面优先读 <code>library.source.js</code> / <code>library.resolved.js</code></li>
</ul>
</li>
<li>
<p><strong>版本化备份</strong></p>
<ul>
<li>仓库里的静态片库是可以追踪、回滚、审计的</li>
</ul>
</li>
</ol>

<p>结论：</p>

<ul>
<li>线上：以 KV 为主</li>
<li>仓库：保留 <code>data/*</code> 作为基线</li>
</ul>

<hr/>

<h2 id="4-获取项目">4. 获取项目</h2>

<h3 id="41-克隆仓库">4.1 克隆仓库</h3>

<pre><code class="language-bash">git clone https://github.com/haenlau/films.git
cd films</code></pre>

<h3 id="42-nodejs-版本">4.2 Node.js 版本</h3>

<p>推荐：</p>

<ul>
<li>Node.js 18+</li>
</ul>

<p>虽然本地纯预览不依赖 Node，但脚本维护和片库重建需要。</p>

<hr/>

<h2 id="5-本地预览">5. 本地预览</h2>

<h3 id="51-直接双击打开">5.1 直接双击打开</h3>

<p>直接双击：</p>

<p><code>index.html</code></p>

<p>项目已经兼容 <code>file://</code> 打开方式。</p>

<p>页面优先读取：</p>

<ul>
<li><code>data/library.source.js</code></li>
<li><code>data/library.resolved.js</code></li>
</ul>

<p>所以即使没有本地 HTTP 服务，也能正常显示片库。</p>

<h3 id="52-本地管理员模式">5.2 本地管理员模式</h3>

<p>本地管理员模式用于：</p>

<ul>
<li>本地登录</li>
<li>控制台添加影视</li>
<li>导出片单</li>
<li>导出完整数据</li>
</ul>

<h4 id="步骤一创建本地配置文件">步骤一：创建本地配置文件</h4>

<p>复制模板：</p>

<pre><code class="language-bash">copy admin.local.example.js admin.local.js</code></pre>

<h4 id="步骤二填写本地配置">步骤二：填写本地配置</h4>

<pre><code class="language-js">window.FILM_VAULT_ADMIN = {
  apiKey: "YOUR_TMDB_API_KEY",
  password: "YOUR_LOCAL_ADMIN_PASSWORD"
};</code></pre>

<p>注意：</p>

<ul>
<li><code>admin.local.js</code> <strong>不要提交到 Git</strong></li>
<li>它已经在 <code>.gitignore</code> 中</li>
</ul>

<h4 id="步骤三本地使用流程">步骤三：本地使用流程</h4>

<ol>
<li>双击打开 <code>index.html</code></li>
<li>右上角点击 <code>登录管理</code></li>
<li>输入 <code>admin.local.js</code> 中的本地密码</li>
<li>登录成功后，出现 <code>控制台</code></li>
<li>控制台中可用：
<ul>
<li><code>添加影视</code></li>
<li><code>导出片单</code></li>
<li><code>导出数据</code></li>
</ul>
</li>
</ol>

<hr/>

<h2 id="6-源片单与完整片库">6. 源片单与完整片库</h2>

<h3 id="61-datalibraryjson">6.1 <code>data/library.json</code></h3>

<p>这是“源片单”，适合人工维护或脚本维护。</p>

<p>推荐结构：</p>

<pre><code class="language-json">{
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
}</code></pre>

<p>字段说明：</p>

<ul>
<li><code>title</code>：片名或剧名</li>
<li><code>year</code>：年份，可选但强烈建议保留</li>
<li><code>tmdbId</code>：TMDB 唯一 ID，可选但推荐保留</li>
<li><code>media_type</code>：<code>movie</code> 或 <code>tv</code></li>
</ul>

<p>建议：</p>

<ul>
<li>手工维护时，优先保留 <code>tmdbId</code></li>
<li>如果没有 <code>tmdbId</code>，脚本会搜索匹配，但重名作品有误匹配风险</li>
</ul>

<h3 id="62-datalibraryresolvedjson">6.2 <code>data/library.resolved.json</code></h3>

<p>这是前端直接使用的完整片库数据。</p>

<p>包含：</p>

<ul>
<li>海报</li>
<li>背景图</li>
<li>评分</li>
<li>上映/首播时间</li>
<li>地区</li>
<li>类型</li>
<li>制作公司</li>
<li>演员</li>
<li>简介</li>
<li><code>media_type</code></li>
</ul>

<p>这个文件不建议手工维护，推荐脚本生成。</p>

<h3 id="63-本地预览用的-js-数据文件">6.3 本地预览用的 JS 数据文件</h3>

<p>为了兼容 <code>file://</code>，项目会额外生成：</p>

<ul>
<li><code>data/library.source.js</code></li>
<li><code>data/library.resolved.js</code></li>
</ul>

<p>格式示例：</p>

<pre><code class="language-js">window.__FILM_VAULT_SOURCE__ = {
  "title": "我的影视墙",
  "subtitle": "一面为私人观影史准备的影视墙。",
  "entries": [...]
};

window.__FILM_VAULT_RESOLVED__ = {
  "title": "我的影视墙",
  "subtitle": "一面为私人观影史准备的影视墙。",
  "movies": [...]
};</code></pre>

<hr/>

<h2 id="7-命令行维护片库">7. 命令行维护片库</h2>

<h3 id="71-配置-devvars">7.1 配置 <code>.dev.vars</code></h3>

<p>在项目根目录创建：</p>

<p><code>.dev.vars</code></p>

<p>内容示例：</p>

<pre><code class="language-plaintext">TMDB_API_KEY=YOUR_TMDB_API_KEY</code></pre>

<h3 id="72-按名称搜索并添加影视">7.2 按名称搜索并添加影视</h3>

<pre><code class="language-bash">npm run add:movie -- 怪奇物语</code></pre>

<h3 id="73-根据源片单重建完整片库">7.3 根据源片单重建完整片库</h3>

<pre><code class="language-bash">npm run rebuild:library</code></pre>

<h3 id="74-packagejson-中的脚本">7.4 <code>package.json</code> 中的脚本</h3>

<pre><code class="language-json">{
  "name": "film-vault-wall",
  "private": true,
  "type": "module",
  "scripts": {
    "rebuild:library": "node ./scripts/rebuild-library.mjs",
    "add:movie": "node ./scripts/add-movie.mjs"
  }
}</code></pre>

<hr/>

<h2 id="8-tmdb-接口支持范围">8. TMDB 接口支持范围</h2>

<p>这个项目最终不是“电影墙”，而是“影视墙”。</p>

<p>所以当前搜索和详情逻辑支持：</p>

<ul>
<li>电影：<code>movie</code></li>
<li>电视剧：<code>tv</code></li>
</ul>

<h3 id="81-搜索逻辑">8.1 搜索逻辑</h3>

<p>管理员控制台中的“添加影视”搜索支持：</p>

<ul>
<li><code>movie</code></li>
<li><code>tv</code></li>
</ul>

<p>并且支持分页。</p>

<p>当前实现策略：</p>

<ul>
<li>云端 Worker：<code>/search/multi?page=...</code></li>
<li>本地浏览器：<code>/search/multi?page=...</code></li>
<li>最终只保留 <code>movie/tv</code> 类型结果</li>
</ul>

<h3 id="82-详情逻辑">8.2 详情逻辑</h3>

<p>添加时按 <code>media_type</code> 分流：</p>

<ul>
<li><code>movie -&gt; /movie/{id}</code></li>
<li><code>tv -&gt; /tv/{id}</code></li>
</ul>

<p>这是为了保证：</p>

<ul>
<li>搜电影时拿电影详情</li>
<li>搜电视剧时拿剧集详情</li>
</ul>

<hr/>

<h2 id="9-控制台中的搜索分页">9. 控制台中的搜索分页</h2>

<p>这是当前版本的重要能力。</p>

<h3 id="91-行为规则">9.1 行为规则</h3>

<ul>
<li>未搜索时：不显示分页控件</li>
<li>搜索后只有 1 页：不显示分页控件</li>
<li>搜索后有多页：显示分页控件</li>
</ul>

<p>分页控件包括：</p>

<ul>
<li><code>上一页</code></li>
<li><code>第 X / Y 页</code></li>
<li><code>下一页</code></li>
</ul>

<h3 id="92-为什么需要分页">9.2 为什么需要分页</h3>

<p>很多影视作品存在：</p>

<ul>
<li>同名电影</li>
<li>同名电视剧</li>
<li>不同年份重拍</li>
<li>不同地区翻拍</li>
</ul>

<p>如果不支持翻页，第一页找不到时就无法继续筛选。</p>

<h3 id="93-关键实现思路">9.3 关键实现思路</h3>

<pre><code class="language-js">state.searchQuery = query;
state.searchPage = 1;
state.searchPerformed = true;

const payload = state.admin.mode === "remote"
  ? await remoteSearchMovies(state.searchQuery, state.searchPage)
  : await localSearchMovies(state.searchQuery, state.searchPage);

state.searchResults = payload.results || [];
state.searchTotalPages = Math.max(1, Number(payload.total_pages || 1));
renderSearchResults();
renderSearchPagination();</code></pre>

<pre><code class="language-js">const page = Math.max(1, Number(body.page || 1));

const response = await fetch(buildTmdbUrl("/search/multi", env.TMDB_API_KEY, {
  language: "zh-CN",
  query,
  include_adult: "false",
  page: String(page),
}));

return json({
  results,
  total_pages: Number(payload.total_pages || 1),
});</code></pre>

<hr/>

<h2 id="10-cloudflare-部署">10. Cloudflare 部署</h2>

<p>推荐使用 <strong>Cloudflare Pages</strong>。</p>

<h3 id="101-为什么不是纯-workers">10.1 为什么不是纯 Workers</h3>

<p>因为这个项目是：</p>

<ul>
<li>静态站点：<code>index.html</code> / <code>styles.css</code> / <code>app.js</code></li>
<li>服务端接口：<code>_worker.js</code></li>
</ul>

<p>所以最适合：</p>

<ul>
<li>Pages 托管静态资源</li>
<li><code>_worker.js</code> 提供管理员接口</li>
</ul>

<h3 id="102-pages-构建配置">10.2 Pages 构建配置</h3>

<p>连接 GitHub 仓库后：</p>

<ul>
<li>Framework preset：<code>None</code></li>
<li>Build command：留空</li>
<li>Build output directory：<code>.</code></li>
</ul>

<h3 id="103-wranglerexampletoml">10.3 <code>wrangler.example.toml</code></h3>

<pre><code class="language-toml">name = "films"
compatibility_date = "2026-04-23"

pages_build_output_dir = "."

[[kv_namespaces]]
binding = "FILM_VAULT_KV"
id = "replace-with-your-kv-namespace-id"
preview_id = "replace-with-your-preview-kv-namespace-id"</code></pre>

<h3 id="104-必要的-kv-配置">10.4 必要的 KV 配置</h3>

<p>创建一个 KV namespace，并绑定：</p>

<p><code>FILM_VAULT_KV</code></p>

<h3 id="105-必要的-secrets">10.5 必要的 Secrets</h3>

<p>在 Cloudflare Pages 中配置：</p>

<ul>
<li><code>TMDB_API_KEY</code></li>
<li><code>ADMIN_PASSWORD</code></li>
<li><code>SESSION_SECRET</code></li>
</ul>

<p>含义：</p>

<ul>
<li><code>TMDB_API_KEY</code>：TMDB API 密钥</li>
<li><code>ADMIN_PASSWORD</code>：线上管理员登录密码</li>
<li><code>SESSION_SECRET</code>：会话签名密钥</li>
</ul>

<h3 id="106-worker-的职责">10.6 Worker 的职责</h3>

<p><code>_worker.js</code> 主要负责：</p>

<ul>
<li>公开读取片库：<code>/api/library</code></li>
<li>管理员登录：<code>/api/admin/session</code></li>
<li>管理员搜索影视：<code>/api/admin/search</code></li>
<li>管理员添加影视：<code>/api/admin/add</code></li>
<li>管理员删除影视：<code>/api/admin/remove</code></li>
</ul>

<h3 id="107-线上数据读写逻辑">10.7 线上数据读写逻辑</h3>

<p>线上优先读 Cloudflare KV。</p>

<p>但为了避免 KV 停留在旧数据，Worker 还会：</p>

<ul>
<li>读取仓库静态文件 <code>data/library.json</code></li>
<li>读取仓库静态文件 <code>data/library.resolved.json</code></li>
<li>比较 <code>generatedAt</code></li>
<li>如果仓库静态数据更“新”，就自动覆盖旧 KV</li>
</ul>

<p>这个机制很重要，因为它保证：</p>

<ul>
<li>GitHub 中的片库更新后</li>
<li>Cloudflare 重新构建</li>
<li>线上不会永远停留在旧 KV</li>
</ul>

<hr/>

<h2 id="11-管理员使用逻辑">11. 管理员使用逻辑</h2>

<h3 id="111-普通访客">11.1 普通访客</h3>

<ul>
<li>只能浏览片库</li>
<li>只能搜索已添加的影视</li>
<li>看不到管理功能</li>
</ul>

<h3 id="112-管理员">11.2 管理员</h3>

<ol>
<li>点击 <code>管理员登录</code></li>
<li>输入密码</li>
<li>登录成功后出现 <code>控制台</code></li>
<li>控制台中可执行：
<ul>
<li><code>添加影视</code></li>
<li><code>导出片单</code></li>
<li><code>导出数据</code></li>
</ul>
</li>
<li>在线上环境中，添加/删除会直接写入 Cloudflare KV</li>
</ol>

<hr/>

<h2 id="12-默认排序与前端说明">12. 默认排序与前端说明</h2>

<h3 id="121-默认排序">12.1 默认排序</h3>

<p>站点默认按：</p>

<p><code>上映时间</code></p>

<p>而不是评分优先。</p>

<h3 id="122-当前文案说明">12.2 当前文案说明</h3>

<p>当前项目已经统一到“影视”语义，而不是“电影”：</p>

<ul>
<li>我的影视墙</li>
<li>影视库搜索</li>
<li>添加影视</li>
<li>已看影视</li>
</ul>

<hr/>

<h2 id="13-git-提交流程">13. Git 提交流程</h2>

<h3 id="131-进入仓库目录">13.1 进入仓库目录</h3>

<pre><code class="language-bash">cd C:\Users\haenl\Documents\Codex\2026-04-23-d-1a-web-films-web-tmdb</code></pre>

<h3 id="132-查看状态">13.2 查看状态</h3>

<pre><code class="language-bash">git status</code></pre>

<h3 id="133-提交全部改动">13.3 提交全部改动</h3>

<pre><code class="language-bash">git add .
git commit -m "your commit message"
git push</code></pre>

<h3 id="134-只提交部分文件">13.4 只提交部分文件</h3>

<pre><code class="language-bash">git add app.js _worker.js index.html styles.css README.md
git commit -m "your commit message"
git push</code></pre>

<hr/>

<h2 id="14-隐私与敏感信息">14. 隐私与敏感信息</h2>

<h3 id="141-不应提交到-github-的文件">14.1 不应提交到 GitHub 的文件</h3>

<ul>
<li><code>admin.local.js</code></li>
<li><code>.dev.vars</code></li>
<li><code>.env</code></li>
<li><code>.env.local</code></li>
<li>任何真实 API Key、密码、会话密钥</li>
</ul>

<h3 id="142-可以提交到仓库的内容">14.2 可以提交到仓库的内容</h3>

<ul>
<li><code>admin.local.example.js</code></li>
<li><code>.dev.vars.example</code></li>
<li><code>README.md</code> 中的变量名说明</li>
<li><code>_worker.js</code> 中的环境变量读取代码</li>
</ul>

<p>注意：</p>

<ul>
<li>变量名不是敏感信息</li>
<li>真正敏感的是“实际值”</li>
</ul>

<hr/>

<h2 id="15-常见问题与排查">15. 常见问题与排查</h2>

<h3 id="151-线上为什么还是旧片库">15.1 线上为什么还是旧片库</h3>

<p>先检查：</p>

<ul>
<li>Cloudflare 当前部署对应的 commit 是否最新</li>
<li><code>FILM_VAULT_KV</code> 是否绑定正确</li>
<li><code>data/library.resolved.json</code> 是否带最新 <code>generatedAt</code></li>
</ul>

<h3 id="152-为什么搜索不到目标作品">15.2 为什么搜索不到目标作品</h3>

<p>常见原因：</p>

<ul>
<li>同名作品太多</li>
<li>目标在后面的分页中</li>
<li>中文名和原名差异较大</li>
<li>目标是剧集、番组、特别篇而不是电影</li>
</ul>

<p>解决方式：</p>

<ul>
<li>继续翻页查找</li>
<li>在源片单中明确 <code>tmdbId</code></li>
<li>明确 <code>media_type</code></li>
</ul>

<h3 id="153-为什么本地能搜线上添加失败">15.3 为什么本地能搜，线上添加失败</h3>

<p>常见原因：</p>

<ul>
<li>Cloudflare 没部署到最新 commit</li>
<li>Worker 仍在跑旧逻辑</li>
<li><code>TMDB_API_KEY</code> 未配置</li>
<li><code>ADMIN_PASSWORD</code> / <code>SESSION_SECRET</code> 未配置</li>
<li>KV 绑定不正确</li>
</ul>

<h3 id="154-为什么-data-不能删">15.4 为什么 <code>data/*</code> 不能删</h3>

<p>因为它们负责：</p>

<ul>
<li>初始种子</li>
<li>KV 纠偏</li>
<li>本地预览</li>
<li>可追踪版本基线</li>
</ul>

<hr/>

<h2 id="16-推荐维护方式">16. 推荐维护方式</h2>

<h3 id="方案-a本地页面维护">方案 A：本地页面维护</h3>

<p>适合直接在浏览器里操作：</p>

<ol>
<li>配置 <code>admin.local.js</code></li>
<li>双击打开 <code>index.html</code></li>
<li>登录管理</li>
<li>添加影视</li>
<li>导出片单 / 导出数据</li>
<li>提交到 GitHub</li>
</ol>

<h3 id="方案-b命令行批量维护">方案 B：命令行批量维护</h3>

<p>适合大规模调整：</p>

<ol>
<li>修改 <code>data/library.json</code></li>
<li>执行 <code>npm run rebuild:library</code></li>
<li>提交到 GitHub</li>
</ol>

<h3 id="方案-c线上-cloudflare-管理">方案 C：线上 Cloudflare 管理</h3>

<p>适合日常在线维护：</p>

<ol>
<li>打开线上站点</li>
<li>管理员登录</li>
<li>在控制台里添加或删除影视</li>
<li>数据直接写入 KV</li>
</ol>

<hr/>

<h2 id="17-推荐环境">17. 推荐环境</h2>

<ul>
<li>Node.js 18+</li>
<li>Cloudflare Pages</li>
<li>Chrome / Edge / Safari 最新版本</li>
<li>Windows PowerShell 或任意可用终端</li>
</ul>

<hr/>

<h2 id="18-结论">18. 结论</h2>

<p>这个项目最终是一个：</p>

<ul>
<li>本地可预览</li>
<li>线上可部署</li>
<li>管理员可登录</li>
<li>支持电影和电视剧</li>
<li>支持分页搜索</li>
<li>线上数据由 Cloudflare KV 托管</li>
<li>仓库静态数据用于基线和纠偏</li>
</ul>

<p>的个人影视墙系统。</p>

<p>只要保留好：</p>

<ul>
<li>仓库代码</li>
<li><code>data/*</code></li>
<li>Cloudflare 的 KV 和 Secrets</li>
</ul>

<p>几年后重新看到这份笔记，依然可以完整恢复。</p>
