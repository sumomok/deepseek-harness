# Agent Note：文件分片的气泡呈现与 `referent/open` 缝隙

状态：已实现

[English](2026-08-28-file-attachment-bubble-and-referent-seam.md) | 中文

## Problem

本系列此前的提交已经把文本文件送上了 wire、写进会话日志成为 `{kind:'file', attachment: FileAttachmentRef}`、接入了请求物化，也让它在 composer 里成为一等草稿附件——但已发送的文件分片在消息气泡里依然无处渲染，插件也没有任何办法拦截对一个文件/目录引用的点击：`apply.ts` 注入的 `openFile` 闭包始终直接请 Host 打开路径。这两个缺口指向同一个使用场景：一个想就地预览被引用的文件、目录或 URL、而不是甩给 Host/OS opener 的插件，没有缝隙可挂；用户也无法看到或重新打开刚发送出去的文本。

## Decision

**直接内联的 `FileCard`，而非新建一套 slot 架构。** `MessageItem.tsx` 的内容分片遍历（用户气泡）与 `AssistantMarkdown.tsx` 的 block switch（Assistant block）分别把 `{kind:'file'}` 分片直接渲染为 `packages/client/ui-conversation/src/client/chat/FileCard.tsx`，呼应 `renderMessageImages` 的调用点位置，但不复用它的 slot 间接层。既有的图片画廊是一个 slot，因为它是可替换的*呈现*扩展点（`ui-attachment` 拥有该 renderer）；本系列没有任何要求需要文件卡片具备这种可插拔性，而新增一个 slot 会平白多出一个 `RenderMessageFiles` 类型、一个新的 `ui-attachment` 组件和一处新的 `apply.ts` 注册，却没有换来任何被要求的收益。

**`referent/open` 缝隙**（`packages/client/runtime/src/client/referent.ts`）：一个 ROOT 作用域的 cordis waterfall（瀑布式事件），经声明合并接入 `Events`，通过 `dispatchReferentOpen(ctx, ref, onDefault)` 派发。`ReferentRef` 只携带引用本身——`kind`（经 `ReferentKindMap` 可合并扩展，预置 `file`／`dir`／`url`）、`target`、`raw`、可选的 `attachment`／`sessionId`、`source`、`provenance`（`'structured' | 'model-text' | 'tool-output' | 'user-text'`）——从不携带内容。监听者不调用 `next()` 直接返回即为认领这次点击；调用 `next()`（或抛出异常／拒绝，两者都会被捕获、记录日志，并按等同于隐式调用了 `next()` 处理）会继续向后委托，最终落到调用方提供的默认动作。派发点只出现在用户手势处理函数中——这既是设计意图，也由测试固定——从不出现在自动投递路径上，因为认领会被信任去执行副作用。

**接在唯一一处既有卡点上。** `apply.ts` 的 `openFile` 闭包（`packages/client/ui-conversation/src/client/apply.ts`）现在先派发 `referent/open`（`kind: path === '.' ? 'dir' : 'file'`，复用 `ChatView.tsx` 里既有的 `isFolderOpenPath` 风格启发式判断，因为这个闭包拿不到更精确的文件/目录信号；`provenance: 'structured'`；`source: 'chat-view.openFile'`），把既有的 `workspaces.openPath(target)` 调用作为该 waterfall 的终点。这一步让产物文件条、Tool 行与提及引用一次性全部变得可拦截，且在没有监听者注册时行为零改变——通过原样重跑既有的 `apply-inject.client.spec.tsx` 套件证实（11/11 通过，包括成功路径与失败传播路径两者）。`FileCard` 自己的点击独立派发同一个缝隙（`kind: 'file'`、`source: 'message-file-card'`，携带该内容块的 `FileAttachmentRef`），认领落空后才回落到自己的默认动作：切换一个内联展开/收起查看器。

**`loadFile`／`ISession.readFile` 对偶于 `loadImage`／`ISession.readAttachment`。** `packages/client/ui-conversation/src/client/service.ts` 新增 `resolveFile(sessionId, attachment)`，按 `${sessionId}:${attachmentId}` 缓存 pending／已结算的文本，并在会话作用域释放时清理——结构上与 `resolveImage` 的缓存完全一致。`ISession`／`Session` 上的 `readFile` 对偶于 `readAttachment`，返回 `{attachment, text}`（明文 UTF-8，不经 base64——文件从头到尾就是这个形态）。`FileCard` 只在首次展开时惰性抓取一次，同一挂载实例之后的收起/再展开不会重新抓取。

**子智能体续接对文件分片的拒收方式与图片一致。** `Session.prompt()`（`packages/client/runtime/src/client/sessions/session.ts`）此前会把送到可续接子智能体的 `'file'` 内容分片静默丢弃（那处 `flatMap` 只保留 `'text'`），而图片分片得到的是响亮的 `SUBAGENT_IMAGE_UNSUPPORTED` 拒绝。发送时静默丢内容，违反本仓库在别处强制执行的"模型可见⟺已记录"不变式，也违反通用的对称性约定。文件分片现在得到相同待遇：在任何传输调用之前就被拒绝，`{code: 'attachment-error', details: {reason: 'SUBAGENT_FILE_UNSUPPORTED'}}`，在 `attachment-labels.ts` 里映射为 `file.subagentUnsupported` 产品文案，与 `image.subagentUnsupported` 逐字对偶。

## Alternatives considered

**`dispatchReferentOpen` 里用一个布尔量 `ran` 作守卫。** 一次真实的、既有的测试失败暴露出这个方案的缺陷后被否决：`let ran = false; guardedDefault = async () => { if (ran) return; ran = true; await onDefault() }` 无法区分"默认动作已经跑过、现在正是它自己在失败"与"某个监听者在从未委托之前就抛出了异常"这两种情况。在零监听者注册的情况下，`apply-inject.client.spec.tsx` 的 `'openFile rejects when the Host cannot open the path'` 测试把 `workspaces.openPath` mock 成拒绝；这个拒绝传进 catch 块，catch 块随即再次调用 `guardedDefault()`——因为 `ran` 已经是 `true`，这次调用是静默空操作——于是 `dispatchReferentOpen` 落定为 `undefined`，而不是把真实的失败传播出去。替换为一个被记忆的 `settled: Promise<void> | undefined`：`guardedDefault = () => { settled ??= Promise.resolve().then(onDefault); return settled }`；catch 块在 `settled` 已经被设置时（说明这是一次真实的默认动作失败）重新 `await` 并重新抛出它，只有在某个监听者从未委托之前就抛出异常时，才第一次落到这条回退路径。

**为文件卡片的呈现新建一个 slot。** 否决：本系列没有任何要求需要一个可替换的文件卡片 renderer；既有的图片 slot 之所以存在，正是因为 `ui-attachment` 独立拥有那份呈现——在这里新加一个，就是为一张目前只有一种实现（名称+大小+内联展开）的卡片凭空搭建未被要求的架构。

**在 `openFile` 包装点获取更精确的文件/目录信号。** 否决：`apply.ts` 的闭包只拿到一个 `path: string`；发明一个新信号、比既有的 `path === '.'` 启发式（`ChatView.tsx` 出于同样目的已经在用）更精确地区分文件与目录，超出了这个缝隙本身的范围，还会牵动本系列原本不需要改动的调用点。

## Consequences

`packages/extensions/cordis-client-runner/src/client/{api-catalog.ts,slot-catalog.ts}`（生成产物）经 `pnpm run gen-client-catalog -- --write` / `pnpm run gen-cordis-inspect-catalog` 拾取了 `ISession.readFile`、放宽后的 `AssistantBlock` 与 `ChatNodeOwnerProps.{loadFile,openReferent}`。六个既有测试文件（`ui-conversation` 的 `chat-branch-tails`、`attachment-labels`、`chat-view`、`coverage-tails`、`gate-branch-tails`、`reasoning-row`，加上 `ui-workflow-run` 的 `workflow-run.client.spec.tsx`）需要机械性地补上 `loadFile`／`openReferent` 桩，以满足新增的必填字段 `ChatNodeOwnerProps`／`AssistantMarkdownProps`。

**覆盖率豁免范围，经实测确认而非假设。** `packages/client/ui-conversation/src/client/*` 的排除 glob，连同 `packages/client/runtime/src/**/!(settings-scope).ts` 与 `packages/client/ui-trajectory/src/*` 的排除 glob，在当前这版 vitest 里豁免的是**整棵嵌套子树**，而不只是被点名目录下的直接文件——通过限定范围的 `vitest run --coverage` 实测确认：即便是被深度嵌套、且被大量实际执行的文件（例如 `skeleton/InputBar.tsx`、`contract/slots.ts`、`chat/FileCard.tsx`），乃至把范围收窄到唯一一个确凿导入并执行了它们的测试文件时，覆盖率报表里都不出现这些文件的任何一行。这与上一提交自己的 Agent Note 与 ledger 条目里记录的一个假设不一致；此处不去改动那份既有记录（超出本提交范围），仅在此存档说明。实际影响：本提交触达的每一个 `ui-conversation`、`ui-trajectory`、`runtime` 文件都在豁免范围内，因此都不需要专门补测以通过覆盖率门；`packages/test-support/client-runtime/src/sessions.ts` **不**在豁免范围内，确实需要补一条——`readFile` 那个必失败桩的 `throw` 此前是未覆盖状态，直到 `runtime.client.spec.tsx` 补上一条对偶于既有 `readAttachment` 断言的新断言。

新增 `packages/client/runtime/tests/referent.client.spec.ts`（10 个测试：无监听者默认执行、认领抑制默认动作、`next()` 委托默认动作、注册顺序、`prepend`、经 `ctx.effect` 的 disposer、抛出/拒绝均回退默认动作并记录日志、成功委托之后不会重复执行默认动作、未识别 `kind` 的既定空操作）与 `packages/client/ui-conversation/tests/file-card.client.spec.tsx`（6 个测试：默认展开加惰性抓取、加载态、失败态、收起不重新抓取、认领的监听者完全抑制默认动作、派发的 `ReferentRef` 形状）。`packages/client/runtime/tests/session.client.spec.ts` 新增一条测试，同时覆盖可续接子智能体场景下此前未在这一层测过的图片拒收与新增的文件拒收。

## 退役条件

这层气泡呈现与引用拦截是给上游目前还不具备的能力搭的临时覆盖层：一旦上游自己的会话 UI 原生渲染文件内容分片、并暴露出等价的打开/引用拦截缝隙，本补丁即退役，依赖插件适配上游形式。
