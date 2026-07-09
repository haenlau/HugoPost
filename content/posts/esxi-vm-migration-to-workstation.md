+++
title = "将 ESXi 虚拟机迁移到本地 VMware Workstation"
date = "2026-06-04"
lastmod = "2026-06-04"
description = "使用 VMware vCenter Converter Standalone 将 ESXi 8.0 上的 Windows 10 虚拟机完整迁移到 Windows 11 主机的 VMware Workstation，保留所有应用和数据。"
url = "/esxi-vm-migration-to-workstation/"
aliases = ["/posts/esxi-vm-migration-to-workstation/"]
draft = false
+++
<h2 id="背景">背景</h2>

<p>ESXi 8.0 上跑着一台 Windows 10 虚拟机，装了不少应用。需要把它迁移到本地 Windows 11 主机的 VMware Workstation 里，要求应用和数据完整保留。</p>

<p>目标：在 Workstation 上能直接用，不重装系统、不丢软件。</p>

<h2 id="方案选择">方案选择</h2>

<p>几种主流方案：</p>

<ul>
<li><strong>VMware vCenter Converter Standalone</strong>：官方免费工具，自动处理驱动兼容性和虚拟硬件版本，最稳。</li>
<li><strong>OVF/OVA 导出导入</strong>：ESXi 自带功能，但导出的虚拟硬件版本可能跟 Workstation 不兼容，需要手动改 <code>.ovf</code> 文件。</li>
<li><strong>直接拷贝 VMDK</strong>：格式不完全一致，风险高，不推荐。</li>
</ul>

<p>最终选了 Converter。</p>

<h2 id="迁移步骤">迁移步骤</h2>

<h3 id="1-安装-vmware-vcenter-converter">1. 安装 VMware vCenter Converter</h3>

<p>下载安装包后运行，安装类型选 <strong>Local installation</strong>。</p>

<p>Client-Server installation 是企业级大规模迁移用的，单台虚拟机迁移不需要。</p>

<h3 id="2-配置-source">2. 配置 Source</h3>

<p>打开 Converter，点 <strong>Convert machine</strong>：</p>

<ul>
<li><strong>Source type</strong>：选 <code>VMware Infrastructure virtual machine</code></li>
<li>填入 ESXi 的 IP、用户名、密码</li>
<li>选中要迁移的虚拟机</li>
</ul>

<h3 id="3-配置-destination">3. 配置 Destination</h3>

<p><strong>Destination type 下拉菜单一定选对：</strong></p>

<ul>
<li>❌ <code>VMware Infrastructure virtual machine</code> — 这是往另一个 ESXi 迁移用的</li>
<li>✅ <code>VMware Workstation or other VMware virtual machine</code> — 生成 <code>.vmx</code> + <code>.vmdk</code>，Workstation 直接能打开</li>
</ul>

<p>选对之后不需要填服务器地址，直接指定本地保存路径，比如 <code>D:\VMs\your-vm-name</code>。</p>

<h3 id="4-内存设置">4. 内存设置</h3>

<p>进入 Options → Devices → Memory 界面。</p>

<p>默认可能是 12GB 或更高，需要根据主机实际内存调整。主机总共 16GB，已用约 37%，给虚拟机分配 8GB（8192 MB）比较合理：</p>

<ul>
<li>宿主机留约 2GB + 系统缓存，不会卡</li>
<li>Win10 + 多应用在 8GB 下够用</li>
<li>后续需要可以在 Workstation 里关机后手动调</li>
</ul>

<h3 id="5-磁盘类型">5. 磁盘类型</h3>

<p>Options → Data to copy，下拉菜单选磁盘分配类型：</p>

<ul>
<li>❌ <code>Not pre-allocated</code>（稀疏盘）：Workstation 支持较弱，可能启动慢、应用报错</li>
<li>✅ <code>Pre-allocated</code>：一次性分配全部空间，兼容性最好</li>
</ul>

<p>选 Pre-allocated 会立刻占满磁盘空间，确保本地磁盘剩余空间足够。</p>

<h3 id="6-高级选项">6. 高级选项</h3>

<p>Options → Advanced options，四个选项全部勾选：</p>

<table><thead><tr><th>选项</th><th>作用</th></tr></thead><tbody><tr><td>Install VMware Tools on the destination virtual machine</td><td>自动安装 Tools，确保显卡、网络、共享文件夹正常</td></tr><tr><td>Customize guest preferences for the virtual machine</td><td>重置 SID、适配 Workstation 硬件</td></tr><tr><td>Remove System Restore checkpoints on destination</td><td>清理还原点，节省空间</td></tr><tr><td>Reconfigure destination virtual machine</td><td>自动将 ESXi 硬件配置转换为 Workstation 兼容配置</td></tr></tbody></table>

<h3 id="7-开始转换">7. 开始转换</h3>

<p>确认 Summary 页面信息无误后点 Finish。</p>

<p>转换时间取决于磁盘大小和网络速度，300GB 磁盘在千兆网络下大约 25-40 分钟。</p>

<h2 id="首次启动">首次启动</h2>

<p>转换完成后，去保存路径找到 <code>.vmx</code> 文件，用 VMware Workstation 打开。</p>

<p><strong>首次启动时会弹出提示，选 “I moved it”</strong>，不要选 “I copied it”。选 “I moved it” 会保留原有的 UUID 和 MAC 地址，避免部分绑定硬件指纹的软件失效。</p>

<p>启动后建议检查：</p>

<ul>
<li>VMware Tools 是否正常工作（显卡、网络、共享文件夹）</li>
<li>网络是否通（ESXi 常用 vmxnet3，Workstation 也支持，但遇到问题可以改 e1000e）</li>
<li>应用是否正常运行</li>
</ul>

<h2 id="注意事项">注意事项</h2>

<p><strong>转换前删除快照</strong>：在 ESXi 上删除或合并所有快照，带快照迁移容易导致数据不一致。</p>

<p><strong>Workstation 版本</strong>：建议 17 Pro/Player 以上，与 ESXi 8.0 的虚拟硬件版本兼容性最好。旧版本（15/16）可能需要降级虚拟硬件版本才能启动。</p>

<p><strong>激活问题</strong>：迁移后硬件 ID 可能变化，Windows 或第三方软件可能要求重新激活。选 “I moved it” 可以最大程度保留原 UUID。</p>

<p><strong>VMware Tools</strong>：迁移后建议卸载 ESXi 版 Tools，重新安装 Workstation 版，否则显卡、共享文件夹等功能可能异常。</p>
