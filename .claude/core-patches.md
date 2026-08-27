# core-patches 补丁登记

core-patches 分支上的每一个补丁在此登记；新增、修改、退役补丁时必须同步更新本文档。

## fix(scripts): let the workspace gate see apps that never publish — 08f12ee732
- **改了什么**：`scripts/check-workspace-constraints.ts` + 其 `.spec.ts`；给 `apps/*` 引入 private / 发布成员两种类别，新增 `isPrivateApp`、`checkPrivateAppManifest`。
- **为什么**：`apps/desktop`、`apps/desktop-server`、`apps/pwa` 只随客户端构建分发、从不发到 npm，却被 `releaseMemberDirectory` 当成发布成员校验，四条发布元数据规则同时落空；该判定是 gate 脚本里写死的正则，没有插件层或配置层能重新分类。
- **要达到的效果**：`apps/*` 下未发布的产品装配（Electron 壳、部署根、补丁层 bundle）能通过 gate，同时仍受工作区卫生规则约束；判别只靠 `private: true` 一个布尔字段，不需要再维护第二份名单。
- **退役条件**：上游自己的 `check-workspace-constraints.ts` 学会区分 `apps/*` 下未发布的私有产品装配与发布成员（或 fork 不再拥有此类未发布目录）。
- **状态**：在役

## fix(scripts): re-anchor two rescope exact edits to the 0.1.1-rc.1 tree — 9b498d4a3e
- **改了什么**：`scripts/rescope-vendor.ts`；重新锚定两条 exact-edit 记录（`packages/util/home` 删除、中文 vendoring cookbook 链接改指向 `../rescope.zh.md`）。
- **为什么**：上游 0.1.1-rc.1 已经把这两处改成了记录表期望的样子，但记录表里保存的 `replace` 原文对不上新树，导致 `rescope-vendor:check` 把已生效的改动误报成既非待办也非已应用。
- **要达到的效果**：`rescope-vendor:check` 在 `upstream/master` 上正确判定这两条记录为已应用，不再误报。
- **退役条件**：上游自己重新锚定这两条记录（即上游的树形状定型，记录表天然对得上）。
- **状态**：在役

## feat(permission-presets): let a host-configured preset name its selector glyph — 00770bab13
- **改了什么**：`PresetSpec`/`PresetOption` 新增可选 `glyph` 字段（三选一闭合枚举，贯穿 schemastery Config schema 与权限投影的 zod wire schema）；`PermissionSelect.tsx` 按 `permissionGlyph(option.glyph ?? option.value)` 解析每行与 trigger 图标。
- **为什么**：Web composer 的权限选择器按选项 `value` 从写死的图形集里选一枚盾牌图标，只有三个内置 preset id 能解析出图标；一个部署自定义的 preset（例如保留审批提示的 full-access 变体）会渲染成夹在带图标行之间的纯文字行，且被选中时 trigger 也丢图标——玻璃 map 硬编码在客户端里，没有任何插件层能触达这个选择。
- **要达到的效果**：宿主配置的 preset 可以显式声明使用哪一枚设计集图标；未声明的键退回到内置图标已经在用的裸盾牌轮廓，选择器里不再出现无图标的行。
- **退役条件**：上游以任何形式获得等价能力（让 preset 自己命名视觉呈现），即退役该 overlay，依赖插件适配上游形式。
- **状态**：在役

## feat(ui-conversation): open a contribution seat on user messages — 88be8656ab
- **改了什么**：新增会话作用域 list slot `conversation.chat.user-actions`；`ChatView` 声明该位并经 `ChatNodeOwnerProps` 向每个 chat node 传下 `renderUserActions`；`slot-catalog.ts`/`ChatNodeSeat.tsx`/`MessageItem.tsx` 相应改动。
- **为什么**：已定稿 assistant 消息有 `conversation.chat.assistant-actions` 贡献位，用户消息没有对应物——`UserMessageNodeView` 不声明 children 表，插件只能整体遮蔽 keyed `user` 条目才能加一个按钮，逼得想要该能力的插件把操作放到不是该消息的地方（composer dock 或 assistant 行）。
- **要达到的效果**：插件只需注册一个条目即可在用户自己的消息（含已接纳的 steering 气泡）上添加逐消息操作，无需 fork conversation 包；owner currency 携带该消息的日志位置 `seq` 与已渲染文本。
- **退役条件**：上游以任何形式获得等价的用户消息逐消息贡献位，即退役该 overlay，依赖插件适配上游形式。
- **状态**：在役

## feat(ui-primitives): export the ANSI line parser — 9097705ed1
- **改了什么**：`packages/client/ui-primitives/src/index.ts` 新增导出 `parseAnsiLines` + `AnsiLine`（原为 `ansi.ts` 内部私有）；README 双语补充说明。
- **为什么**：fork 内部一个插件要给终端输出加可点击指代，需要与 `TerminalBlock` 完全一致的方式对 ANSI 分词；解析器此前对包外不可见，另写一份实现会在任一份改动时与之走偏。
- **要达到的效果**：消费方可以 `import { parseAnsiLines, type AnsiLine } from '@deepseek-ai/dsh-client-ui-primitives'`，得到与 `TerminalBlock` 一致的分词结果，无需 fork `ansi.ts`；`TerminalBlock` 自身渲染零改动。
- **退役条件**：上游自行导出该解析器，或提供终端输出渲染 hook，使得包外重新解析 ANSI 不再必要。
- **状态**：在役

## fix(host-apiproxy): a distinguishable not-found error from the path opener — a5c4d3a29d
- **改了什么**：`openTarget`（`host.openPath` 与设置文档编辑器移交共用的实现）在调用原生 opener 前先 `stat` 已解析路径；`RpcErrorDetailsMap`/`rpcErrorSchema` 新增 `not-found` 错误码；`WorkspaceRuntime.openPath` 改为抛出携带 `rpcError` 字段的 `PathOpenError`（消息文本保持不变，纯增量扩展）。
- **为什么**：`openTarget` 此前把路径不存在、无注册应用、权限被拒等一切失败都折叠成一个 `internal` 错误加自由文本消息，调用方无法在不解析消息文本的前提下区分出"路径不存在"。
- **要达到的效果**：调用方可以据 `rpcError.code === 'not-found'` 分支处理（例如提示重新选择文件，而不是展示一条原生平台错误）；对已知不存在的路径不再起一次必败的原生子进程；既有的 Host 拒绝弹窗文案字节不变。
- **退役条件**：上游自行区分出"路径不存在"这一 opener 失败。
- **状态**：在役

## fix(ui-primitives): stop silently discarding a disallowed link destination — 5ea5351dae
- **改了什么**：`markdown/render.tsx` 的 `renderSafeLink`：不被允许的目的地不再渲染成裸 `Fragment`（吞掉目的地），改为渲染成 `链接文字 (目的地)` 这样可见、不可交互的文本；两个 `links-and-autolinks` DOM fixture 与 `markdown.client.spec.tsx` 的相关断言随之更新。
- **为什么**：一个未通过协议白名单的链接目的地（相对路径、绝对本地路径、`file:` URL 等）此前被静默丢弃，读者完全看不出这里曾经存在过一处链接，更看不到它指向哪里。
- **要达到的效果**：读者始终能看到一处链接曾被作者写下、以及它指向哪里，即便该目的地无法成为可点击链接；协议白名单本身不变，只是不允许分支的呈现方式变了。
- **退役条件**：上游自己的 markdown renderer 不再悄悄丢弃不被允许的链接目的地。
- **状态**：在役

## feat(attachment): a text-file kind for the durable attachment seam — c443235721
- **改了什么**：`packages/attachment` 新增与图片平行的 `FileAttachmentLimits`/`FileAttachmentRef`/`SaveFileAttachment`/`StoredFileAttachment`/`EncodedFileAttachment` 类型族，以及 `AttachmentStore.validateFile`/`saveFile`/`saveFiles`/`readFile`、`admitEncodedFiles`；`attachment-local` 新增 `sniff.ts`（移植自退役插件 `dsh-text-drop` 的 `core/sniff.ts`）、`text.ts`（`detectText`），并抽出 `commitDurableObject`/`readVerifiedObject` 供图片与文件共用。
- **为什么**：标准 harness 没有非图片附件通路，第三方 `dsh-text-drop` 插件把文件当原始文本拼接进草稿，绕过图片已有的持久、内容寻址服务边界，会话日志里的拼接文本没有引用可供重新获取、校验或去重。
- **要达到的效果**：文本文件像图片一样经服务边界准入、按 SHA-256 内容寻址持久化、可按引用重新读取校验；`maxFileBytes`/`maxFilesPerMessage`/`maxMessageFileBytes` 三项限额可按部署配置。本提交尚无调用方接入该服务边界，属于系列提交的第一步，本身不改变任何可观察行为。
- **退役条件**：上游为 `@deepseek-ai/dsh-attachment` 添加了镜像图片的文本文件准入与存储服务边界。
- **状态**：在役

## feat(llm,host-apiproxy): file attachments on the wire, in the log, and at request time — d56a5f7348
- **改了什么**：prompt RPC 新增 `{type:'file', name, text}` 内容分片；`api-proxy.ts` 经既有附件服务边界准入并记入日志为 `{type:'file', attachment: FileAttachmentRef}`；新增 `session.file` RPC 镜像 `session.attachment`。`dsh-llm` 新增 `file-lowering.ts`（`contentHasFile`/`lowerFileBlockText`/`lowerFileBlocks`/`lowerFileBlocksFromStore`）；`llm-deepseek`/`llm-pi-ai` 两个适配器各自在自己请求构建的最顶端、针对本地派生的消息副本调用一次降级，从不触碰 `agent-loop` 请求重建不变式校验的那个冻结 `GenerateOptions.messages`。`token-meter`/`session-query`/`compaction-tool-result-pruner` 的内容分片 switch 各自做出决定；一并补上 `scripts/gen-cordis-catalog.ts` 的 `LINK_MAP` 分类缺口（上一提交遗留），令 `docs/subsystems/attachment.md` 与 `docs/subsystems/llm-streaming.md` 通过完整的 `pnpm run doc-sync`。
- **为什么**：上一提交只搭好了服务边界，还没有任何调用方；文件依然无法进入会话，也没有任何模型请求路径知道如何表示它。最初尝试的“在 `agent-loop` 里、`buildRequest` 之前集中降级”被一次真实的测试失败推翻——它会让 `options.messages` 与 `session.deriveMessages()` 的重建结果产生分歧，击穿 `agent-loop` 自己的请求重建不变式，这与 `ImageBlock` 字节从不物化进该冻结数组是同一个原因。
- **要达到的效果**：文本文件贯通 wire、会话日志与请求物化；`SESSION_FORMAT_VERSION` 保持 `0`（`ContentBlockMap` 内的词汇增长，非结构性改动）；两个适配器都能把文件分片降级为语言标签围栏文本，不原生支持文件的现实对模型透明；`pnpm run doc-sync` 全部 28 门与仓库级两个 `tsc -b` 聚合门面、`oxlint`、`jscpd` 均干净，每个被改动文件逐文件 100% 覆盖率。
- **退役条件**：上游为自己的 prompt wire、会话日志与请求物化添加了文件分片支持，包括解决“请求重建不变式与文件降级”这一张力。
- **状态**：在役

## feat(ui-conversation,ui-attachment): text files as composer draft attachments — 98020a23cd
- **改了什么**：`ComposerAttachment` 改为判别式联合 `ComposerImageAttachment | ComposerFileAttachment`（文件变体没有 `previewUrl`）；`InputState.imageIds`/`addImages`/`removeImage` 三个既有动词原样复用给文件草稿。新增 `file-sniff.ts`（`sniffIsText`/`partitionDroppedFiles`，从 `attachment-local/src/sniff.ts` 的判定逻辑独立重写，非导入——该包依赖 `sharp` 等仅限 Node 的依赖）；`ComposerAttachments.tsx` 的拖放处理器与 `InputBar.tsx` 的粘贴处理器各自拆分自己拿到的原始批次，分别路由到 `onAddImages`/`onAddFiles`。新增 `ui-attachment` 的 `FileChip.tsx`（`FileChipRow`，name+size 条形卡片，与固定 64px 的 `AttachmentRail` 并列）；`image-labels.ts` 改名 `attachment-labels.ts`（`imageSizeText` 改名 `attachmentSizeText`），`attachmentErrorText` 新增 `fileLimits` 参数覆盖 `TOO_MANY_FILES`/`FILE_TOO_LARGE`/`FILES_TOO_LARGE`/`NOT_TEXT_FILE`/`INVALID_FILE_NAME`。`locales.ts` 更新拖放遮罩文案（标题提及文件、描述追加密码/密钥隐私提醒）并新增全套 `file.*` 键；`ConversationController.serializeDraftImages`（斜杠命令图片提交路径）按 kind 过滤，静默排除文件草稿。`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 随生成器重新生成。
- **为什么**：上一提交打通了 wire/日志/请求物化缝隙，但浏览器 composer 侧完全接不上——拖入或粘贴一个文本文件此前要么被图片专属的格式检查拒收，要么经独立退役中的 `dsh-text-drop` 插件绕过服务边界直接拼进草稿；一批混合图片与文本文件的拖放此前会因图片路径的格式检查而整批拒收。
- **要达到的效果**：文本文件在 composer 侧与图片享有同等的草稿态、拖放/粘贴准入与呈现；混合批次按内容正确拆分路由，不再整批拒收；斜杠命令提交显式不接文件（静默排除，非本系列范围）；`ui-attachment/src/*` 无覆盖率豁免下逐文件 100% 覆盖，`ui-conversation/src/client/skeleton/*` 与 `contract/*`（不在既有单星号豁免 glob 内）同样逐文件 100%；仓库级两个 `tsc -b` 聚合门面、`oxlint`、`jscpd`、`pnpm run doc-sync` 全部 28 门均干净。
- **退役条件**：上游自己的 composer 以任何形式泛化为接受非图片附件（草稿附件形态、拖放/粘贴准入、附件栏/文件条呈现），即退役该覆盖层，依赖插件适配上游形式。
- **状态**：在役

## feat(ui-conversation,client-runtime): file-part bubble card and the referent/open seam — fabc93555c
- **改了什么**：新增 `packages/client/runtime/src/client/referent.ts`——一个 ROOT 作用域 cordis waterfall 事件 `referent/open`（经声明合并接入 `Events`），`dispatchReferentOpen(ctx, ref, onDefault)` 负责派发，`ReferentRef.kind` 经 `ReferentKindMap` 可合并扩展。`apply.ts` 的 `openFile` 闭包改为先派发该缝隙再回落到既有的 `workspaces.openPath`。新增 `FileCard.tsx`，被 `MessageItem.tsx`（用户气泡）与 `AssistantMarkdown.tsx`（Assistant block）直接内联渲染 `{kind:'file'}` 分片；点击同样先派发 `referent/open`，落空后切换内联展开/收起，经新增的 `loadFile`／`ISession.readFile`（对偶于既有 `loadImage`／`readAttachment`）惰性抓取文本。`Session.prompt()` 对送到可续接子智能体的文件分片新增 `SUBAGENT_FILE_UNSUPPORTED` 拒收，对偶于既有的 `SUBAGENT_IMAGE_UNSUPPORTED`（此前该分片被静默丢弃）。`scripts/gen-cordis-catalog.ts` 的 `EVENT_WALK_EXEMPTIONS` 补上 `referent/open`（客户端专属事件，对偶于同包既有的 `connection/reset` 记录）。
- **为什么**：此前几个提交把文件送上了 wire、日志与请求物化，也接进了 composer 草稿，但已发送的文件分片在消息气泡里完全不渲染，也没有任何缝隙能让插件拦截对一个文件/目录引用的点击——`openFile` 此前直接请 Host 打开路径，没有中间层。
- **要达到的效果**：`referent/open` 让产物文件条、Tool 行、消息内提及与新的文件卡片点击在一处缝隙上统一变得可拦截，零监听者时行为字节不变（原样重跑既有 `apply-inject.client.spec.tsx` 11/11 通过证实）；文件分片现在与图片分片一样，在消息流里可见、可展开读取原文；子智能体续接对图片与文件两类附件的拒收方式完全对称。`packages/client/runtime`／`ui-conversation/src/client/**`／`ui-trajectory/src/client/**` 在当前 vitest 配置下经实测确认整棵子树豁免于逐文件 100% 覆盖率门（细节见本提交 Agent Note），`packages/test-support/client-runtime/src/sessions.ts` 不豁免、已补齐覆盖；仓库级两个 `tsc -b` 聚合门面、`oxlint`、`jscpd`、`pnpm run doc-sync` 全部 28 门均干净。
- **退役条件**：上游自己的会话 UI 原生渲染文件内容分片、并暴露出等价的打开/引用拦截缝隙，即退役该覆盖层，依赖插件适配上游形式。
- **状态**：在役
