# Agent Note: 桌面运行时的内置 Undici 盘点

Status: implemented

[English](2026-10-30-builtin-undici-inventory.md) | 中文

## 问题

npm/pnpm overrides 覆盖的是 `undici` **npm 包**，**不会替换** Node.js 与 Electron 内建的 `undici`。此前的盘点写出的运行时版本与当前锁文件不一致，也没有任何打包检查真正执行随包二进制去读取 `process.versions`。仓库需要一份与现状一致的盘点，以及一个拒绝低于修复线的 Undici 运行时的打包门禁。

## 决定

仓库构建的载体及其内置版本如下：

| 载体 | 锁定版本 | 内置 Node | 内置 Undici | 依据 |
|---|---|---|---|---|
| npm `undici` | `pnpm-lock.yaml` 中的 8.12.2 | — | 8.12.2 | 锁文件与 `pnpm-workspace.yaml` overrides；只覆盖 npm 副本。 |
| shell Electron | 43.8.6（`apps/desktop-shell/package.json`） | 24.22.1 | 7.30.1 | Electron `DEPS` 源码；执行过 Linux x64 二进制。未在此执行目标平台二进制。 |
| desktop Electron | 44.10.0（`apps/desktop/package.json`，`^44.10.0`） | 24.22.1 | 7.30.1 | Electron `DEPS` 源码；执行过 Linux x64 二进制。未在此执行目标平台二进制。 |
| shell Windows Host | 24.22.1 | 24.22.1 | 7.30.1 | 官方 `node.exe` SHA-256 与 Node 源码；原生 Windows 探针待补。 |
| shell macOS Host | 构建机 Node，推荐 24.22.1 | 随构建机 | 以复制后探针为准 | 打包时执行复制后的二进制；其他构建机必须通过门禁。 |
| primary runtime | 24.22.1（`scripts/primary-runtime/lock.json`） | 24.22.1 | 7.30.1 | 锁文件与官方归档 hash；解压并执行过 Linux x64。其他目标执行待补。 |

npm 副本跟踪 `undici` 8.12.2；Node 与 Electron 运行时内置的是 7.x 线。包 overrides 无法改变后一个版本。

`scripts/runtime-version-gate.mjs` 以 Node 模式执行实际二进制并读取 `process.versions`，包括 `electron`、`node` 和 `undici`。接受的版本下界为：6.x 的 6.29.1、7.x 的 7.30.1、8.x 的 8.12.2。缺少 `process.versions.undici`、无法解析版本或主版本未知都会拒绝该运行时，并阻止打包。

门禁接入 shell 的 `stageRuntime` 与 `after-pack.cjs`、desktop 的 `prepare-runtime.ts` 与 `smoke-packaged-runtime.ts`，以及共享的 primary-runtime smoke。在 macOS 上交叉构建的 Windows 包无法在构建机执行其 `node.exe` 或 Electron 二进制：打包只校验官方 Node SHA-256，并记录原生探针待补。因此，本次变更的原生 Windows 与 macOS 包验收仍待补；执行 Linux x64 Electron 二进制只能证明版本，不能证明这些包。

面向用户的 `engines.node` 仍为 `>=24.9.0`。`docs/development.md` 推荐打包机使用 Node 24.22.1，并明确该推荐不提高 engines 下界，也不要求应用用户安装 Node.js。

## 权衡过的备选方案

**把面向用户的 Node engines 下界提高到 24.22.1。** 本批不采用：这会改变 CLI、Python SDK 和所有启动载体的兼容承诺，而安装包自带运行时。打包门禁把安全要求施加于本仓库产出的构建，不缩小用户安装范围。

**在启动时替换全局 `fetch`、`Request` 与 `Response`。** 不采用：这会改变无关调用点的响应、重定向、缓存、cookie 与字节语义，也无法在本次变更中作为通用传输迁移完成验证。门禁证明运行时本身，不改写每个消费者。

**全局强制 TLS 1.3。** 不采用：这会破坏仅提供 TLS 1.2 的服务器，也不能解决 Content-Encoding 公告。使用上游修复后的运行时才是受支持的补救。

**自行构建 Node 或 Electron，或修改 Electron 归档。** 不采用：仓库只消费官方发布二进制。shell 固定 Electron 43.8.6，另一个 desktop 要求 `^44.10.0`；primary-runtime 锁定 Node 24.22.1。

## 后果

- 此变更之后的新包会执行构建机可运行的随包 Node 与 Electron 二进制；Undici 低于修复线、缺少 `process.versions.undici` 或主版本未核实都会导致打包失败。
- 旧安装包、用户自备 Node 以及自带运行时的插件不在门禁范围内。`engines.node >=24.9.0` 仍允许内建 Undici 低于修复线的运行时。
- shell 的 `updater.ts`、`resumable-download.ts`、`notifications.ts`，Host 的 plugin-market、账户、LLM 与搜索 provider，以及 `apps/desktop/src/web-document.ts` 仍使用运行时的全局 `fetch`。门禁证明执行它们的运行时，不迁移这些调用。
- Content-Encoding 公告（[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)）由隔离子进程回归覆盖：六层 Content-Encoding 的响应以 `too many content-encodings in response: 6, maximum allowed is 5` 失败，声明长度大于实际发送字节并提前断开的响应失败，同一子进程随后的健康请求仍返回 200。TLS 1.2 重协商公告（[GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm)）仍推迟：本批不做动态换证书复现，依靠上游修复版本。
- 交叉构建的 Windows 包校验官方 `node.exe` 摘要并推迟两项原生探针；在别处交叉构建的 macOS 包没有原生构建与 smoke 就不能验收。

## 测试

- `vitest run scripts/runtime-version-gate.spec.ts scripts/primary-runtime/prepare.spec.ts` 覆盖修复线下界、缺失与未知版本、真实二进制探测与 hash 校验。
- 真实入口拒绝测试会在后续步骤之前停下：`apps/desktop/tests/runtime-preparation.spec.ts` 在 primary 准备、CLI 资源与 `versions.json` 之前拒绝低于修复线或缺少 Undici 字段、未核实 Electron 主版本，以及只打印裸版本而非 JSON 探针的二进制；`apps/desktop-shell/tests/stage-runtime.spec.ts` 丢弃官方摘要不匹配的 Windows `node.exe` 缓存且不暂存运行时；`apps/desktop-shell/tests/after-pack.spec.ts` 在 macOS 签名前拒绝低于修复线或缺少 Undici 的字段，并在第三方归档之前因错误的 Node 摘要中止 Windows 打包。
- 隔离的 `scripts/undici-content-encoding.spec.ts` 子进程在 Linux x64、Node 24.22.1、Undici 7.30.1 上报告：六层 Content-Encoding 以 `too many content-encodings in response: 6, maximum allowed is 5` 失败，长度不匹配且提前断开的请求失败，同一子进程随后的健康请求仍返回 200。运行时内置的 Undici 低于修复线时（如 24.9 的 CI 任务），该测试跳过，未打补丁的运行时不会让该任务变红。
- 续传、缓存与更新套件通过：`apps/desktop-shell/tests/resumable-download.spec.ts`、`electron-updater-multipart.spec.ts`、`download-retry.spec.ts`、`update-service.spec.ts`、`apps/desktop/tests/update-http-executor.spec.ts`、`update-coordinator.spec.ts` 与 `installed-update-network.spec.ts`。`pending-cache.spec.ts` 有一条继承自基线的过期断言，期望 hash 之前的 part 文件名；其余 17 条缓存测试通过，本变更未触及该命名。
- Linux x64 的 Electron 43.8.6 与 44.10.0 二进制报告 Node 24.22.1、Undici 7.30.1；解压后的 Node 24.22.1 primary-runtime 二进制报告相同的 Undici 版本。
- 原生 Windows 与 macOS 包 smoke 及其目标二进制执行仍待补。

## 参考

- 运行时门禁：[`scripts/runtime-version-gate.mjs`](../../../../scripts/runtime-version-gate.mjs)
- Node 24.22.1 的 Undici 包：https://raw.githubusercontent.com/nodejs/node/v24.22.1/deps/undici/src/package.json
- Electron 43.8.6 DEPS：https://raw.githubusercontent.com/electron/electron/v43.8.6/DEPS
- Electron 44.10.0 DEPS：https://raw.githubusercontent.com/electron/electron/v44.10.0/DEPS
- GHSA-xjj6-f33q-929c：https://github.com/advisories/GHSA-xjj6-f33q-929c
- GHSA-qrxm-fqhp-jwvm：https://github.com/advisories/GHSA-qrxm-fqhp-jwvm
