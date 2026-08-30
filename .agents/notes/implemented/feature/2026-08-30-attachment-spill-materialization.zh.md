# Agent Note: 超大文本文件附件改走 spill，不再截断

Status: implemented

[English](2026-08-30-attachment-spill-materialization.md) | 中文

## 问题

`@deepseek-ai/dsh-llm` 的 `lowerFileBlockText`（文件附件 wire/日志/请求系列提交 `d56a5f7348` 引入）在文本文件附件的解码内容进入模型请求之前，固定按 `DEFAULT_MAX_LOWERED_FILE_CHARS`（16,000）截断。超过这个界限的文件会永久、静默地丢失截断点之后的全部内容——模型没有任何办法取回被截掉的部分。这与工具输出已有的行为不对称：工具输出早就有会话级 spill 通路（`@deepseek-ai/dsh-spill-policy`），超大结果落盘保留，模型可以按需 `read`/`grep` 而不是丢失内容。附件此前没有对等物：大就截断，且截断是永久且无声的。

## 决策

**落位：仍在既有的逐适配器降级调用点，不在 `agent/request` waterfall。** 这是实测确认而非假设：`'agent/request'`（`packages/core/agent/src/runtime-types.ts:234-244`）是一个路由/配置 waterfall——它的 payload 只有 `{ agent, turn, step, signal }`，完全没有 `messages` 字段，返回值是 `LlmCallConfig`（`packages/llm/llm/src/call-config.ts:23`，供应方/模型/适配器默认值），从不涉及消息内容。它自己的 JSDoc 直接写明了这条约束："Model-visible content must use logged channels; this waterfall cannot mutate messages."（模型可见内容必须走已记录的通道；此 waterfall 不能改写消息。）它的派发点（`packages/core/agent-loop/src/agent.ts:457-460`）同样印证：`proposedConfig` 只喂给 `prepareCall`，从不喂给 `buildRequest`。这里没有任何机制可以改写文件分片文本，因此设计落到规格书写明的兜底路径——沿用原截断逻辑已经在用的那个落位：每个适配器自己的 `lowerFileBlocksFromStore` 调用点，作用于其本地派生的消息副本，发生在 `buildRequest` 之前。这重申了 file-attachment-wire-log-request 那篇 Agent Note 出于同一条请求重建不变式原因已经确立的落位（若把降级集中搬进 `agent-loop`，会让 `options.messages` 与 `session.deriveMessages()` 失步）；spill 并不改变这条约束，因此也不改变落位。

**新增一个包，而不是让 `dsh-llm` 反向依赖 `dsh-spill`。** `dsh-spill` 依赖 `dsh-llm` 取 `CallId`，因此 `dsh-llm` 不能反过来依赖 `dsh-spill`（或依赖 `dsh-agent` 取 `currentInitiator()`），否则成环。`@deepseek-ai/dsh-attachment-spill` 位于这四者（`dsh-agent`、`dsh-attachment`、`dsh-llm`、`dsh-spill`）之上，导出 `AttachmentSpill`（`ctx.attachmentSpill`）与 `fileSpillOptionsFrom`——唯一一处把它转换成 `dsh-llm` 的 `FileSpillOptions` 供适配器使用的转接函数。`dsh-llm/src/file-lowering.ts` 新增 `FileSpillOptions`/`LoweredFileSpillRef`/`lowerSpilledFileBlockText`，并给 `lowerFileBlocksFromStore` 加了第四个可选参数 `spill?`；不传时行为与改动前逐字节一致（始终按阈值截断）。`LoweredFileSpillRef` 是一个结构类型（`{ locator, retrievalHint }`），而非导入 `dsh-spill` 的 `SpillRef`——一个真实的 `SpillRef`天然满足它，`dsh-llm` 无需点名该包。

**幂等性是进程内缓存，不是存储层自带的性质——这一点经实测确认，不是假设。** `saveTextFile`（`packages/spill/spill-local/src/store.ts:107-121`）把内容写到 `join(dir, randomBytes(6).toString('hex') + '-' + safeName)`，以 `'wx'`（排他创建，目标已存在即失败）打开。同一个 `suggestedName` 重复调用，每次都会落到一个全新的随机路径——这一层既没有按名查找，也没有按内容哈希去重（随机前缀的目的是防御共享根目录下的符号链接抢先放置攻击，不是为了幂等）。`lowerFileBlocksFromStore` 每次构建请求都会对完整消息历史跑一遍，一次回合的每个 step 都会跑——如果没有缓存，同一个附件在一次回合的 N 个 step 里被引用，就会调用 N 次 `resolveSpill`，为逻辑上同一个附件物化出 N 份不同的 spill 产物（N 个不同的定位符、N 条不同的 `attachment/materialized` 事件）。`AttachmentSpill.resolveSpill`（`packages/attachment/attachment-spill/src/index.ts`）用一个进程内 `Map<SessionId, Map<AttachmentId, SpillRef>>` 堵住这个口子：同一进程内，某个（会话、附件 id）组合第一次调用 `resolveSpill` 时才会调用 `store.saveText` 并追加 `attachment/materialized`；同一进程、同一组合的后续调用一律返回缓存的 `SpillRef`，不再二次写入、不再二次记日志。会话归属取自 `ctx.agents.currentInitiator().session.id`，现取而非作为参数传入，因此用来做缓存键的 id 与事件实际记到的 id 永远不会不一致。

**模型可见⟺已记录，以及日志回放能重建出什么。** 一个已 spill 文件的降级文本给模型看到的定位符字符串（`lowerSpilledFileBlockText`）是模型可见内容；`attachment/materialized` 事件按仓库不变式让它可以从会话日志重建出来。该事件在 `resolveSpill` 把 `SpillRef` 返回给同一次降级调用去嵌入文本之前就同步追加完毕——因此事件顺序始终与请求顺序一致：回放日志到任意历史轮次，都能找到那次请求实际携带的那个定位符。但这并不承诺定位符跨进程重启保持稳定：缓存只存在于内存中，因此一个在新进程里恢复的会话，缓存未命中时会重新跑一次 `resolveSpill`，`saveTextFile` 会铸出一个全新的随机路径，同一个附件 id 会被追加第二条 `attachment/materialized` 事件、携带不同的定位符。两条事件各自都真实记录了它们各自那次请求里模型实际看到的内容；任何一次请求的降级文本都不会出现日志里没有的定位符。这是一处刻意划定的范围边界，不是疏漏：要让产物本身跨进程边界保持稳定，要么需要 `dsh-spill` 目前不具备的"按 suggestedName 查找"原语（本次改动不做——没有其它 spill 消费方需要它，因为工具输出每次都是重新执行产生的新内容，不会像附件这样对同一份不可变输入反复降级），要么需要按附件 id 做内容寻址，而本地后端"随机名下排他创建"的设计并不提供这个能力。

**走 Config，不是写死的调优参数。** `AttachmentSpill.Config`（`packages/attachment/attachment-spill/src/index.ts`）是一个 schemastery 的 `z.object`，两个字段：`inlineWholeUnderChars`（默认 `DEFAULT_INLINE_WHOLE_UNDER_CHARS`，等于 `dsh-llm` 里退役的 `DEFAULT_MAX_LOWERED_FILE_CHARS`——部署未覆盖前二者是同一个数字）与 `previewChars`（默认 `DEFAULT_PREVIEW_CHARS`，4,000——一个已 spill 文件的文本仍随定位符内联展示多少字符，让模型不必强制多打一次工具调用就能有个方向感）。两个字段都在加载时校验为非负整数——一次是 `z.object` schema（`ctx.plugin` 在构造函数运行前解析 `Config`），另一次是构造函数里手写的 `requireNonNegativeInteger` 检查，用于防御绕过 schema 解析的直接构造，与 `attachment-local` 的 `LocalAttachmentStore` 已有的双重校验同款。`DEFAULT_MAX_LOWERED_FILE_CHARS` 本身从"无条件截断上限"这一旧角色退役，改作 `dsh-attachment-spill` 内联阈值的默认值，以及 `lowerFileBlockText` 在无 spill 选项时的兜底截断上限——没有删除，因为任何省略 `spill` 参数的调用方（无会话的 LLM 调用，或未加载 `dsh-attachment-spill` 的部署）仍然需要一个截断上限。

## 考虑过的替代方案

**在附件准入那一刻就把 spill 决定穿进日志**，让 `FileBlock` 自身在文件保存时就带上 spill 判定，而不是延后到每次降级调用时惰性判定。已否决：一个文件是否需要 spill，取决于其解码长度与一个部署可配置阈值的比较，而这个阈值可能在文件准入和后续降级之间发生变化（例如会话在不同的 `dsh-attachment-spill` 配置下被恢复）；在降级时决定——沿用原截断逻辑已经在用的落位——能让这个判定始终是最新的，也能让日志里只保留持久的附件引用，而不是一个请求时刻的格式化选择。

**通过给 `dsh-spill` 加一个"按 suggestedName 或内容哈希查找"原语来实现跨进程的持久幂等。** 本次改动已否决：这需要为一个没有其它消费方需要的诉求扩展 `dsh-spill` 的公开服务边界（工具输出的 spill 天生每次工具调用都是全新的，不会像附件这样对同一份不可变输入反复降级），而且 `spill-local`"随机名下排他创建"的设计正是刻意用来抵御可预测路径的，按名查找会部分削弱这一点。进程内缓存已经满足眼下的需求（同一进程处理同一会话时不重复 spill），无需重新打开这条服务边界；跨进程的定位符稳定性作为一个已知的、写明的局限保留。

**重申而非重新考虑：把降级集中搬进 `agent-loop`。** file-attachment-wire-log-request 那篇 Agent Note 已经出于请求重建不变式的原因否决过这条路径；spill 没有带来任何新论据去重新考虑它，同一个逐适配器落位本就已经存在，只需要多加一个可选参数。

## 影响

`SessionEventMap` 新增 `'attachment/materialized'`（`packages/attachment/attachment-spill/src/types.ts`：`{ attachmentId: AttachmentId; locator: SpillLocator }`）。`SESSION_FORMAT_VERSION` 保持 `0`——这是可合并扩展事件表里的词汇增长，与文件附件系列自己那次 `ContentBlockMap` 新增同一类别，不是结构性或信封层面的改动。`packages/core/session/src/known-event-types.ts`、`docs/persistence-catalog.md`/`.zh.md`、`docs/config-catalog.md`/`.zh.md`、`docs/capability-seams.md`/`.zh.md`、`docs/subsystems/attachment.md`/`.zh.md`、`scripts/gen-cordis-catalog.ts` 的 `SERVICE_PAGE`、`scripts/gen-doc-graphs.ts` 的 `SERVICE_ROLES` 都随之一并更新，对应生成器均已重新跑过。

`packages/client/ui-conversation/src/client/locales.ts` 的 `image.dropDesc` 文案（中英两处）从断言文本内容"原样发送"改为说明文本文件会作为附件加入、模型按需读取——一旦截断不再是大文件唯一的结局，旧文案就变成了确实的错误说法。`apps/web/tests/image-display.snapshot.ts` 与 `apps/web/tests/file-display.snapshot.ts` 相应更新/扩充；协调方最初指向的 `ui-attachment/src/client/labels.ts` 是不精确的——该文件只把翻译键映射到标签对象，字面文案实际落在 `ui-conversation/src/client/locales.ts`，已通过对客户端各包 `grep -rln "dropDesc"` 确认。

每个被改动的包在其改动源文件上都保持逐文件 100% 覆盖，且用窄口径确认（`dsh-attachment-spill` 全部 `src/**`、`dsh-llm` 单独的 `file-lowering.ts`、`llm-deepseek`/`llm-pi-ai` 两个适配器），均经 `vitest run --coverage --coverage.include=` 窄口径命令验证。`pnpm run typecheck`（`tsconfig.host.json` 与 `tsconfig.client.json` 两个聚合面）与 `pnpm run doc-sync`（28/28 门）均干净。`pnpm run hygiene` 要求把 `@deepseek-ai/dsh-attachment-spill` 声明为 `packages/bundle/base`（经 `cordis.patch.yml` 引用）与 `python/sdk-runtime`（经 `dsh-jsonrpc-agent-pkg → dsh-llm-deepseek`/`dsh-llm-pi-ai` 可达）两处的依赖，均已在本次改动中一并加上。

**没有把"模型对 spill 定位符发起 `grep`/`read` 往返"这一真实模型回合场景加进 keyless 快照套件。** 本仓库的 `test:snapshot` 回放固定的模型响应；要脚本化一个"读回运行时才生成的定位符字符串"的场景，需要 `dsh-llm-replay` 的 `{{fromRequest:<regex>}}` 占位符机制——本次改动只做了调研，没有实现（考虑到这类手写场景属于首次尝试，时间与风险都偏高）。`apps/web/tests/file-display.snapshot.ts` 转而新增了一条客户端往返回归测试，确认一个超阈值文件在 composer/草稿路径上不会被截断——这是该测试层能够断言的内容。真正的"spill 后取回"行为改为对着真实 DeepSeek API 实机验证了一次：从一个全新的 scratch `$DSH_HOME`启动 `dsh web`，附上一个 95,562 字节的 Markdown 文件（最后一段是一句独有的哨兵句），经浏览器 composer 自身也会调用的同一个 `session.prompt` wire 调用发送。会话日志记下了带产物定位符的 `attachment/materialized`，模型对该定位符依次调用了 `bash`/`grep`/`read`（其中一次 `read` 按尾部偏移量精准落在哨兵句所在行），最终回答正确引用了这句话——同时 `user/message` 自己的 `file` 内容分片只携带了持久化的 `FileAttachmentRef`（id/名称/字节数），从未携带那 95KB 文本，印证了日志始终精简、降级文本只能经另行记录的定位符重建。这是一次真实 API 实机运行，不是已提交的 fixture，因此不会在 CI 里跑；用 `dsh-llm-replay` 场景补上这个缺口留给后续改动。

**退役条件。** 本补丁是上游尚不具备该能力时的临时覆盖层：如果上游为超大文件附件添加了等价的"降级时 spill"路径——包括以同一种方式解决本篇与 file-attachment-wire-log-request 那篇共同确立的"请求重建不变式 vs 降级落位"张力——本补丁即退役，fork 改为适配上游形态。
