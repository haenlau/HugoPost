+++
title = "使用 Sysmon 监控 DNS 查询定位恶意域名访问进程"
date = "2026-05-22"
lastmod = "2026-05-22"
description = "通过安装配置 Sysmon 开启 DNS 查询日志（事件 ID 22），在 Windows 事件查看器中定位频繁外联恶意域名的进程。"
url = "/sysmon-dns-query-logging/"
aliases = ["/posts/sysmon-dns-query-logging/"]
draft = false
+++
<h2 id="背景">背景</h2>

<p>有电脑频繁外联恶意域名，需要定位是哪个进程发起的 DNS 查询。Sysmon 的 DNS 查询日志（事件 ID 22）可以记录每次 DNS 查询对应的进程，是解决此类问题的标准工具。</p>

<h2 id="sysmon-安装">Sysmon 安装</h2>

<p>Sysmon 是微软 Sysinternals 套件中的系统监控工具，下载地址：</p>

<blockquote>
<p><a href="https://learn.microsoft.com/zh-cn/sysinternals/downloads/sysmon">https://learn.microsoft.com/zh-cn/sysinternals/downloads/sysmon</a></p>
</blockquote>

<p>下载后解压，以管理员身份打开 PowerShell，进入解压目录执行安装：</p>

<pre><code class="language-powershell">.\Sysmon64.exe -i -n</code></pre>

<p>参数说明：</p>

<ul>
<li><code>-i</code> — 安装服务和驱动程序，可选择配置文件</li>
<li><code>-c</code> — 更新已安装的 Sysmon 驱动程序的配置，或转储当前配置</li>
<li><code>-m</code> — 安装事件清单（服务安装时自动安装）</li>
<li><code>-s</code> — 打印配置架构定义</li>
<li><code>-u</code> — 卸载服务和驱动程序（<code>-u force</code> 强制卸载）</li>
</ul>

<p><code>-n</code> 表示不安装事件清单（已通过 <code>-i</code> 安装），可减少安装步骤。</p>

<h2 id="配置-dns-查询监控">配置 DNS 查询监控</h2>

<p>在 Sysmon 同目录下创建配置文件 <code>sysmon_dns.xml</code>：</p>

<pre><code class="language-xml">&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;Sysmon schemaversion="4.90"&gt;
  &lt;HashAlgorithms&gt;md5,sha256,IMPHASH&lt;/HashAlgorithms&gt;
  &lt;CheckRevocation/&gt;
  &lt;EventFiltering&gt;
    &lt;ProcessCreate onmatch="exclude"&gt;
      &lt;Image condition="is"&gt;C:\Windows\System32\backgroundTaskHost.exe&lt;/Image&gt;
    &lt;/ProcessCreate&gt;
    &lt;NetworkConnect onmatch="include"&gt;
      &lt;Image condition="end with"&gt;.exe&lt;/Image&gt;
    &lt;/NetworkConnect&gt;
    &lt;!-- 开启 DNS 查询日志，排除系统常见进程 --&gt;
    &lt;DnsQuery onmatch="exclude"&gt;
      &lt;Image condition="is"&gt;C:\Windows\System32\svchost.exe&lt;/Image&gt;
      &lt;Image condition="is"&gt;C:\Windows\System32\SearchProtocolHost.exe&lt;/Image&gt;
    &lt;/DnsQuery&gt;
  &lt;/EventFiltering&gt;
&lt;/Sysmon&gt;</code></pre>

<p>配置逻辑：</p>

<ul>
<li><strong>NetworkConnect</strong>：只记录 <code>.exe</code> 进程的网络连接，过滤掉非可执行文件的连接噪声</li>
<li><strong>DnsQuery</strong>：排除 <code>svchost.exe</code> 和 <code>SearchProtocolHost.exe</code> 这两个系统进程的高频 DNS 查询，减少日志量</li>
<li><strong>ProcessCreate</strong>：排除 <code>backgroundTaskHost.exe</code>，避免后台任务进程的干扰</li>
</ul>

<p>应用配置：</p>

<pre><code class="language-powershell">.\Sysmon64.exe -c sysmon_dns.xml</code></pre>

<h2 id="查看日志">查看日志</h2>

<p>打开事件查看器（<code>Win + R</code> → <code>eventvwr.msc</code>），路径：</p>

<pre><code class="language-plaintext">应用程序和服务日志 → Microsoft → Windows → Sysmon → Operational</code></pre>

<p>过滤事件 ID 22（DNS 查询），可以看到每次 DNS 查询的：</p>

<ul>
<li>查询的域名</li>
<li>发起查询的进程路径和 PID</li>
<li>查询类型（A、AAAA、CNAME 等）</li>
<li>查询结果</li>
</ul>

<h2 id="sysmon-事件-id-速查">Sysmon 事件 ID 速查</h2>

<p>以下是 Sysmon 所有事件类型的简要说明：</p>

<table><thead><tr><th>ID</th><th>事件类型</th><th>说明</th></tr></thead><tbody><tr><td>1</td><td>ProcessCreate</td><td>进程创建，含完整命令行、哈希、ProcessGUID</td></tr><tr><td>2</td><td>FileCreateTime</td><td>进程修改文件创建时间</td></tr><tr><td>3</td><td>NetworkConnect</td><td>TCP/UDP 网络连接（默认禁用）</td></tr><tr><td>4</td><td>ServiceStateChange</td><td>Sysmon 服务状态变更（启动/停止）</td></tr><tr><td>5</td><td>ProcessTerminate</td><td>进程终止</td></tr><tr><td>6</td><td>DriverLoad</td><td>驱动程序加载</td></tr><tr><td>7</td><td>ImageLoad</td><td>模块加载（默认禁用，日志量大）</td></tr><tr><td>8</td><td>CreateRemoteThread</td><td>跨进程创建线程（代码注入检测）</td></tr><tr><td>9</td><td>RawAccessRead</td><td>原始驱动器读取（绕过文件审计）</td></tr><tr><td>10</td><td>ProcessAccess</td><td>进程访问其他进程（凭据窃取检测）</td></tr><tr><td>11</td><td>FileCreate</td><td>文件创建或覆盖</td></tr><tr><td>12</td><td>RegistryEvent (Key/Value Create/Delete)</td><td>注册表键/值的创建和删除</td></tr><tr><td>13</td><td>RegistryEvent (Value Set)</td><td>注册表值修改</td></tr><tr><td>14</td><td>RegistryEvent (Key/Value Rename)</td><td>注册表键/值重命名</td></tr><tr><td>15</td><td>FileCreateStreamHash</td><td>命名文件流创建（Zone.Identifier 检测）</td></tr><tr><td>16</td><td>ServiceConfigurationChange</td><td>Sysmon 配置变更</td></tr><tr><td>17</td><td>PipeEvent (Pipe Created)</td><td>命名管道创建</td></tr><tr><td>18</td><td>PipeEvent (Pipe Connected)</td><td>命名管道连接</td></tr><tr><td>19</td><td>WmiEvent (Filter)</td><td>WMI 事件筛选器注册</td></tr><tr><td>20</td><td>WmiEvent (Consumer)</td><td>WMI 消费者注册</td></tr><tr><td>21</td><td>WmiEvent (ConsumerToFilter)</td><td>WMI 消费者绑定到筛选器</td></tr><tr><td><strong>22</strong></td><td><strong>DNSEvent</strong></td><td><strong>DNS 查询（Windows 8.1+）</strong></td></tr><tr><td>23</td><td>FileDelete (Archived)</td><td>文件删除并归档到 <code>C:\Sysmon</code></td></tr><tr><td>24</td><td>ClipboardChange</td><td>剪贴板内容变化</td></tr><tr><td>25</td><td>ProcessTampering</td><td>进程篡改检测（hollow/herpaderp）</td></tr><tr><td>26</td><td>FileDeleteDetected</td><td>文件删除检测（不保存文件）</td></tr><tr><td>27</td><td>FileBlockExecutable</td><td>阻止创建可执行文件（PE 格式）</td></tr><tr><td>28</td><td>FileBlockShredding</td><td>阻止文件粉碎操作</td></tr><tr><td>29</td><td>FileExecutableDetected</td><td>检测到新建可执行文件</td></tr><tr><td>255</td><td>Error</td><td>Sysmon 错误</td></tr></tbody></table>

<h2 id="卸载">卸载</h2>

<p>如需卸载 Sysmon：</p>

<pre><code class="language-powershell">.\Sysmon64.exe -u</code></pre>
