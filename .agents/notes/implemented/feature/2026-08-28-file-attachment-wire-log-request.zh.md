# Agent Note: 文件附件贯通 wire、会话日志与请求物化

Status: implemented

[English](2026-08-28-file-attachment-wire-log-request.md) | 中文

## 问题

上一个提交给 `@deepseek-ai/dsh-attachment` 加上了文本文件存储服务边界（`saveFile`/`readFile`/`admitEncodedFiles`），但还没有任何调用方。文件依然无法进入会话：prompt RPC 没有对应的内容分片，会话日志没有对应的分片类型，也没有任何模型请求路径知道如何表示它。本提交把服务边界端到端接通——客户端 wire、会话日志、模型请求——面向不原生支持文件分片的纯文本供应方。

## 决策

**Wire 与日志。** `PromptContentPart`（`packages/host/apiproxy/src/api/sessions.ts`）新增 `{ type: 'file'; name: string; text: string }`，`promptContentPartSchema` 相应新增一支 zod 分支。`ContentBlockMap`（`packages/llm/llm/src/types.ts`）新增 `FileBlock { type: 'file'; attachment: FileAttachmentRef }`，与 `ImageBlock` 完全镜像——只携带引用、从不携带内联文本，日志因此保持精简，被引用的字节也能独立校验。`api-proxy.ts` 里的 `durablePromptContent` 用一次 `Promise.all([admitEncodedImages(...), admitEncodedFiles(...)])` 同时准入图片与文件分片，把原本三个图片专属的辅助函数（`imageBlockIn`/`imageInEvent`/`referencedImage`）泛化成通用的 `attachmentBlockIn<TRef>`/`attachmentInEvent<TRef>`/`referencedAttachment<TRef>`，`referencedImage`/`referencedFile` 则作为薄封装保留下来。新增的 `session.file` RPC 镜像 `session.attachment`：给定一个会话与该会话日志曾引用过的附件 id，返回纯 UTF-8 文本（而非 base64——文件不存在需要规范化的二进制传输歧义），供气泡展开时渲染。

**会话分片校验与 `SESSION_FORMAT_VERSION`。** 直接查读 `packages/core/session/src/index.ts` 里的 `assertCurrentLlmShape`/`assertMessageEventShape`，确认二者只校验 `Array.isArray(content)`，没有逐分片类型的检查——未作改动。依据会话日志版本机制笔记，版本号递增只针对*结构性或信封层*的改动；在已经是可合并扩展的 `ContentBlockMap` 里新增一个标签属于该机制本就设计用来吸收、无需递增版本号的词汇增长。`SESSION_FORMAT_VERSION` 保持 `0`。

**请求物化：落在每个适配器里，而不是集中在 agent-loop。** 一个看起来很自然的设计——既然没有任何适配器原生接受文件分片，那就在 `buildRequest` 之前、`agent-loop` 里统一把每个 `FileBlock` 降级为文本一次——对这个代码库是错的，而且是被一次真实的测试失败抓到的，不是靠读代码推断出来的：`packages/core/agent-loop/src/invariant.ts` 安装了一个 `llm/stream` 瀑布监听器，要求每个 loop 构建的请求满足 `JSON.stringify(options.messages) === JSON.stringify(session.deriveMessages())`。在 `buildRequest` 之前就把文件降级，必然使 `options.messages` 与日志自身的重建结果产生分歧，于是第一条携带文件分片的请求分发时就会响亮地失败（`log-reconstruction desync`）。这并非偶然：这正是 `ImageBlock` 的字节从不物化进 `GenerateOptions.messages` 的同一个原因——每个适配器早就把图片字节解析进一份*本地派生的副本*（`llm-deepseek/src/adapter.ts` 里的 `requestMessages`/`requestOptions`，`llm-pi-ai/src/context.ts` 里的 `requestMessages`/`exactMessages`），从不触碰那个受不变式检查的冻结数组。

`packages/llm/llm/src/file-lowering.ts` 新增导出 `contentHasFile`（镜像 `contentHasImage`）与 `lowerFileBlocksFromStore(messages, attachments, signal?)`——两个适配器共用的“读取－解码－格式化”组合（`attachments.readFile` → UTF-8 解码 → `lowerFileBlockText`）。每个适配器都在自己请求构建的最顶端、针对自己本地派生的消息副本调用它一次：
- `llm-deepseek/src/adapter.ts`：`streamWithConnection` 新增一个与 `hasImages` 平行的 `hasFiles` 判定（没有模型能力检查——降级后的形式是纯文本，任何模型都已经接受），解析 `attachments`，不可用时抛出 `UNSUPPORTED_CONTENT`，与既有的图片判定完全一致。`request()` 在构建 `requestOptions` 之前先把 `requestMessages` 降级为 `fileLoweredMessages`，因此 `serializeRequest`/`serializeRequestWithImages` 看到的只有 `'text'` 分片，不需要任何改动。
- `llm-pi-ai/src/context.ts`：`textOnlyContext`（同步、无 attachments 的路径）新增一个与既有 `contentHasImage` 抛出平行的 `contentHasFile` 抛出。`toPiContextWithImages` 在 `assertSupportedImageRoles`/`offloadRequestImagesWithPolicy` 运行之前先把 `options.messages` 降级为 `baseMessages`，函数其余部分不变。`adapter.ts` 只要 `containsImage || containsFile` 就解析 `attachments`，不再只为图片解析。

这次改动逼着做出决定的每一处其他内容分片 switch：`estimateContent`（`packages/llm/token-meter/src/estimate.ts`）按*降级后*的大小（`min(bytes, DEFAULT_MAX_LOWERED_FILE_CHARS)`）给 `'file'` 分片定价，而不是走通用的结构化 JSON 默认值，因为请求时刻的确切文本长度已经可知，不需要任何供应方相关的公式。`blockText`（`packages/session-query/session-query/src/extraction.ts`）只把文件的显示名纳入索引，如同工具调用的名字——完整内容需要一次这个同步遍历做不到的服务边界读取。`compaction-tool-result-pruner` 的 `measureContent` 不需要任何改动：它只统计 `'text'` 分片，因此 `'file'` 分片零开销、原样通过而不会被裁剪，与今天的 `'image'` 分片一样。

`DEFAULT_MAX_LOWERED_FILE_CHARS`（16,000）仍是 `file-lowering.ts` 里的代码级常量，不是任何包新增的 `Config` 字段：目前没有任何部署要求调它，在这个需求出现之前就在三个包（`dsh-llm` 与两个适配器）里穿一个旋钮属于投机——“禁止硬编码可调项”这条规则真正针对的是随部署而变的选择，不是每一个常量。

## 备选方案

**在 `agent-loop` 里、`buildRequest` 之前集中降级。** 先实现、后整体回滚：它产生的 `GenerateOptions.messages` 无法被一次全新的 `session.deriveMessages()` 重建，在第一条携带文件分片的请求上就会击穿 `agent-loop` 自己的请求重建不变式。针对本地派生副本逐适配器降级——与图片早已采用的模式相同——是唯一与该不变式相容的设计。

**让不变式检查与终点之间的某个瀑布监听器，把降级后的 `options` 替换给下游监听器。** 读过 vendor 进来的 `ctx.waterfall` 实现（`vendor/cordis/src/events.ts`）之后放弃：`next` 就是 `() => cb(...args)`，`args` 在派发时就已固定，任何中间监听器都无法重新提供。一个监听器只能包装*返回值*，无法影响链条更下游或终点看到的参数。

**教会每个适配器自己的内容分片 switch（`llm-deepseek/serialize.ts` 里的 `contentParts`、`llm-pi-ai/context.ts` 里的 `userContent`）认识一个 `'file'` 分支。** 不予采纳：这需要把同一套“读取－解码－格式化”逻辑在这些 switch 各处重复一遍，还要把 `AttachmentStore`/`signal` 往下多穿两层。在每个适配器请求构建的最顶端降级一次，能让每一处既有的分片类型 switch 继续对 `text`/`image`/`tool-call`/`tool-result` 保持穷尽——`'file'` 分片根本不会传到它们那里。

## 后果

`packages/host/apiproxy/src/api-proxy.ts` 新增了 `resolveAttachmentSession` 与 `attachmentReadFailure` 两个辅助函数，是在 `attachment`/`file` 两个 RPC 处理器变得近乎一致之后从中抽取出来的，为了让 `jscpd` 保持干净。给抽象类 `AttachmentStore` 新增 `fileLimits`/`validateFile`/`saveFile`/`readFile`（上一提交）以及给 `SessionsApi`/`IApiClient` 新增必需的 `file` 方法（本提交），连带波及了全仓库大约十五处只用于测试的 mock 实现，均为机械改动。

每个被改动的包都持有逐文件 100% 覆盖率（`file-lowering.ts`、两个适配器各自的 `adapter.ts`、`llm-pi-ai/context.ts`、`token-meter/estimate.ts`、`session-query/extraction.ts`、`host/apiproxy/api-proxy.ts`、`host/apiproxy/fetch/{client,handler}.ts`），经限定范围的 `vitest run --coverage` 验证；仓库级两个 `tsc -b` 聚合门面、`oxlint`、`jscpd` 在每一处被改动的路径上均干净。

本系列第一次运行 `pnpm run doc-sync`（上一提交自身的验证没有覆盖它），揭出了上一提交遗留的一处分类缺口：`scripts/gen-cordis-catalog.ts` 的 `LINK_MAP` 从未登记 `FileAttachmentRef`/`SaveFileAttachment`/`StoredFileAttachment`/`EncodedFileAttachment`，导致生成的 Cordis 目录（`docs/subsystems/attachment.md`、`packages/extensions/tool-cordis/src/api-catalog.ts`）无法渲染上一提交早已加上的 `AttachmentStore` 文件方法。本提交补上了这处分类缺口，并把文件附件类型家族记入文档（`docs/subsystems/attachment.md` 新增的“Text file attachments”一节），同时给 `docs/subsystems/llm-streaming.md` 的 `ContentBlockMap` 代码块加上 `'file': FileBlock`——以上均已双语再生成／更新，并针对 `pnpm run doc-sync` 全部 28 个门重新验证通过。

**退役条件。** 本补丁是针对上游尚未具备能力的临时 overlay：若上游为自己的 prompt wire、会话日志与请求物化添加了文件分片支持——包括解决本笔记记录的“请求重建不变式与文件降级”这一张力——即退役该补丁，并让 fork 适配上游形式。
