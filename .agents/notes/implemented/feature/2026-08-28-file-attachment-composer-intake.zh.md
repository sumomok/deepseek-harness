# Agent Note：文本文件成为输入框草稿附件

状态：已实现

[English](2026-08-28-file-attachment-composer-intake.md) | 中文

## Problem

文本文件附件的 wire、会话日志与请求物化缝隙已经存在（上一提交），但浏览器端 composer 里没有任何代码能触达它们：一个被拖入或粘贴的文本文件要么落进图片专属准入路径的格式检查（被拒），要么经由与本系列一并退役的独立插件 `@sumomok/dsh-text-drop` 被当作原始文本拼进草稿——完全绕开那条持久、内容寻址的服务边界。本提交让 composer 的准入、草稿状态与拖放/粘贴入口把文本文件当作与图片并列的一等草稿附件对待，并顺带修好"混合拖放整批拒收"这个体验缺口（此前一批同时含一张图片与一个文本文件的拖放，会因图片路径的格式检查而被整批拒收）。

## Decision

**`ComposerAttachment` 变成判别式联合类型。** `packages/client/ui-conversation/src/client/contract/slots.ts`：`ComposerImageAttachment { kind: 'image', id, file, previewUrl }` 与 `ComposerFileAttachment { kind: 'file', id, file }`（没有 `previewUrl`——文件条只展示名称与大小，从不展示缩略图）取代原先单一的 `{kind:'image', ...}` 形态；`ui-attachment` 的 README 此前已在"已知限制"一节把这个形态点名为预期的扩展点。两个变体都携带 `file: File`，因此与 kind 无关的代码（字节大小运算、`.file.name`）无需窄化即可工作。

**输入状态机原样复用，不改名。** `InputState.imageIds: readonly DraftAttachmentId[]` 以及 `addImages`/`removeImage`/`pruneImages` 三个动词，本就把 id 当作完全不透明的值——从不检查内容种类——这一点贯穿 `machine.ts`、`facade.ts`、`hub.ts` 以及五个专门的测试文件，`contract.ts` 自己把这称作"冻结的输入状态机契约"。文件草稿走同一份列表、同一组动词，那里的任何代码都不需要改动。这是用命名精度换取避开一个被明确标记为冻结的契约上的大规模、有风险改动面（该字段字面上仍叫 `imageIds`，却同时承载文件 id）——这是一次刻意的、写在这里的取舍，不是疏漏。

**客户端嗅探是一份全新、精简、明确非权威的模块，而非共享导入。** `packages/attachment/attachment-local/src/sniff.ts` 自己的 JSDoc 早已预见"供客户端在完整读取一个大 File 之前先做嗅探"，但该包的主入口导入了 `node:path`、`@deepseek-ai/dsh-home-paths` 与 `sharp`——仅限 Node，即便经由 `./src/*` 子路径导入也不适合浏览器打包，因为那会让一个依赖 Node/sharp 的包跨越客户端/服务端边界进入客户端包的依赖图。`packages/client/ui-conversation/src/client/file-sniff.ts` 只复刻了那两行判定逻辑（NUL 字节检查，再做严格 `TextDecoder` 解码），实现为 `sniffIsText(file)` 与 `partitionDroppedFiles(files)`，并明确标注为仅供 UX 使用的预检查：持久附件缝隙自己的 `NOT_TEXT_FILE` 检查才是唯一权威的一道。

**两个原始文件入口，一个拆分函数。** 文档级拖放与文本域粘贴是两个独立的 DOM 事件来源，分别到达两个不同模块，因此各自拆分自己拿到的批次：`ComposerAttachments.tsx`（`ui-attachment`，持有全部文档级拖拽监听器）拆分一次拖放批次，把拆开的两半分别传给 `onAddImages`/`onAddFiles`；`InputBar.tsx` 的粘贴处理器经由自己的 `intakeDrop` 包装函数完成拆分，再分别调用 `intakeImages`/`intakeFiles`。`onAddImages`/`onAddFiles`（slot 持有方提供的 `ComposerAttachmentsOwnerProps` 成员）收到的都已经是拆分完毕的单一种类批次——拆分逻辑本身是 `partitionDroppedFiles`，从 `ui-conversation` 的 client 出口导出，供 `ui-attachment` 导入。

**新增 `FileChipRow` 组件，而非放宽 `AttachmentRail`。** `AttachmentRailItem.previewUrl` 是必填字段，附件栏的 CSS 是固定 64px 方块——不适合一个没有缩略图可展示的「名称+大小」条形卡片。`packages/client/ui-attachment/src/FileChip.tsx` 是一个精简的同级组件（对条目类型做泛型，呼应 `AttachmentRail<T extends AttachmentRailItem>`），在图片栏旁渲染一行可换行的条形卡片；`ComposerAttachments.tsx` 按 `kind` 过滤 `attachments`，两者都渲染。

**`image-labels.ts` 改名为 `attachment-labels.ts`。** 它现在把图片与文件两类 `AttachmentErrorCode` 原因都映射为产品文案（`attachmentErrorText` 在既有 `limits` 之外新增 `fileLimits` 参数），也为两类附件格式化字节大小（`imageSizeText` 改名为 `attachmentSizeText`，并从 client 出口导出供 `ui-attachment` 的文件条标签使用）——一个服务两类附件的模块若仍保留仅图片的名字，恰是仓库约定里点名警惕的那种无解释的不对称。

**拖放遮罩与提示文案**（`locales.ts`）：`image.dropTitle` 改为「图片或文本文件拖到此处即可添加」/ "Drag images or text files here to add them"；`image.dropDesc` 保留原有图片数量/大小行，并追加隐私提醒「文本内容会随消息发送，发送前留意其中的密码或密钥」/ "text content is sent as-is — check for passwords or secrets before sending"（这句提醒目前只在这一处出现——遮罩里没有单独的文件数量上限文案，因为任务给定的定稿文案本就没有这一项）。新增的 `file.*` 键逐一对应既有的每个 `image.*` 限额/标签键（`tooMany`/`fileTooLarge`/`totalTooLarge`/`notText`/`invalidName`/`pending`/`remove`/`label`/`sendFailed`）。新写的禁用词测试（`attachment-labels.client.spec.tsx` 加一条拖放文案断言）校验发布的 `image.dropTitle`/`image.dropDesc` 文案永不包含"检测/发现/识别/detect/scan"——这是针对本次这块界面自身定稿文案新写的测试，不是对已退役插件那份 hint-strip 测试的逐字移植（不同的界面、不同的最终文案）。

**斜杠命令提交文件被明确排除在本次范围之外。** `ConversationController.serializeDraftImages`（斜杠命令的图片提交路径）仍会解析每一个请求到的 id——因此既有的过期检测仍能覆盖一个文件 id——随后再按 kind 过滤只保留图片种类后编码。提交斜杠命令那一刻若存在文件草稿，会被静默排除在该命令仅含图片的载荷之外，而不是拒绝整次提交或改用别的方式序列化；目前没有任何命令面接受文件分片，凭空发明一个不在本系列范围之内。

## Alternatives considered

**经由通配符导出，从 `@deepseek-ai/dsh-attachment-local/src/sniff.ts` 导入 `sniffProbe`/`PROBE_BYTES`。** 否决：该包的 `dependencies` 包含 `sharp`，一个原生图像库，浏览器打包里没有它的位置；`./src/*` 出口的存在是为了让单一仓库自身的构建工具链解析 TypeScript 项目引用，不是邀请客户端包把仅限服务端的源码纳入自己的依赖图。

**把 `InputState.imageIds` 改名为通用的 `attachmentIds`。** 本系列否决：`contract.ts` 把输入状态机契约文档化为冻结状态，改名会波及 `machine.ts`、`facade.ts`、`hub.ts` 以及五个专门测试文件，换来的只是命名精度、没有任何行为变化。这里如实标注为一个真实、可辩论的取舍，而非已经盖棺定论的非问题。

**把 `AttachmentRailItem.previewUrl` 放宽为可选字段，在 `AttachmentRail` 内部分支渲染。** 否决：附件栏的整套布局（`AttachmentRail.module.css` 固定 64px 的 `.item`/`.thumbnail`）是按缩略图的尺寸设计的；文本条形卡片需要更宽、可换行的一行，而不是固定方块内的条件渲染。一个同级组件比一个要渲染两种视觉上毫无关系的形态的附件栏更容易组合。

## Consequences

`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（生成产物）经 `pnpm run gen-client-catalog -- --write` 拾取了放宽后的 `ComposerAttachmentsOwnerProps`/`ComposerAttachment` 形态。三个既有测试文件（`input-matrix.client.spec.tsx`、`input-scenarios.client.spec.tsx`、`skeleton.client.spec.tsx`）需要机械性地补上 `addFiles: () => null`，以满足新增的必填字段 `ComposerBarInjected.addFiles`。`input-bar.client.spec.tsx` 里两个粘贴相关的测试固件需要改用真正的 PNG 魔数字节（`Uint8Array.of(1, 2, 3)` 本身可解码为合法 UTF-8，一旦拖放经过内容嗅探就与文本无法区分），并在现已异步化的"粘贴到准入"路径前后加上 `await`/`waitFor`；同一文件里一个使用假计时器的 toast 测试改为直接调用 `onAddImages`，不再走真实粘贴，以便让它的测试对象（toast 淡出与重新提示的时序）与粘贴路径自身的异步嗅探解耦——真实的原生 `File.arrayBuffer()` promise 经由真正的微任务解决，假计时器并不能控制它。`composer-attachments.client.spec.tsx` 的拖放固件同样需要改用 PNG 魔数字节，并在拖放处理器现已异步化的拆分逻辑前后加上 `waitFor`。

`packages/client/ui-attachment/src/*` 不享有覆盖率豁免，实测完全覆盖（限定范围的 `vitest run --coverage` 在移除 `FileChipRow` 内部一处死代码防御性判空 `items.length === 0` 后确认干净——它的持有方 `ComposerAttachments.tsx` 已经条件式地渲染它，与 `AttachmentRail` 自身"不做内部空判断"的模式一致）。`packages/client/ui-conversation/src/client/*`（单星号 glob）享有既有的 GUI 债务覆盖率豁免，但只豁免 `client/` 目录下的直接文件——`skeleton/InputBar.tsx` 与 `contract/slots.ts` 是嵌套文件，仍受完整门控；同一次限定范围覆盖率运行确认两者均干净。`service.ts`/`apply.ts`/`locales.ts`/`attachment-labels.ts`/`file-sniff.ts` 落在豁免范围内；它们仍然配有真实的行为测试（`service-orchestration.client.spec.ts`、`apply-inject.client.spec.tsx`、`file-sniff.client.spec.ts`）校验新增的 `createDraftFiles`/`sendSession` 按 kind 分派/`serializeDraftImages` 按 kind 过滤/`releaseDraftImage` 按 kind 判空/`addFiles` 注入行为，只是不依赖它们来通过覆盖率门。

**退役条件。** 这层 composer 准入是给上游目前还不具备的能力搭的临时覆盖层：一旦上游自己的 composer 接受非图片附件——以本补丁同样的方式泛化其草稿附件形态、拖放/粘贴准入与附件栏/文件条呈现——本补丁即退役，依赖插件适配上游形式。
