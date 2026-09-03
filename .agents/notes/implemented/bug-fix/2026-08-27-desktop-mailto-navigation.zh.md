# Agent Note: 桌面端把 mailto: 导航转交给操作系统

Status: implemented

[English](2026-08-27-desktop-mailto-navigation.md) | 中文

## 问题

桌面端启动窗口的 `will-navigate` 处理器会拒绝一切不指向正在运行的服务器的导航，随后只把以 `http` 开头的目的地转交给 `shell.openExternal`。`MarkdownText` 的净化器允许 `mailto:` 链接目的地（文档/README 原文："the http(s) subset of the allowlist `MarkdownText` applies to untrusted links (it also permits `mailto:`...)"），而一个 `mailto:` 锚点从不携带 `target="_blank"`（只有 `http(s)` 链接会带上该属性）。因此在桌面端点击一处渲染出的 `mailto:` 链接会抵达 `will-navigate`，被 `preventDefault`，然后什么都不会发生：一次没有任何可见效果、日志里也不留痕迹的死点击。

## 决策

转发判定谓词现在同时接受以 `http` 开头与以 `mailto:` 开头的目的地。它被抽取为 `apps/desktop/src/navigation.ts` 中的纯函数 `isExternalNavigationTarget`，不 import 任何 Electron 模块——因为 `will-navigate` 事件接线本身需要一个真实的 `BrowserWindow`，无法在纯 Node 测试下运行；抽出这个谓词正是让这项决策具备可单元测试性的做法。`apps/desktop/tests/navigation.spec.ts` 固定了两个分支：`http(s)`/`mailto:` 目的地转发，`file:`/`javascript:`/`about:`/空字符串目的地不转发。

## 备选方案

**改为在 `MarkdownText` 里给 mailto 锚点加上 `target="_blank"`。** 不予采纳：带 `target="_blank"` 的 mailto 链接会为一个没有 renderer 会导航到的 scheme 打开一个新的浏览上下文窗口，而桌面应用并没有第二个窗口去接住它；在 `will-navigate` 边界转发才是本就负责"把这个交给操作系统"的那一层。

**把判定谓词放宽为转发一切被拒绝的目的地。** 不予采纳：该谓词存在的意义正是把关哪些未处理的导航能抵达用户的操作系统级默认处理器；无条件转发 `file:`/`javascript:`/其他任意 scheme，会把 `MarkdownText` 自身白名单本就不打算让其抵达那里的目的地也交给操作系统处理器。

## 后果

桌面端渲染出的 `mailto:` 链接现在会打开操作系统的默认邮件客户端，与浏览器端客户端中同一条链接已有的行为一致（浏览器里一个不带 `target="_blank"` 的普通锚点会原地导航，被操作系统的邮件客户端关联拦截）。转发判定谓词此前完全没有测试覆盖，现在有了单元测试；`will-navigate` 事件接线本身仍未测试，这与本应用中 Electron 事件接线普遍未测试的现状一致。
