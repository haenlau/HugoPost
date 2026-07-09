+++
title = "Air1 TempFile 改造笔记"
date = "2026-07-06"
lastmod = "2026-07-06"
description = "记录 Air1 TempFile 从手动粘贴 Worker JS 部署，改造成 GitHub 推送 + Cloudflare Pages 自动构建的全过程，以及 WebDAV 分片上传的尝试、踩坑和回退。"
url = "/air1-tempfile-rewrite-notes/"
aliases = ["/posts/air1-tempfile-rewrite-notes/"]
draft = false
+++
<blockquote>
<p><strong>仓库</strong>: <a href="https://github.com/haenlau/TempFile">https://github.com/haenlau/TempFile</a>
<strong>线上地址</strong>: <a href="https://tmp.air1.cn/">https://tmp.air1.cn/</a>
<strong>当前部署</strong>: Cloudflare Pages + Pages Functions / Advanced Worker，GitHub 自动构建
<strong>最新状态</strong>: 已回退到最大上传 99 MiB 的稳定版本</p>
</blockquote>

<p>记录 Air1 TempFile 从”手动粘贴 Worker JS 部署”改造成”GitHub 推送 + Cloudflare Pages 自动构建”的过程，也记录了后来尝试 WebDAV 分片大文件上传、发现问题、最终回退到 99 MiB 稳定版本的完整经过。</p>

<hr/>

<h2 id="1-项目背景">1. 项目背景</h2>

<p>Air1 TempFile 是一个部署在 Cloudflare 上的临时文件上传工具，用于快速分享文件，7 天自动销毁。</p>

<p>当前版本核心策略：</p>

<ul>
<li><strong>最大上传限制</strong>：99 MiB</li>
<li><strong>小文件存储</strong>：Cloudflare KV（≤24 MiB）</li>
<li><strong>可选大文件后端</strong>：R2、S3、WebDAV（24 MiB - 99 MiB）</li>
<li><strong>超过 99 MiB</strong>：直接拒绝，不分片，不妥协</li>
<li><strong>上传接口</strong>：公开，无需口令</li>
<li><strong>部署方式</strong>：GitHub 推送 → Cloudflare 自动构建</li>
</ul>

<p>一句话：<strong>当前目标不是做超大文件传输工具，而是做一个稳定、轻量、适合临时分享的文件中转站。</strong></p>

<hr/>

<h2 id="2-改造前状态">2. 改造前状态</h2>

<p>最初项目是一个直接部署在 Cloudflare Workers 上的单文件 JS，使用方式是：</p>

<ol>
<li>代码由千问网页生成</li>
<li>手动粘贴到 Cloudflare Worker 编辑器</li>
<li>在 Dashboard 绑定 KV 空间和变量</li>
<li>绑定自定义域名</li>
</ol>

<p>当时用到的变量：</p>

<table><thead><tr><th>变量名</th><th>说明</th></tr></thead><tbody><tr><td><code>UPLOAD_TOKEN</code></td><td>上传令牌（实际并未被前端使用）</td></tr><tr><td><code>WEBDAV_ACCOUNT</code></td><td>WebDAV 账号</td></tr><tr><td><code>WEBDAV_PASSWORD</code></td><td>WebDAV 密码</td></tr><tr><td><code>WECOM_WEBHOOK_URL</code></td><td>企业微信 Webhook</td></tr><tr><td><code>TEMP_STORE</code></td><td>KV 空间绑定</td></tr></tbody></table>

<h3 id="改造动机">改造动机</h3>

<ul>
<li>每次改代码都要手动粘贴，繁琐且容易出错</li>
<li>没有版本管理，改坏了无法回退</li>
<li>无法多人协作</li>
<li>无法自动构建和部署</li>
</ul>

<hr/>

<h2 id="3-改造目标">3. 改造目标</h2>

<ul>
<li>✅ GitHub 仓库化管理</li>
<li>✅ Cloudflare Pages 自动构建（GitHub 推送即部署）</li>
<li>✅ 保持旧版 Air1 TempFile 前端样式不变</li>
<li>✅ 去掉上传口令逻辑，保持公开上传</li>
<li>✅ 不提交 <code>wrangler.toml</code>，绑定通过 Dashboard 管理</li>
<li>✅ 保留 KV、R2、S3、WebDAV 多种后端支持</li>
<li>✅ 支持企业微信 / Telegram 通知</li>
</ul>

<h3 id="为什么不提交-wranglertoml">为什么不提交 wrangler.toml</h3>

<p>这是本项目的一个重要约定：</p>

<ul>
<li>维护者习惯通过 Cloudflare Dashboard 管理 KV、R2、环境变量和 Secrets</li>
<li>如果绑定由 <code>wrangler.toml</code> 管理，Dashboard 会提示”由配置文件管理”，不便 Web UI 修改</li>
<li>当前项目的维护方式以 Dashboard 为主</li>
</ul>

<hr/>

<h2 id="4-cloudflare-pages-构建配置">4. Cloudflare Pages 构建配置</h2>

<p>在 Cloudflare Dashboard 新建 Pages 项目并连接 GitHub 仓库 <code>haenlau/TempFile</code>：</p>

<table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody><tr><td>Framework preset</td><td>None</td></tr><tr><td>Install command</td><td><code>npm ci</code></td></tr><tr><td>Build command</td><td><code>npm run build</code></td></tr><tr><td>Build output directory</td><td><code>dist</code></td></tr><tr><td>Node.js version</td><td>20 或 22</td></tr></tbody></table>

<p>进入 <strong>Settings → Functions</strong> 设置：</p>

<ul>
<li><strong>Compatibility date</strong>：<code>2026-07-06</code> 或更新日期</li>
<li>KV、R2、环境变量、Secrets 通过 Dashboard 添加</li>
</ul>

<h3 id="域名绑定">域名绑定</h3>

<p>绑定 <code>tmp.air1.cn</code> 到 Pages 项目。</p>

<blockquote>
<p>⚠️ 如果旧 Worker route 仍然绑定这个域名，需要先移除旧 route，否则路由冲突。</p>
</blockquote>

<h3 id="github-仓库">GitHub 仓库</h3>

<pre><code class="language-text">haenlau/TempFile</code></pre>

<p>本地开发路径：<code>本地项目路径/TempFile</code></p>

<hr/>

<h2 id="5-当前项目结构">5. 当前项目结构</h2>

<pre><code class="language-plaintext">src/
├── index.ts          # Worker 入口、路由和上传流程
├── html.ts           # 旧版上传页面
├── config.ts         # 运行时固定配置和环境变量解析
├── storage.ts        # KV / R2 / S3 / WebDAV 存储与下载逻辑
├── r2.ts             # Cloudflare R2 后端
├── s3.ts             # S3 / S3-compatible 后端
├── webdav.ts         # WebDAV 后端
├── notify.ts         # 企业微信 / Telegram 通知
├── download-page.ts  # 下载链接不存在或过期提示页
└── utils.ts          # 通用工具函数</code></pre>

<p>没有分片上传接口相关代码。</p>

<hr/>

<h2 id="6-存储策略">6. 存储策略</h2>

<h3 id="61-小文件24-mib">6.1 小文件（≤24 MiB）</h3>

<ul>
<li>直接写入 <code>TEMP_STORE</code> KV</li>
<li>文件内容和 metadata 都在 KV 中</li>
<li>下载时直接从 KV 返回</li>
</ul>

<h3 id="62-中等文件24-mib--大小--99-mib">6.2 中等文件（24 MiB &lt; 大小 ≤ 99 MiB）</h3>

<ul>
<li>必须配置 <code>LARGE_STORAGE_BACKEND</code></li>
<li>可选后端：<code>r2</code>、<code>s3</code>、<code>webdav</code></li>
<li>文件本体写入后端，KV 只保存短链索引和 metadata</li>
</ul>

<h3 id="63-超过-99-mib">6.3 超过 99 MiB</h3>

<ul>
<li>前端直接提示不能超过 99MB</li>
<li>后端也会拒绝</li>
<li>不会尝试分片上传</li>
</ul>

<hr/>

<h2 id="7-上传接口">7. 上传接口</h2>

<h3 id="71-普通上传">7.1 普通上传</h3>

<pre><code class="language-http">POST /api/upload-public</code></pre>

<p>兼容旧路径：</p>

<pre><code class="language-http">POST /api/upload</code></pre>

<p><strong>要求</strong>：</p>

<ul>
<li><code>multipart/form-data</code></li>
<li>文件字段名：<code>file</code></li>
<li>支持多文件</li>
</ul>

<p><strong>限制</strong>：</p>

<ul>
<li>单文件 ≤ 99 MiB</li>
<li>单次上传总大小 ≤ 99 MiB</li>
<li>多文件 ZIP 后也不能超过 99 MiB</li>
</ul>

<p><strong>成功返回示例</strong>：</p>

<pre><code class="language-json">{
  "downloadUrl": "https://tmp.air1.cn/abc123",
  "fileId": "abc123",
  "filename": "example.zip",
  "size": 123456,
  "storage": "kv",
  "expiresAt": "2026-07-13T06:39:58.220Z"
}</code></pre>

<h3 id="72-当前不存在的接口">7.2 当前不存在的接口</h3>

<p>以下分片接口已经回退，不再存在：</p>

<pre><code class="language-http">POST /api/upload/chunk/init
PUT /api/upload/chunk/{uploadId}/{index}
POST /api/upload/chunk/complete</code></pre>

<hr/>

<h2 id="8-下载接口">8. 下载接口</h2>

<pre><code class="language-http">GET /{id}</code></pre>

<p><strong>短链规则</strong>：</p>

<ul>
<li>6 位，数字 + 小写字母</li>
<li>字符集：<code>0123456789abcdefghijklmnopqrstuvwxyz</code></li>
<li>示例：<code>psf5i7</code>、<code>2nofgm</code></li>
<li>兼容旧链接（旧的 10-32 位字母数字 ID 仍然可访问）</li>
</ul>

<p><strong>下载响应设置</strong>：</p>

<ul>
<li><code>Content-Type</code></li>
<li><code>Content-Disposition</code></li>
<li><code>Cache-Control: no-store</code></li>
<li><code>X-Content-Type-Options: nosniff</code></li>
</ul>

<p><strong>过期提示</strong>：链接不存在或过期时返回中文提示页（<code>src/download-page.ts</code>）</p>

<hr/>

<h2 id="9-通知系统">9. 通知系统</h2>

<p>支持两种通知渠道，可单独启用或同时启用。</p>

<h3 id="企业微信">企业微信</h3>

<table><thead><tr><th>变量</th><th>说明</th></tr></thead><tbody><tr><td><code>WECOM_WEBHOOK_URL</code></td><td>企业微信机器人 Webhook 地址</td></tr></tbody></table>

<h3 id="telegram">Telegram</h3>

<table><thead><tr><th>变量</th><th>说明</th></tr></thead><tbody><tr><td><code>TELEGRAM_BOT_TOKEN</code></td><td>Bot Token</td></tr><tr><td><code>TELEGRAM_CHAT_ID</code></td><td>接收通知的 Chat ID</td></tr></tbody></table>

<blockquote>
<p>⚠️ 两个变量必须成对配置，只填一个会导致通知失败。通知失败不会影响上传结果。</p>
</blockquote>

<h3 id="通知模板">通知模板</h3>

<pre><code class="language-text">Air1 TempFile：新文件上传
文件名：upload.zip
大小：1.20 MB
存储：KV
上传 IP：203.0.113.10
时间：2026/7/6 14:02:45
过期：2026/7/13 14:02:44
下载地址：https://tmp.air1.cn/abc123</code></pre>

<p>通知通过 <code>ctx.waitUntil(...)</code> 在后台发送，<strong>成功或失败都不在前端提示</strong>，只在运行日志中记录。</p>

<hr/>

<h2 id="10-webdav-分片上传--一次不成功的尝试">10. WebDAV 分片上传 — 一次不成功的尝试</h2>

<blockquote>
<p>这一段是历史记录，不是当前功能。</p>
</blockquote>

<h3 id="想法">想法</h3>

<ul>
<li>上传上限改为 2 GiB</li>
<li>单文件超过 99MB 走 WebDAV 分片</li>
<li>分片大小 48 MiB</li>
<li>KV 保存分片上传会话</li>
<li>每片上传成功后写 KV 收据</li>
<li>完成后生成短链</li>
</ul>

<h3 id="第一次方案下载时流式拼接">第一次方案：下载时流式拼接</h3>

<p>下载时 Worker 按顺序读取 WebDAV 分片，用响应流拼接给浏览器。</p>

<p><strong>问题</strong>：真实环境里下载时只拿到一个分片。同一个链接反复下载会得到不同分片，浏览器本地得到多个残缺文件。</p>

<h3 id="第二次方案transformstream">第二次方案：TransformStream</h3>

<p>改成 <code>TransformStream + writer.write()</code>，希望通过背压顺序写出所有分片。</p>

<p><strong>问题</strong>：本地测试通过，真实 Cloudflare 环境仍然不可靠。</p>

<h3 id="第三次方案上传完成时合并">第三次方案：上传完成时合并</h3>

<p>上传完成时把 WebDAV 分片合并成完整文件，下载只下载完整文件。</p>

<p><strong>问题</strong>：合并过程发生在 <code>complete</code> 请求里，WebDAV 较慢时容易导致前端 <code>Network connection lost</code>，用户体验变差。</p>

<h3 id="教训">教训</h3>

<ul>
<li><strong>WebDAV 不是为浏览器大文件分片上传设计的协议</strong></li>
<li>Worker 中转分片并在边缘环境里合并大文件，容易遇到平台和网络边界</li>
<li>为了一个临时文件工具把系统复杂度推到这个程度不值得</li>
</ul>

<h3 id="回退">回退</h3>

<p>最终回退到 99 MiB 稳定版本，三个回退提交：</p>

<pre><code class="language-text">3548f26 Revert "Merge WebDAV chunks before download"
f988268 Revert "Fix chunked WebDAV downloads"
5b414ce Revert "Add WebDAV chunked uploads"</code></pre>

<hr/>

<h2 id="11-当前推荐配置">11. 当前推荐配置</h2>

<h3 id="111-最稳配置--仅-kv24-mib">11.1 最稳配置 — 仅 KV（≤24 MiB）</h3>

<pre><code class="language-plaintext">KV namespace binding: TEMP_STORE</code></pre>

<h3 id="112-推荐中等文件配置--kv--r299-mib">11.2 推荐中等文件配置 — KV + R2（≤99 MiB）</h3>

<pre><code class="language-plaintext">KV namespace binding:   TEMP_STORE
R2 bucket binding:      R2_BUCKET
Environment variable:   LARGE_STORAGE_BACKEND=r2</code></pre>

<p>可选：</p>

<pre><code class="language-plaintext">PUBLIC_BASE_URL=https://tmp.air1.cn/</code></pre>

<h3 id="113-webdav-配置24-mib---99-mib">11.3 WebDAV 配置（24 MiB - 99 MiB）</h3>

<pre><code class="language-plaintext">KV namespace binding:   TEMP_STORE
Environment variable:   LARGE_STORAGE_BACKEND=webdav
Environment variable:   WEBDAV_URL=https://your-webdav-host/path/
Secret:                 WEBDAV_ACCOUNT=...
Secret:                 WEBDAV_PASSWORD=***</code></pre>

<blockquote>
<p>注意：当前 WebDAV 不是分片模式，超过 99 MiB 仍然会拒绝。</p>
</blockquote>

<hr/>

<h2 id="12-上传-ip-获取">12. 上传 IP 获取</h2>

<p>后端按以下顺序获取上传 IP：</p>

<ol>
<li><code>CF-Connecting-IP</code></li>
<li><code>True-Client-IP</code></li>
<li><code>X-Forwarded-For</code> 第一个 IP</li>
<li><code>unknown</code></li>
</ol>

<hr/>

<h2 id="13-本地开发">13. 本地开发</h2>

<pre><code class="language-bash">npm install        # 安装依赖
npm run typecheck  # TypeScript 类型检查
npm run build      # esbuild 打包生成 dist/_worker.js
npm run dev        # 本地启动 Cloudflare Pages runtime
npm run deploy     # 手动部署到 Cloudflare Pages</code></pre>

<h3 id="本地-devvars-示例">本地 .dev.vars 示例</h3>

<pre><code class="language-ini">LARGE_STORAGE_BACKEND=webdav
WEBDAV_URL=https://example.com/dav/tempfile/
WEBDAV_ACCOUNT=your-webdav-account
WEBDAV_PASSWORD=your-webdav-password
PUBLIC_BASE_URL=http://localhost:8788/</code></pre>

<hr/>

<h2 id="14-排障指南">14. 排障指南</h2>

<h3 id="超过-24mib-上传失败">超过 24MiB 上传失败</h3>

<p>检查 <code>LARGE_STORAGE_BACKEND</code> 是否配置。未配置时超过 KV 阈值会失败。</p>

<h3 id="超过-99mib-上传失败">超过 99MiB 上传失败</h3>

<p>当前预期行为。当前版本最大只支持 99 MiB，不是 bug。</p>

<h3 id="上传成功但通知没收到">上传成功但通知没收到</h3>

<p>检查 <code>WECOM_WEBHOOK_URL</code>、<code>TELEGRAM_BOT_TOKEN</code>、<code>TELEGRAM_CHAT_ID</code>。通知失败不会影响上传，看 Cloudflare Functions 日志排查。</p>

<h3 id="下载链接显示过期页">下载链接显示过期页</h3>

<p>可能原因：</p>

<ul>
<li>KV 记录过期</li>
<li>KV namespace 绑定错误</li>
<li>生产环境和预览环境绑定了不同 KV</li>
<li>后端对象被清理</li>
<li>短链 ID 不存在</li>
</ul>

<h3 id="返回链接域名不是-tmpair1cn">返回链接域名不是 tmp.air1.cn</h3>

<p>检查 <code>PUBLIC_BASE_URL</code>。如果需要强制返回正式域名：</p>

<pre><code class="language-ini">PUBLIC_BASE_URL=https://tmp.air1.cn/</code></pre>

<hr/>

<h2 id="15-如果未来要支持大文件">15. 如果未来要支持大文件</h2>

<p>不要再优先走 WebDAV 分片，更合理的方向是 <strong>R2 Multipart Upload</strong>：</p>

<ul>
<li>R2 是 Cloudflare 原生对象存储，支持 multipart upload</li>
<li>浏览器分片上传到 Worker，Worker 调用 R2 multipart API 上传 part</li>
<li>R2 服务端完成合并，下载时是单个完整对象</li>
<li>不需要 WebDAV 分片拼接，不需要 Worker 自己下载分片再合并</li>
</ul>

<p>但注意：这应该作为独立大版本设计，不能在当前稳定分支里仓促加入。</p>

<hr/>

<h2 id="16-重要提交记录">16. 重要提交记录</h2>

<table><thead><tr><th>提交</th><th>说明</th></tr></thead><tbody><tr><td><code>5b414ce</code></td><td><strong>当前最新</strong> — Revert “Add WebDAV chunked uploads”</td></tr><tr><td><code>c80d1ac</code></td><td>Shorten download ids</td></tr><tr><td><code>bc446ce</code></td><td>Add expired download page</td></tr><tr><td><code>d2d6473</code></td><td>Localize upload notifications</td></tr><tr><td><del><code>c5fec03</code></del></td><td><del>已回退 — Add WebDAV chunked uploads</del></td></tr><tr><td><del><code>c90a8a7</code></del></td><td><del>已回退 — Fix chunked WebDAV downloads</del></td></tr><tr><td><del><code>b5d1cba</code></del></td><td><del>已回退 — Merge WebDAV chunks before download</del></td></tr></tbody></table>

<hr/>

<h2 id="17-总结">17. 总结</h2>

<p>截至本文，Air1 TempFile 项目的关键状态：</p>

<table><thead><tr><th>项目</th><th align="center">状态</th></tr></thead><tbody><tr><td>GitHub 仓库化</td><td align="center">✅ 已完成</td></tr><tr><td>Cloudflare Pages 自动构建</td><td align="center">✅ 已完成</td></tr><tr><td>不使用 wrangler.toml</td><td align="center">✅ Dashboard 管理</td></tr><tr><td>前端保持旧版样式</td><td align="center">✅ 已保留</td></tr><tr><td>上传接口公开</td><td align="center">✅ 无口令</td></tr><tr><td>KV 小文件存储</td><td align="center">✅ 正常</td></tr><tr><td>R2/S3/WebDAV 中文件后端</td><td align="center">✅ 可用</td></tr><tr><td>通知（企业微信/Telegram）</td><td align="center">✅ 已支持</td></tr><tr><td>下载短链（6 位字母数字）</td><td align="center">✅ 已启用</td></tr><tr><td>最大上传 99 MiB</td><td align="center">✅ 已稳定</td></tr><tr><td>WebDAV 分片上传</td><td align="center">❌ 已回退</td></tr><tr><td>2GB 大文件上传</td><td align="center">❌ 不属于当前版本能力</td></tr></tbody></table>

<p>核心维护原则：<strong>稳定优先，最大上传 99 MiB，不再用 WebDAV 硬撑超大文件。</strong></p>
