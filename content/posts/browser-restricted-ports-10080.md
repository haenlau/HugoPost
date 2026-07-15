+++
author = "haenlau"
title = "浏览器有限制端口这件事"
url = "/browser-restricted-ports-10080/"
date = "2026-07-15T05:58:45+00:00"
description = "随手用了 10080 端口测试 Web 服务，死活打不开，排查了半天发现是浏览器内置的黑名单。"
tags = [
  "技术",
  "踩坑",
]
+++

+++
author = "haenlau"
title = "浏览器有限制端口这件事"
url = "/browser-restricted-ports-10080/"
date = "2026-07-15T05:50:01+00:00"
description = "随手用了 10080 端口测试 Web 服务，死活打不开，排查了半天发现是浏览器内置的黑名单。"
tags = [
  "技术",
  "踩坑",
]
+++

前几天在测试一个 Web 服务时，随手把端口指到了 10080，然后死活打不开。

当时第一反应是服务本身挂了对 AI 说，AI 说一切正常；用 curl 测试也正常。只有浏览器打不开。

![wechat_01.png](/posts/browser-restricted-ports-10080/wechat_01.png)

换机器、换浏览器，Chrome 下提示：

![wechat_05.png](/posts/browser-restricted-ports-10080/wechat_05.png)

Firefox 下也提示：

![wechat_04.png](/posts/browser-restricted-ports-10080/wechat_04.png)

把 Firefox 的提示信息发给 AI，AI 才恍然大悟：Chrome 和 Firefox 内置了一份受限端口黑名单，10080 刚好在里面。

![wechat_06.png](/posts/browser-restricted-ports-10080/wechat_06.png)

把端口改成 18080 后，网页立刻恢复正常。

---

## 浏览器有限制端口这件事

浏览器为了安全，在代码里硬编码了一个端口黑名单，写进了规范里。遇到这些端口时，浏览器会直接拒绝建立连接，而不是把请求发出去。所以服务端怎么看都是正常的，问题出在中间那层。

![wechat_02.png](/posts/browser-restricted-ports-10080/wechat_02.png)

![wechat_03.png](/posts/browser-restricted-ports-10080/wechat_03.png)

这个黑名单里大部分是 2000 以下的系统端口（echo、ssh、smtp 这些），但也有例外，**10080 是唯一一个高地址段的禁用端口**。很多人会把它当作 80 的"升级版"来用，结果就踩坑了。

![wechat_06.png](/posts/browser-restricted-ports-10080/wechat_06.png)

完整的受限端口列表在 Fetch 规范里可以查到，Chrome 的实现对应 `net/base/port_util.cc`，Firefox 对应 `nsIOService.cpp`，都是公开源码，不是隐藏行为。

飞牛的默认端口是 5666 和 5667，与 6666 和 6667 有点像但没有冲突。

---

## 实际操作建议

在搭建 Web 服务时，**避开这些端口**。如果已经在用，遇到"服务正常但浏览器打不开"的情况，优先考虑是不是命中了黑名单。改端口是最快的修复方式。

另外，这些被禁用的端口说明一件事：**不要用 2000 以下的端口做自建服务**，大部分是系统预留，容易冲突。高地址段里也要注意查一下黑名单再定。
