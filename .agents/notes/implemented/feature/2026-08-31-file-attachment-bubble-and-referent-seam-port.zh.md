# Agent Note: 把「文件分片气泡卡片与 referent/open 缝隙」补丁移植到 0.1.2 重组之上

Status: implemented

[English](2026-08-31-file-attachment-bubble-and-referent-seam-port.md) | 中文

## 问题

原始补丁（`fabc93555c`，"file-part bubble card and the referent/open seam"）新增了一个 ROOT 作用域的 cordis waterfall 事件 `referent/open`：浏览器会话 UI 中每一次「打开该引用」的用户手势都先经过它，再回落到自己的默认打开动作；把既有的 `openFile` 闭包接进这条缝隙；并把一条消息里的 `{kind: 'file'}` 内容分片渲染为用户气泡与 Assistant markdown 流里都可内联、可惰性展开的 `FileCard`，背后由新增的 `ISession.readFile`／`loadFile` 对偶支撑，镜像图片画廊的 `readAttachment`／`loadImage`。它早于 composer 摄入移植（`98020a23cd`，已移植为 `a21f837b51`）同样早于的那三项上游改动：把 `ui-conversation` 的 `chat/` 子树拆分出新包 `ui-chat` 的包重组、`dsh.client` 跨包运行时导入闸门、乐观提交回显系统。它还依赖 `98020a23cd` 自身的 `ComposerFileAttachment`／`attachment-labels.ts` 界面，因此在那个补丁落地之前无法移植本补丁。

## 决策

**`referent.ts` 搬到 `packages/api/session-controller/src/client/`，而不是 `packages/client/runtime/src/client/`。** 原始补丁的目标包 `client/runtime` 在重组后的代码树上已不存在；重组把它面向 Client 的 Session/Sessions 契约与 adapter 并入了 `packages/api/session-controller`。`dispatchReferentOpen`、`ReferentRef`、`ReferentKindMap` 在实质上原样落到那里（只是导入路径与模块文档里的包名变了），从该包的 `client` 出口重新导出，方式与原始补丁从 `runtime` 出口重新导出完全一致。`ISession.readFile()` 及其实现出于同样理由，加入同一个包里 `contract/session.ts`／`sessions/session.ts` 中既有的 `readAttachment()` 旁边。

**`FileCard.tsx`、它的渲染调用点，以及 `openReferent`／`loadFile` 的插槽布线搬到 `ui-chat`，而不是 `ui-conversation`。** `MessageItem.tsx`、`AssistantMarkdown.tsx`、`AssistantNodeView.tsx`、`ChatNodeSeat.tsx`、`ChatView.tsx`——原始补丁为渲染而触碰的每一个文件——在本次移植开始之前就早已搬到了 `ui-chat`，并携带自己独立的 `chat` locale 命名空间（`ui-chat/src/client/locale.ts`），有别于 `ui-conversation` 的 `conversation` 命名空间。`OpenReferent`、`loadFile` 与文件打开相关的 locale 键（`file.open`／`file.loading`／`file.loadFailed`）加入的是 `ChatNodeOwnerProps`／`ChatViewInjected` 与 `ui-chat` 自己的 locale 文件，而不是 `ui-conversation` 的——一个键应活在它唯一消费者所读取的命名空间里。`attachment-labels.ts` 的 `SUBAGENT_FILE_UNSUPPORTED` 分支及其 `file.subagentUnsupported` 键留在 `ui-conversation`，因为读取它的函数 `attachmentErrorText` 至今仍在那里，重组并未移动它。

**把 session-controller 的运行时值导入 `ui-chat` 与 `ui-conversation`，不受 `verify-client-packages` 限制。** 两者都是带 `dsh.client` 字段的动态 client 包；`packages/api/session-controller` 不在 `packages/client/*` 之下，因此 `scripts/verify-client-packages.ts` 的 `CLIENT_MANIFEST_GLOB`（`packages/client/*/package.json`）从未把它枚举为受动态包 `external` 限制约束的行。`dispatchReferentOpen`／`ReferentRef`／`readFile` 以普通运行时导入的方式跨越这条边界，接好线之后跑 `pnpm run verify-client-packages` 全绿，已实测验证。

**一个持久化的文件分片渲染为可交互的 `FileCard`；一次提交回显里在途的文件渲染为不可交互的条形卡片。** 原始补丁完全早于 `PendingSubmission`／`PendingSubmissionRetirement`——它当时没有任何提交回显气泡需要扩展，只有它所针对的、由 durable event 支撑的消息气泡。当前代码树的 `PendingSubmissionBubble`（composer 摄入移植自身的回显系统工作新增）需要一次对称扩展：一份在途的 `PendingSubmissionFile` 只携带 `{name, bytes}`，没有 durable 的 `attachmentId`，因此它无法像 `FileCard` 那样经 `loadFile` 解析或派发 `referent/open`。`UserStyleBubble` 新增 `previewFiles` 属性，渲染为一行朴素的 `name` + `attachmentSizeText(bytes)`（`MessageItem.module.css` 的 `.filePreview*` 系列类），把 `FileCard` 留给那些已经携带真实 `attachmentId` 的内容分片。

**不移植客户端侧的子智能体传输前拒收检查。** 原始补丁在 `Session.prompt()` 内部新增了一条 `SUBAGENT_FILE_UNSUPPORTED` 检查，与同一调用点既有的 `SUBAGENT_IMAGE_UNSUPPORTED` 检查配对。本次同步的 A 族自身工作（`121338b26f`，prompt RPC 的文件内容准入）已经新增了一个服务器端的对称等价物：`packages/subagent/subagent/src/control.ts` 里的 `admitPromptContent()` 对一个无法续接的子智能体同时拒收 `SUBAGENT_IMAGE_UNSUPPORTED` 与 `SUBAGENT_FILE_UNSUPPORTED`，`packages/subagent/subagent/tests/control.spec.ts` 里已有相应覆盖。原始补丁自身基线代码树里的 `packages/client/runtime/tests/session.client.spec.ts` 有一条测试自带注释，确认这是刻意设计，而非本次移植应当纠正的疏漏："The image reaches the wire unfiltered: refusing it is the Host's call."（图片未经过滤直达 wire：拒收与否是 Host 的判断。）重新加入一份客户端重复检查，会导致客户端抢在 Host 自身的准入逻辑运行之前就先行拒收，偏离已经上线、已经测试过的设计。这是相对原始补丁的一处偏差，不是机械的位置决策——在此和台账里都如实记录，既不静默移植，也不静默丢弃。

## 考虑过的替代方案

**仍然移植客户端侧的 `SUBAGENT_FILE_UNSUPPORTED` 检查，理由是重复校验属于纵深防御。** 已否决：`packages/subagent/subagent/tests/control.spec.ts` 的既有覆盖与 session-controller 那条测试自带的注释，共同确立了「让未经过滤的图片或文件直达 wire、由 Host 端拒收」正是本次同步架构的预期设计，而非意外缺口。再加一道客户端侧拒收点，会为同一条策略制造两个真相来源，且有静默失步的风险，这与「误配置失败要响亮」「显式优于隐式」的约定相悖。

**把 `file.open`／`file.loading`／`file.loadFailed` 留在 `ui-conversation` 的 locale 文件里，由 `ui-chat` 导入。** 出于与 `98020a23cd` 笔记给 `attachmentSizeText` 的相同理由已否决：`ui-chat` 本身就是一个动态 client 包，把另一个动态包的 locale 值当作运行时常量跨边界导入，属于 `verify-client-packages` 本就要盯防的同一类导入，即便这几个具体的键目前恰好不会触发闸门（locale 对象是纯数据，闸门对它们的把关方式不同）。把键放在其唯一消费者旁边，避免了依赖闸门当前范围永远不变这个假设，也符合「键应活在读取它的包的命名空间里」这一通用原则。

## 后果

`packages/client/ui-chat/tests/file-card.client.spec.tsx` 是新文件，近乎逐字从原始的 `ui-conversation/tests/file-card.client.spec.tsx` 移植而来，跟随 `FileCard.tsx` 自身的搬迁。`packages/client/ui-chat/tests/image-labels.client.spec.tsx`、`chat-branch-tails.client.spec.tsx`、`gate-branch-tails.client.spec.tsx`、`coverage-tails.client.spec.tsx`、`reasoning-row.client.spec.tsx` 都需要把 `loadFile`／`openReferent` 桩件穿进每一次 `<AssistantMarkdown>` 调用，机械跟随拓宽后的属性。`packages/client/ui-workflow-run/tests/workflow-run.client.spec.tsx` 与 `packages/test-support/client-runtime/tests/runtime.client.spec.tsx` 需要同样机械的补全，以配合 `ISession.readFile` 新增的「失败要响亮」桩实现。`packages/extensions/cordis-client-runner/src/client/api-catalog.ts` 与 `slot-catalog.ts`（生成文件）经 `pnpm run gen-cordis-inspect-catalog` 与 `pnpm run gen-client-catalog` 拾取了 `referent/open` 与拓宽后的 `ChatNodeOwnerProps`／`ChatViewInjected` 形状。`scripts/gen-cordis-catalog.ts` 的 `EVENT_WALK_EXEMPTIONS` 新增了 `referent/open` 一项，因为该事件的契约记述在 `packages/api/session-controller/README.md`，而不是生成器能直接走到的某个逐事件 JSDoc 位置。`packages/client/ui-trajectory/src/client/layout.ts` 与 `TrajectoryView.tsx` 为文件内容分片的轨迹投影新增了与原始补丁目标文件相同的机械性 `case 'file':` 分支，跟随各自早已存在的 `case 'image':` 分支的写法。

`packages/api/session-controller/README.md`／`README.zh.md` 新增了一段记述 `dispatchReferentOpen`／`ReferentRef` 的文字，镜像原始补丁对 `packages/client/runtime/README.md`／`README.zh.md` 在该包后来所在位置的新增。`packages/client/ui-conversation/README.md`／`ui-chat/README.md` 未携带原始补丁对"chat view keeps Tool placement..."段落的更新，也未新增其 `FileCard` 段落：两份 README 在重组后的代码树上目前都完全不涉及 `openFile`／Tool 调用分派或 `FileCard` 实现细节——这部分内容已经在上游重组过程中被裁剪掉，与 `98020a23cd` 移植时在 `ui-attachment/README.md` 对应小节上发现的模式一致。

**退役条件。** 与原始补丁一致：`referent/open` 是仅存在于本 fork、为上游会话 UI 尚未暴露的能力打的拦截缝隙。一旦上游自己的会话 UI 原生渲染文件内容分片、并暴露出等价的打开/引用拦截缝隙，本补丁（及本次移植）退役，本 fork 转而适配上游的形态。
