# 内置 Undici 清单 — npm override 打不到 Node/Electron 运行时

[English](2026-10-30-builtin-undici-inventory.md) | 中文

**Status:** Implemented
**Date:** 2026-10-30
**Context:** core-patches 分支的 CVE P0/P1 残留项

## 概述

npm/pnpm 的 override 覆盖的是 `undici` **npm 包**，**不替换** Node.js 与 Electron 运行时内置的那份 `undici`。本记录盘点本仓要求的 Node 版本与钉住的 Electron 版本各自内置的 undici 版本，并记录残留的 CVE 暴露面。

## 清单

### Node.js 运行时要求

**根 `engines.node`：** `>=24.9.0`

**Node 24.9.0 内置的 undici：**
Node 24.9.0（2025-08-20 发布）内置 undici **8.10.2**，该版本**受影响**于：
- [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)：异常的 Content-Encoding 响应导致进程退出
- [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm)：TLS 1.2 重协商导致未捕获异常

**修复可用性：**
修复在 undici **8.12.2**（2025-01-29）发布。Node 24.x 从 Node **24.15.0** 起包含更新后的 undici。

**当前 Node 运行时：**
本环境当前的 Node 运行时（v22.23.4）也内置 undici，但低于要求的 >=24.9.0，所以这是开发环境的偏差。生产部署必须按 `engines` 要求使用 Node >=24.9.0。

### Electron 运行时

**钉住的 Electron 版本：** `44.7.0`（见 `apps/desktop/package.json`）

**Electron 44.7.0 内置的 undici：**
Electron 44.7.0 内置 Node **22.11.0**，其中含 undici **8.10.2**，与 Node 24.9.0 同一个**受影响**版本。

**修复可用性：**
Electron **44.9.1** 及以后（内置带更新 undici 的 Node 22.x）含修复。不过 43.x 线要 >= **43.8.1** 才有。

## 残留风险

### npm override 的作用范围

`pnpm-workspace.yaml` 里针对 undici 的 override：
```yaml
'undici@6': '>=6.29.1'
'undici@7': '>=7.30.1'
'undici@8': '>=8.12.2'
```

这些**只影响 npm 包依赖**，即经 `require('undici')` 或 `import undici` 载入的那份。它们**不修补**内置的 `fetch` API，也不修补使用运行时内置 undici 的内部 HTTP 客户端。

### 暴露面

**Node.js >=24.9.0 <24.15.0：**
- 跑在这些版本上的宿主进程仍受 undici 的 DoS 向量影响
- 异常 HTTP 响应可能导致进程终止
- TLS 1.2 重协商可能触发未捕获异常

**Electron 44.7.0：**
- 用这个 Electron 版本打包的桌面应用有同样的暴露面
- GUI 进程与任何使用 `fetch` 的 renderer/worker 都受影响
- 外部 HTTP 请求（web fetch 工具、MCP 客户端、更新）走的是受影响的代码路径

### 缓解

**短期：**
- npm override 保护显式使用 `require('undici')` 的代码路径
- 应用层的错误处理与超时限制了单次请求的影响
- MCP 客户端经 npm 依赖使用被 override 的包版 undici（≥8.12.2）

**完整缓解需要：**
1. **Node 运行时：** 要求 `engines.node >= 24.15.0`，或为 24.9.0-24.14.x 的部署记录已接受的风险
2. **Electron：** 把钉住的 Electron 升到 >= **44.9.1**（43.x 线 >= 43.8.1）

### 建议

这份清单满足「如实记录内置 undici 状态」这一要求。本仓**目前没有**只靠 npm override 缓解宿主 DoS。完整修复需要：

- 把 `package.json` 的 engines.node 改成 `>=24.15.0`，或
- 为 Node 24.9.0-24.14.x 记录已接受的残留风险
- 把钉住的 Electron 版本升到 >=44.9.1（另行跟进；按任务说明不在 core-patches 范围内）

## 参考

- Node 24 发布历史：https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V24.md
- Electron 44 发布：https://github.com/electron/electron/releases
- GHSA-xjj6-f33q-929c：https://github.com/advisories/GHSA-xjj6-f33q-929c
- GHSA-qrxm-fqhp-jwvm：https://github.com/advisories/GHSA-qrxm-fqhp-jwvm
- undici 8.12.2 发布：https://github.com/nodejs/undici/releases/tag/v8.12.2
