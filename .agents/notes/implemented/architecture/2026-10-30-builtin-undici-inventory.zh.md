# Agent Note：内置 Undici 清单 — npm override 打不到 Node 与 Electron 运行时

Status: implemented

[English](2026-10-30-builtin-undici-inventory.md) | 中文

## 问题

pnpm override 替换的是 `undici` npm 依赖，但 Node.js 与 Electron 各自内置一份 undici。因此即使所有工作区清单都解析到修复后的 npm 包，运行时内置的那份仍可能暴露同一个 CVE。

## 决定

生产运行时必须内置修复后的 undici：仓库要求 Node.js `>=24.9.0`，使用 Node 24.15.0 或更高版本以获得内置修复，Desktop 应用要求 Electron `^44.9.1`。npm override 对每个受支持主版本把包副本保持在 `undici >=8.12.2`。

## 验证

检查 `pnpm-workspace.yaml` 的 override 范围与 `apps/desktop/package.json` 的 Electron 要求。内置运行时版本是环境事实，不是锁文件事实：应读取 `process.versions` 与运行时发布说明，而不要假设内置副本与 npm 解析结果一致。相关公告为 [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) 与 [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm)）。

## 影响

npm override 与运行时要求必须一起推进：override 修复包副本，Node/Electron 要求决定内置副本。内置的确切版本仍属于各个运行时构建的属性，因此验证从运行时读取，而不是从锁文件推断。低于所述最低版本的运行时无论 npm 解析结果如何都会重新暴露公告中的问题。

## 考虑过的替代方案

只钉住 npm 的 `undici` 依赖不会触及 Node 与 Electron 的副本，因此关不上运行时路径。替换运行时内置副本或给运行时二进制打补丁，都不是这两种运行时受支持的部署方式。
