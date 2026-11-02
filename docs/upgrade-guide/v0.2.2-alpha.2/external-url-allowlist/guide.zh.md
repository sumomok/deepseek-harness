---
kind: upgrade-guide
description: "Desktop 与 Desktop Shell 拒绝不在 allowlist 内或带凭证的外部 URL，取消离开所服务来源的顶层重定向，并仅用 HTTPS 下载目的地。"
---

# 外部 URL 交接收紧

[English](guide.md) | 中文

## 变更

Desktop 与 Desktop Shell 在调用操作系统之前，会用一份明确的协议 allowlist 解析每一次外部交接。主窗口接受 `http:` 与 `https:` Web 链接；Desktop Shell 的弹窗与顶层导航还接受 `mailto:`。Platform 弹窗以及更新、发布下载目的地只接受 `https:`。每一种被接受的协议都要求目标不带 URL 凭证，因此 `https://user:pass@example.com/`、`https://user@example.com/` 与 `mailto://user:pass@example.com/` 不再到达 OS。

离开所服务应用来源的顶层导航仍会被取消，并在 allowlist 接受时于解析后交给 OS。Desktop Shell 中，离开所服务来源的顶层重定向现在会被取消且不打开浏览器，子框架重定向仍交给 Chromium 处理，包括跨站 HTTP(S) 重定向。被阻止的目标和 OS 拒绝各写一行日志，只点名稳定原因或协议。

这些检查覆盖页面请求在新窗口打开的链接、主框架导航、Platform 支付与文档链接，以及更新和发布下载页。没有设置可以关闭它们。

## 迁移

1. 依赖 OS 处理程序的自定义协议链接（`ftp:`、`file:`、`tel:`、`ms-settings:` 或应用深度链接）改用 `https:` 页面，或在应用之外打开该目标。
2. 从链接和已配置目的地中删除 URL 凭证。通过目的地自己的登录页登录，不要在 URL 中嵌入 `user:password@` 或单独的 `user@`。
3. 若内嵌页面依赖顶层跨来源重定向打开系统浏览器，改为从该页面链接到外部 HTTP(S) 目的地；重定向会被取消且不打开任何东西。
4. 用 `https:` 提供更新与发布下载目的地。`http:` 目的地会在调用 OS 之前被拒绝。
5. 打开一个受影响的链接确认迁移完成：被拒绝的目标不会打开 OS 处理程序，桌面日志中会出现一行 `[external] blocked target: protocol-not-allowed`（或 `credentials`）。
