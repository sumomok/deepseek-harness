# Agent Note: 把「文本文件作为输入区草稿附件」补丁移植到 0.1.2 重组之上

Status: implemented

[English](2026-08-31-file-attachment-composer-intake-port.md) | 中文

## 问题

原始补丁（`98020a23cd`，"text files as composer draft attachments"）让输入区把拖入或粘贴的文本文件当作与图片并列的一等草稿附件对待：`ComposerAttachment` 判别式联合类型、把混合批次在到达图片/文件摄入通路前先做客户端内容嗅探拆分、附件栏旁新增的 `FileChipRow`，以及把 `image-labels.ts` 改名为 `attachment-labels.ts` 以承载两种附件的文案。该补丁早于上游 0.1.2 的包重组（`ui-conversation` 拆分为 `ui-conversation`/`ui-chat`/`ui-trajectory`；一条 `dsh.client` 跨包运行时导入闸门收紧；一套乐观提交回显系统落地），也早于 rc.26 同步自身的 A 族工作（新增了这份 composer 工作所依赖的 `session.file` 回读 RPC 与文件内容分片线路管道）。原样移植原始 diff 无法在当前代码树上编译：它的两个目标模块换了包、它目标的共享工具位置如今被禁止、它目标的提交路径已经带有原始补丁从未需要处理的字段。

## 决策

**判别式联合类型与复用输入状态机原样移植。** `packages/client/ui-conversation/src/client/contract/slots.ts` 中的 `ComposerImageAttachment`/`ComposerFileAttachment`/`ComposerAttachment` 与原始补丁完全一致，`InputState.imageIds`/`addImages`/`removeImage` 不加修改地复用给文件 id 同样一致——这条冻结的输入机契约至今仍从不检视内容种类。

**`attachmentSizeText` 与文件嗅探二件套搬进 `ui-primitives`，而不是留在 `ui-conversation` 的 client 出口。** 原始补丁把两者都从 `ui-conversation` 的出口重新导出，供 `ui-attachment` 以运行时值的方式跨 `ui-conversation` → `ui-attachment` 包边界导入；这条边界在重组前的代码树上合法，但如今被 `verify-client-packages` 拒绝：一个带 `dsh.client` 字段的（"动态"）client 包不得声明指向另一个动态包导出值的运行时 `external`，只有纯类型导入能存活。`packages/client/ui-primitives` 不带 `dsh.client` 字段——它是一个普通库包，完全豁免于动态行检查，`ui-attachment` 早已用同样方式从这里导入 `IconCloseFill14`/`StateDot`。`byte-size.ts`（`attachmentSizeText`）与 `file-sniff.ts`（`sniffIsText`/`partitionDroppedFiles`/`PartitionedFiles`）搬到那里；`ui-conversation` 自己的消费者（`attachment-labels.ts`、`InputBar.tsx`）与 `ui-attachment` 的 `ComposerAttachments.tsx` 都直接从 `@deepseek-ai/dsh-client-ui-primitives` 导入。这使得原始序列后续的构建纯净性修复提交（`59657e0132`，修复正是这种跨包模式导致的过时导入回归）在本次移植中变得无意义：它修复的 bug 从一开始就不会被引入，因为一开始就采用了正确的非动态包落点。台账中把 `59657e0132` 记为已跳过，理由即此说明，而非静默丢弃。

**提交回显给 `images` 新增一个 `files` 兄弟字段，而非改名。** 原始补丁早于 `beginSubmission`/`PendingSubmission`/`PendingSubmissionRetirement`（上游后加的能力：在宿主往返落定之前先插入一次同步的本地回显）；当前代码树的 `sendSession` 早已让每一次图片提交都经过它。若把文件草稿路径移植进来却不接入回显，会造成静默回归：带文件的发送将不显示任何乐观气泡，composer 也会依据错误的信号决定是否还原草稿。`BeginSubmissionInput.files: readonly PendingSubmissionFile[]`（名称+字节数，提交时即可同步获知——不像图片的尺寸需要异步探测头信息）、`PendingSubmissionRetirement` 的 `observed` 变体把 `attachments` 改名为 `images` 并新增兄弟字段 `files: readonly FileAttachmentRef[]`，`Session` 内部的 `imageRefsIn` 改名为 `attachmentRefsIn` 以同时扫描 `'image'` 与 `'file'` 类型的内容分片。`ConversationController.sendSession` 把已解析的草稿拆成 `imageAttachments`/`fileAttachments`，两者都纳入 `beginSubmission`，并在回显落定时分别经由并列的 `settleSubmittedImages`/`settleSubmittedFiles` 方法结算（文件结算方无需撤销任何资源——文件草稿本就没有浏览器预览资源）。在 `packages/api/session-controller/src/list.ts` 中新增 `fileLimits` 会话投影（对照既有的 `imageLimits`），读取 `ctx.attachments.fileLimits`——这个字段已由 A 族落地在 `AttachmentStore` 抽象类上，无需再改宿主侧附件服务。

**其余部分原样移植**：`FileChip.tsx`/`FileChip.module.css`（与原始文件逐字节一致）、`ComposerAttachments.tsx` 的拆分拖放/双行渲染逻辑、`attachment-labels.ts` 的 `attachmentErrorText` 文件类原因分支、`file.*` locale 键集合与拖放文案的隐私提醒、`InputBar.tsx` 的 `intakeFiles`/`intakeDrop` 按种类分别预检的配对（仅适配为经由当前代码树既有的 `registerComposerKeymap` 粘贴钩子——这是原始补丁所在的基线代码树尚不存在的一层键盘映射抽象），以及 `ConversationController` 的 `createDraftFiles`/`releaseDraftImage` 种类判别/`serializeDraftImages` 种类过滤/`serializeAttachments` 按种类分派/`encodeFile`。

**与下一个移植（B.1+B.2，原始补丁 `fabc93555c`）的范围边界。** `fabc93555c`（"file-part bubble card and the referent/open seam"）在上游紧随本补丁之后落地，且触碰了本补丁也触碰的三处文件：`AssistantBlock` 的 `{kind:'file', ...}` 变体（`contract/records.ts` 及其 Chat 侧投影）、`attachmentErrorText` 的 `SUBAGENT_FILE_UNSUPPORTED` 分支与 `file.subagentUnsupported`/`file.open`/`file.loading`/`file.loadFailed` locale 键，以及 `ISession.readFile`。这些内容在本次移植的开发过程中曾与本补丁一并起草，但刻意从本次提交中剔除，留给 `fabc93555c` 的移植：它们属于下一个补丁的 diff，不属于这一个——即便原地编译并无阻碍，纳入此处也会违背本笔记自身「一个原始补丁对应一个提交」的纪律。

## 考虑过的替代方案

**保留原始补丁在 `ui-conversation` 出口的重新导出，转而给 `ui-attachment` 显式声明一条 `external`。** 已否决：这条路径被直接实测过（往 `ui-attachment` 的 `package.json` 加入 `"external": ["@deepseek-ai/dsh-client-ui-conversation/client"]` 并跑 `verify-client-packages`），闸门直接以自身报错点名了这条违规。该闸门晚于原始补丁出现，不是一个需要绕过的误报。

**保留 `PendingSubmissionRetirement.attachments` 不动，另加一个并列的 `fileAttachments` 字段，而不是改名为 `images`。** 出于对称性考虑已否决：一个未加说明的 `attachments`/`fileAttachments` 字段对会让人误以为 `attachments` 仍然意味着"全部"，而它其实自始至终只承载过图片引用。改名为 `images`/`files` 让两个字段各自照实命名其所载内容，符合 CLAUDE.md 中反对并列值间无说明不对称的约定。

**把 `fileLimits` 也推迟到 `fabc93555c` 的移植——理由是它唯一的消费者（`InputBar.tsx` 的文件摄入预检）才是本补丁范围，而底层的 `AttachmentStore.fileLimits` 字段属于 A 族。** 已否决：原始补丁自身的 `fileLimits` 摄入预检若没有为其服务的投影，就没有独立价值；而注册该投影本身是一次小巧、对称、自成一体的新增，紧挨着既有的 `imageLimits` 注册——推迟它只会让本补丁交付一个永远退回宿主判断、无法测试客户端限额路径的预检。

## 后果

生成文件 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 经 `pnpm run gen-client-catalog` 拾取了拓宽后的 `ComposerAttachmentsOwnerProps`/`ComposerBarInjected` 形状。`packages/client/ui-conversation/tests/input-matrix.client.spec.tsx`、`input-scenarios.client.spec.tsx`、`skeleton.client.spec.tsx` 都需要原始补丁同款的机械性 `addFiles: () => null` 补全。`input-bar.client.spec.tsx` 与 `composer-attachments.client.spec.tsx` 需要原始补丁同款的 PNG 魔数字节与「围绕异步嗅探加 `waitFor`」修复，此外本次移植自身的基线还要求一处额外修复：混合粘贴测试里对草稿落定的断言在当前代码树上早已被包在 `waitFor` 里（这是原始补丁所在基线代码树没有的一处无关的既有时序修复），因此本次移植保留这层包裹，而不是照原始补丁改回同步断言。`service-orchestration.client.spec.ts` 移入了原始补丁的三个新测试（文件草稿创建/释放、图片+文件混合发送、`serializeDraftImages` 按种类过滤），其中混合发送测试被改写为经由当前代码树的回显测试脚手架（`beginSubmission`/`onRetire`）——原始测试早于这套脚手架；该文件原有的三个回显测试的 `onRetire({reason:'observed', attachments: [...]})` 调用点都需要更新为改名后的 `images`/`files` 形状，否则 `ConversationController` 里 `retirement.images[index]` 的读取会在 `undefined` 上抛错。`attachment-labels.client.spec.tsx` 只保留了原始文件里 `attachmentErrorText` 相关的覆盖；原始文件里的 `AssistantMarkdown` "assistant image slot handoff" 描述块测试的是一个在本次移植开始前、0.1.2 重组早已搬到 `ui-chat` 的组件，因此从未该出现在这个文件的移植版本里。字节大小的单元测试搬到了新建的 `packages/client/ui-primitives/tests/byte-size.client.spec.ts`，文件嗅探单元测试搬到了新建的 `packages/client/ui-primitives/tests/file-sniff.client.spec.ts`，跟随其源模块一起搬迁。

**后续补口（2026-09-01）。** 本次移植带上了 composer 自己那一半——草稿态、准入、条形卡片呈现——却没带组装式 web 场景赖以运行的 fixture 传输层。`packages/client/connection` 的 `createFixtureConnection` 只认识 `text` 与 `image` 两种 prompt 分片，于是它的 prompt 映射器对一个携带 `name`／`text` 的文件分片去读 `block.data.length`，任何经 fixture 发送文件的操作都以 `session/prompt failed: Cannot read properties of undefined (reading 'length')` 告终——composer、输入机器与持久化缝隙三者其实都是对的。现在 fixture 与图片侧一一对称：prompt 分片联合新增 `file` 成员（形态即 composer 的 `EncodedFileAttachment` 线上形式）、按 prompt 铸出的 id 建索引的 `fileAttachments` 存储，以及一条返回 `{ attachment, text }` 的 `file` 路由，其鉴权沿用 `attachment` 路由既有的 `logReferencesAttachment`——该端点即宿主侧 `@Remote('file')` 所声明者。`apps/web/tests/file-display.expected.e2e.ts` 在其上重放通过。

**退役条件。** 与原始补丁一致：这层 composer 摄入逻辑是给上游尚不具备的能力打的临时补丁。一旦上游自己的 composer 开始接受非图片附件，本补丁（及本次移植）退役，本 fork 转而适配上游的形态。
