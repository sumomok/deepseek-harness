# Agent Note: 把文件附件/spill 补丁系列重落到 session-controller 架构上

Status: implemented

[English](2026-08-31-rc26-file-attachment-and-spill-family-a-port.md) | 中文

## Problem

rc.26 同步第一轮把六条 `core-patches` 登记项标记为 SKIPPED（`d56a5f7348`、等价于 `a5c4d3a29d` 的 `bb369aa8b0`、等价于读回系列的 `c82af756b1`、等价于 `88129b7b44`+`ac91819ac4`+`a285c53cf3` 的 `35ca000207`，以及 spill 系列 `5cd83e5a14`/`12bc2c55da`）：上游基座已把 `packages/host/apiproxy` 的扁平 `RpcErrorDetailsMap`/`rpcErrorSchema` 与共用的 `openTarget` 替换成 `packages/api/session-controller` 按域命名空间分类的 `RemoteError<'domain/code'>` 惯例，以及拆分到各调用方自己实现的 `openWorkspacePath`。把文件分片准入、读回、ENOENT 预检、`probeTargets`、以及带 spill 的文件降级重新落到新架构上，需要重新决定落点与错误命名空间——这些是原始补丁从未面对过的问题；另外依赖图里的一个包（`dsh-attachment-spill`）在本仓库里此前完全不存在。

## Decision

**只做搬迁与适配，不做重新设计——原始补丁的每一条实质性决定都原样保留。** `attachment/materialized` 幂等缓存、其由 `ctx.agents.currentInitiator()` 派生的归属方式、按适配器逐个做文件降级的落点（从不集中放进 `agent-loop`，理由与 `d56a5f7348`、`5cd83e5a14` 各自的原始笔记已经论证过的请求重建不变量完全一致），以及 `AttachmentSpill.Config` 的两个字段，都与原始 `5cd83e5a14` 逐字节一致；以下才是本次移植真正需要重新判断的地方。

**错误采用落点包自身的命名惯例，而不是来源包的。** 每条 SKIPPED 登记项里扁平的 `RpcErrorCode` 成员，在消费方包里都变成一条按域命名空间分类的 `RemoteErrorDetailsMap` 条目（`'session/path-not-found'`、`'subagent/attachment-unsupported'`），与该文件里已有的相邻条目保持一致，而不是发明一套新方案。

**`commands.ts` 里的 `fileBlockIn`/`imageBlockIn` 保持各自独立、刻意不做泛化。** 本次移植新增的 prompt 准入辅助函数在结构上镜像既有的图片准入辅助函数，而不是抽出一个共用泛型——重构既有、无关且可正常工作的图片准入代码不在本次搬迁的范围内。

**`llm-pi-ai` 的 `toPiContext`/`PiAiAdapter` 早已独立于本特性、从原始补丁的位置参数签名（`attachments, onReplayDegrade, maxRequestImageBytes, requestImagePolicy`）重构成了对象参数的 `PiImageRequestContext` 接口。** 文件降级的接线（`d56a5f7348` 的 `contentHasFile`/`lowerFileBlocksFromStore` 调用与 `5cd83e5a14` 的 `spill` 参数）适配这一新形状的方式，是给 `PiImageRequestContext` 加一个可选的 `spill?: FileSpillOptions` 字段、并按条件展开（`...spill === undefined ? {} : { spill }`）而不是按位置传参，因为 `exactOptionalPropertyTypes: true` 会拒绝显式赋值 `spill: undefined` 的属性。

**一个新的 Context 合并服务，需要先在 `tsconfig.host.json` 里补一条 project reference，`gen-cordis-catalog` 的静态分析器才能发现它**，这独立于 `tsconfig.base.json` 的路径别名注册（`vitest`/`vite-tsconfig-paths` 做源码层解析所需）、也独立于该包是否已在 `pnpm-workspace.yaml` 的 glob 范围内。`scripts/cordis-walk.ts` 的原始 AST 扫描（`declaredKeys`）直接对 `packages/*/*/src/**` 做 glob，能找到任意 `declare module '@deepseek-ai/cordis'` 合并块；但 `@deepseek-ai/dsh-typert-generator` 的 `WorkspaceAnalyzer`（`renderedKeys`）是通过以 `tsconfig.host.json` 的 project reference 图为根的 TypeScript 程序来解析类型的——一个不在该图里的包就是"已声明但不可见"，`gen-cordis-catalog.ts` 的分区检查会把这种情况报告成"在 Context 合并里已声明，但渲染投影看不到"，而不是报缺文件。`scripts/gen-tsconfig-paths.ts` 并不维护这份文件；它保持手工维护。

**包 README 的文档标准（frontmatter 的 `kind`/`description`、强制的 `## Summary`/`## Table of Contents`/`### Dev Note` 二三级标题骨架）比原始 `5cd83e5a14` 的 README 内容出现得更晚。** `dsh-attachment-spill/README.md`/`.zh.md` 围绕原始内容里未变的 Config 表格、Behavior 步骤、以及本就符合规范的 Model Experience/Known Limitations 正文，重新组织到当前模板（`Use this package`/`Understand the implementation`/`Further Exploration`/`Model Experience`/`Known Limitations and Deferred Work`/`Dev Note`，以 `dsh-spill-local/README.md` 为参照实例）。中文文档标准闸门（`scripts/doc-standard.spec.ts`）只强制要求三个标题被翻译——`## 概述`、`## 目录`、`### 开发备注`——其余的 `Use this package`/`Understand the implementation`/`Further Exploration`/`Model Experience`/`Known Limitations and Deferred Work` 本可保留英文；本次移植仍然把它们全部翻译，以匹配 `dsh-spill-local` 全篇双语的既有惯例。

**`attachment/materialized` 通过 `gen-persistence-catalog` 的 AST 扫描登记进 `KNOWN_SESSION_EVENT_TYPES`，而不是走 `ignorable` 标记通道。** `packages/core/session/src/known-event-types.ts` 自身的文件头声明：该表是对 `packages/*/*/src/**` 下每一个第一方 `SessionEventMap` 声明的穷尽枚举；`ignorable: true` 专门留给确实位于仓库之外的第三方插件事件。在 `dsh-attachment-spill/src/types.ts` 里声明该事件、重跑生成器即可，不需要手工改列表，也不需要 `ignorable` 标记。

**把 `CallId` 改名为 `ToolCallId`**——凡是原始补丁内容引用过它的地方都做了这个改名（`dsh-attachment-spill/src/index.ts` 的 `ToolCallId(String(attachment.attachmentId))`、两个适配器的测试夹具），这跟踪的是上游在原始补丁写成之后、本次同步基座之前就已经落地的改名。

## Alternatives considered

**在搬迁 `fileBlockIn`/`imageBlockIn` 的同时把它们泛化成一个共用的带参数辅助函数。** 已拒绝：`commands.ts` 里既有的图片准入代码本身能正常工作、且与本次移植无关；一项搬迁任务的职责是搬动并适配被点名的补丁内容，而不是重构该补丁从未触及的代码。刻意选择重复，而不是做一次未被要求的抽取。

**给 `dsh-attachment-spill` 的 `resolveSpill` 一个传入的会话 id 参数，而不是读取 `ctx.agents.currentInitiator()`。** 已拒绝，与原始 `5cd83e5a14` 的决定保持一致：降级文件分片这一步总是发生在发起方 agent 自身的异步调用链内部，因此从活的 `Agent.session` 读取，而不是接受调用方传入的 id，从结构上排除了两者不一致的可能。

**跳过翻译 `dsh-attachment-spill/README.zh.md` 里的 `Use this package`/`Understand the implementation`/`Further Exploration`/`Model Experience`/`Known Limitations and Deferred Work` 标题，因为 `scripts/doc-standard.spec.ts` 并未强制要求。** 已拒绝，改为全部翻译：本次移植所参照的模板 `dsh-spill-local/README.zh.md` 翻译了每一个标题；只满足闸门的最低要求而不匹配同类包的实际惯例，会让一对双语文档明显不一致，换来的只是省下一点点时间。

## Consequences

该系列以六个提交落地（每条 SKIPPED 登记项一个提交，文件降级/spill 分组为一个压缩提交、提交信息同时点名 `d56a5f7348` 与 `5cd83e5a14`）；`.claude/core-patches.md` 为每条登记项记录了新的落点。`tsconfig.base.json`、`tsconfig.host.json`、`scripts/gen-cordis-catalog.ts`（`SERVICE_PAGE`）与 `scripts/gen-doc-graphs.ts`（`SERVICE_ROLES`）都新增了各自生成器要求的 `attachmentSpill` 条目；`packages/bundle/base/{cordis.patch.yml,package.json}` 与 `python/sdk-runtime/package.json` 新增了 `pnpm run hygiene` 对一个已加载插件所要求的 `@deepseek-ai/dsh-attachment-spill` 依赖声明。每个改动到的包在其改动源码上保持逐文件 100% 覆盖；`pnpm exec tsc -b tsconfig.host.json --force`/`tsconfig.client.json --force` 与 `pnpm run doc-sync`（32/32 个 gate）均为绿色。

**退役条件。** 每条登记项各自独立退役，退役条件仍是其各自 `.claude/core-patches.md` 行里已经记录的那一条（本次移植未改变）：上游自身架构在同一接缝处获得等价能力时。
