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

## fix(ui-attachment,web): repair a build-purity gap and stale assembled-snapshot copy — 59657e0132
- **改了什么**：`packages/client/ui-attachment/package.json` 的 `dsh.client` 补上 `"external": ["@deepseek-ai/dsh-client-ui-conversation/client"]`（本仓库第一条真正用到 `dsh.client.external` 的声明）。`apps/web/tests/image-display.snapshot.ts` 两处断言改为匹配已发布的拖放遮罩文案，"不支持的粘贴"固件改用一段 NUL 开头的二进制而非可嗅探文本。新增 `apps/web/tests/file-display.snapshot.ts`。
- **为什么**：给 `referent/open` 那次提交补已装配快照证据时，跑一次完整 `pnpm run build` 直接失败——`ComposerAttachments.tsx` 从 `ui-conversation/client` 值导入两个函数，却没有在 `dsh.client.external` 里声明，tsdown 打包纯净度门拒绝了这次导入；这个缺陷自 composer 文件准入那次提交起就存在，只是此前从未跑过完整构建才没被发现。修完构建后跑已有的 `image-display.snapshot.ts`，又暴露出同一次提交遗留的两处过期断言：遮罩文案断言还停在改文案之前，"不支持的粘贴"固件用的单字节文本此前会走图片拒绝提示，现在则会被新内容嗅探正确路由进文件通道，断言名不副实。
- **要达到的效果**：`pnpm run build`（`tsc -b` 与 tsdown client 打包）与 `apps/web/tests/*.snapshot.ts` 全部干净（唯一例外 `built-boot.snapshot.ts` 的官方品牌断言需要带 `--profile` 构建，与文件附件无关，已用未带品牌的普通构建单独复现同一失败排除关联）；新增的已装配快照证实 fixture 会话日志携带引用而非内联原文，`FileCard` 默认动作能经 `session.file` 正确解出原文。
- **退役条件**：与被修复的那次提交（file-part bubble card and the referent/open seam）相同：上游自己的会话 UI 泛化出等价能力即退役。
- **状态**：在役

## feat(ui-conversation,ui-primitives): a proseReferents seam for chat prose — ae19472402
- **改了什么**：`ui-primitives` 的 `MarkdownRenderContext` 新增可选 `referents` 字段——一对不透明的 `scan(text, inlineCode)`/`open(span)`，`MarkdownProseSpan` 只携带 `start`/`end`，渲染器从不读 `kind`/`target`/`raw`。`text` 节点（此前原样返回字符串）与 `inlineCode` 节点（`fileMentions` 放弃认领之后）都接入扫描，命中包成与既有文件提及同款的常显 `css.fileMention` 按钮；`inLink` 内、以及流式 context（`StreamingRenderer` 的两处冻结/尾部 context）都保持关闭，与 `fileMentions` 现有闸门同构。`ui-conversation` 的 `contract/slots.ts` 新增完整 `ProseReferentSpan`（含 `kind`/`target`/`raw`）与可选服务 `ProseReferents`（`ctx.get('proseReferents')`），沿 `ChatFileMentions` 惯例。`apply.ts` 新增 `buildProseReferents`：`scan` 现读会话 `cwd` 与经 `ctx.get('connection') as ConnectionHandle`（本包无环境态 `ctx.connection` 合并）取得的 Host `home`；`open` 自建 `ReferentRef`（`source: 'chat-prose'`，`provenance: 'model-text'`）经 `dispatchReferentOpen` 派发，默认动作与 `openFile` 收口点一致（`url` → `window.open`，`file`/`dir` → `workspaces.openPath`）。`referents` 沿 `fileMentions` 已有的整条穿线路径（`ChatViewInjected` → `ChatView` → `ChatNodeOwnerProps` → 各 chat node 渲染器 → `AssistantMarkdown` → `MarkdownText`）下传，但是按会话取值的普通值而非按 turn-owner 取值的函数，对每条 Assistant 消息一视同仁。`slot-catalog.ts` 经 `gen-client-catalog --write` 重新生成；`scripts/gen-cordis-catalog.ts` 的 `SERVICE_WALK_EXEMPTIONS` 补上 `proseReferents`（与既有 `chatFileMentions` 并列）。
- **为什么**：`chatFileMentions` 只覆盖收尾轮次行内代码里的已知文件词元；正文里的绝对路径、`~/…`、裸 URL、UNC 共享等一切非代码引用毫无拦截点，即便同一条 `referent/open` 缝隙已经为文件卡片与 `openFile` 存在、目的完全一致。core 只应开一条通用缝（零检测逻辑），检测矩阵与拒开名单归插件层所有。
- **要达到的效果**：缺席服务时 `MarkdownText` 的正文与行内代码渲染与本缝隙不存在时逐字节一致（既有测试全部原样通过 + 新增显式断言证实）；`render.tsx`/`MarkdownText.tsx` 新增分支语句/分支/函数/行 100% 覆盖；provenance 载荷（`chat-prose`/`model-text`）与 `openFile` 的 `structured` 明确区分，不二次派发。
- **退役条件**：上游自己的会话 UI 对 Assistant 正文（不止行内代码、不止对着产出文件词表）做可点引用扫描、并暴露出等价的 scan/open 契约，即退役该覆盖层，依赖插件适配上游形式。
- **状态**：在役

## feat(host-apiproxy,client-runtime): a batch path-existence probe for the referent verification layer
- **改了什么**：`HostApi` 新增 `probeTargets(paths: string[]) → { results: ProbeResult[] }`（`packages/host/apiproxy/src/api/host.ts`），零能力闸（不像 `listDirectory`/`pickDirectory` 挂在 `browse`/`native` 之后）、请求 schema 用 `z.array(...).min(1).max(64)` 把批量上限做成 `bad-request`（`host.schema.ts`）。`api-proxy.ts` 的实现只读 `stat`（ENOENT 与任何其它 stat 失败一律折成 `exists:false`，探针只回答"能不能点"不诊断原因），配一个 8 并发的定长 worker 池（`probeTargetsBatch`），不做目录列举、不读内容。`probeOneTarget` 对任何 `\\` 前缀目标短路成 `exists:false`，从不调用 `stat`——这道判定在 `stat` 调用之前、无条件生效，不信任任何调用方已经把 UNC 目标过滤掉。`rpc-map.ts`/`fetch/handler.ts`/`fetch/client.ts`（`IApiClient.host`、`UNARY_VALUE_SCHEMAS`、`AbstractApiClient.host`）三处按 `listDirectory` 同款模式各加一行。类型经 `api/index.ts` → `client/connection`(`api.ts`+`index.ts`) → `api/remotes` 三层具名重导出表送达浏览器；`WorkspaceRuntime.probeTargets`/`IWorkspaces.probeTargets` 是 `ctx.workspaces` 上的新方法，`TestWorkspaces`（`test-support/client-runtime`）与两份 `IApiClient` 测试替身（`client/connection`、`client/runtime` 各自的 `fake-api.client.ts`）、`FixtureApiClient`（`client/connection/fixture.ts`，复用既有 in-memory 目录树）、以及两个既有 host 契约单测（`client-handler.spec.ts`/`fetch-carrier.spec.ts`）同步补上这个方法，否则编译期就会因为 `HostApi`/`IApiClient`/`IWorkspaces` 缺一员而炸；`api-proxy-workspace.spec.ts` 新增 `host.probeTargets` 一节，对着真实临时目录跑，`vi.mock('node:fs/promises', …)` 用 `vi.fn(actual.stat)` 包一层真身实现的 spy，证明 UNC 目标的 `exists:false` 从不经过 `stat` 调用、相邻真实路径不受影响。
- **为什么**：三层可点引用架构（提名→验证→打开）的验证层需要一个只读、批量、探针式的路径存在性 RPC，先侦察后动手——`packages/api`、`packages/fs`、`packages/client/*`、`packages/host/*` 找过一圈，唯一路径相关的 client↔host RPC 是 `host.listDirectory`：它做整目录列举（违反验证探针"不读内容不列目录"的约束）、挂在 `browse` 能力闸后（多数桌面安装走 `native`，完全没有这条 RPC 可用）、对非目录目标直接 400。没有比这更轻的既有 stat/exists RPC。UNC 短路是这条 RPC 自身必须守住的不变式，不能只靠调用方（clickable-refs 插件）的验证层过滤：Windows 上对 UNC 路径 `stat` 就是发起一次 SMB 连接，可能把当前用户的 NTLM 凭据泄露给路径命名的任意主机——而这条探针本就设计成对模型可见文本（可被抓取内容污染）零手势触发，client 侧的过滤是防御纵深的一层，不是唯一一层；这是 wire 边界，字面按仓库规则必须自己校验，不能信任调用方已经预过滤。
- **要达到的效果**：`ctx.workspaces.probeTargets(paths)` 对 1–64 个绝对路径给出与请求同序的 `{path, exists, kind?}[]`；调用方（clickable-refs 插件的验证存储）按 ≤64 自行分片调度，本方法内部只再做 8 并发限流，不额外校验调用节奏。零能力闸，任何部署都能用。一个 `\\` 前缀路径始终得到 `{exists:false}`，且这一路径从不触发 `stat`——无论调用方是否已经过滤，服务端自身对 UNC 目标零 SMB 连接、零凭据暴露面。
- **退役条件**：上游自己提供等价的只读批量路径探针（stat-only、无目录列举、client 可达）。
- **状态**：在役

## feat(ui-conversation,ui-primitives): resolveLink/subscribe on the proseReferents contract
- **改了什么**：三层可点引用架构（提名→验证→打开）的 A1——在役 `ProseReferents`（`ui-conversation/src/client/contract/slots.ts`）与其渲染侧镜像 `MarkdownProseReferents`（`ui-primitives/src/markdown/render.tsx`）各新增两个可选成员：`resolveLink?(destination, displayText, ctx?) → span | undefined`（提名一个非 web-scheme 的 markdown 链接目标，返回已验证 span 或 undefined）、`subscribe?(listener) → unsubscribe`（验证批次完成后的 tick 通知）；`scan` 的 JSDoc 改写为显式声明"只返回已验证 span"的契约（蓝=必开由此结构性成立）。`apply.ts` 的 `buildProseReferents` 对称按 `provider.resolveLink`/`provider.subscribe` 是否存在决定render 侧对应字段是否出现（`exactOptionalPropertyTypes` 下用条件展开而非赋值 `undefined`）——`resolveLink` 转发时重新读一次会话 cwd/Host home（与 `scan` 同一惰性读技术），`subscribe` 直通不做任何包装。本提交只开缝：`render.tsx` 尚未调用 `resolveLink`，`MarkdownText.tsx` 尚未订阅 `subscribe`（下两个提交分别接上）。
- **为什么**：v2 的 `ProseReferents.scan` 只覆盖语法提名，v3 架构要求提名与验证分层——`resolveLink` 是"提名一个 markdown 链接目标交给验证层"的挂钩，`subscribe` 是"验证批次异步完成后通知渲染层重渲"的挂钩；两者都得先在契约里落地，渲染逻辑才有地方接。
- **要达到的效果**：两个新成员均可选，未声明的 provider（沿用旧版 `{ scan, open }` 两件套）在类型和运行时都保持原样——`buildProseReferents` 对着一个没有 `resolveLink`/`subscribe` 的旧 provider 时，`referents.resolveLink`/`referents.subscribe` 均为 `undefined`（新增单测覆盖：转发到 provider、透传返回的 unsubscribe、provider 未声明时两个字段都缺席）。
- **退役条件**：与既有 `proseReferents` 缝隙相同——上游自己的会话 UI 长出等价的提名/验证分层可点引用能力，即退役整条覆盖层。
- **状态**：在役

## feat(ui-primitives): route a local-path markdown link destination through resolveLink
- **改了什么**：三层可点引用架构 A2——`render.tsx` 的 `case 'link'`：目的地先 `decodeURIComponent`（尽力解码，失败保留原文，新增 `decodeLinkDestination`），呈本地路径形（`isLocalPathDestination`：前缀 `/`、`~`/`~/`、盘符 `X:\`或`X:/`、UNC `\\`）且非 http(s)/mailto（`isAllowedScheme`）时，交 `context.referents?.resolveLink`（新增 `renderLocalLinkDestination`：verified span → 与 `scan` 命中同款 `css.fileMention` 按钮，`displayText` 用新增的 `linkPlainText` 把链接子树拍平成纯文本；unverified → 普通 `<code title={destination}>` ，不再落回旧版的 `text (destination)` 尾缀文本）；无 provider 或 provider 未声明 `resolveLink` 时原样落回既有协议白名单分支，字节不变。
- **为什么**：v3 架构把"模型写 markdown 链接"列为提名主力（B1 的系统提示词就是让模型这样写），但 v2 的 render.tsx 对非 http/https/mailto 的链接目的地只有一条路——协议白名单拒绝，渲染成 `text (destination)`——完整绝对路径直接以尾缀文本形式污染正文，且从不给验证层任何介入点。
- **要达到的效果**：三分支单测覆盖齐全——verified→可点、unverified→纯文本代码样式+title、无 provider/无 resolveLink→现状不变；`%20` 解码与解码失败保留原文单独覆盖；`http(s)`/`mailto` 目的地即便 provider 在场也维持现状；Windows 盘符路径同走这条缝（UNC 路径因 CommonMark 反斜杠转义在真实解析下无法保留两个前导反斜杠，改在 `markdown-render-units` 用手搭 mdast 树验证同一分支）。空格路径的两种转义写法——`<…>` 尖括号包裹与 `%20` 百分号编码——各补了一条真实解析（非手搭 mdast 树，`fromMarkdown` 走真实 CommonMark 语法）端到端用例，证实两种写法到达 `resolveLink` 前都已正确剥离尖括号/解码百分号、只留字面空格；线上真实模型回合也已实测确认模型会自发选用 `%20` 写法（clickable-refs 0.3.2 的 B1 提示词改动）。
- **退役条件**：同一条 `proseReferents` 缝隙退役时一并退役。
- **状态**：在役

## fix(ui-primitives): re-render a settled message on a referents verification tick
- **改了什么**：三层可点引用架构 A3——`MarkdownText.tsx` 新增 `useReferentsRevision(referents)`：`useEffect` 订阅 `referents?.subscribe`（未声明则空操作，`revision` 恒为 0），每次 tick 递增一个 `useState` 计数器并在组件卸载/`referents` 换身份时退订；`revision` 并入 `MarkdownText` 的 `useMemo` 依赖数组（与既有的 `text`/`streaming`/`codeLabels`/`fileMentions`/`referents` 并列），本身在 memo 回调体内不被读取，纯粹用来让 `renderSettled`/`StreamingRenderer.render` 在验证批次完成后重新执行、重新调用 `scan`/`resolveLink`。
- **为什么**：`ProseReferents.scan`/`resolveLink` 允许异步验证（结果先缓存在 provider 自己的存储里，`scan` 本身仍保持同步只读缓存）——落定那一刻的首次渲染很可能赶在 host `stat` 批次完成之前，此时 `scan` 返回空理所当然；但在这条 patch 之前，`subscribe` 这个缝隙根本不存在，验证批次之后完成的通知无处可接，已缓存的 `useMemo` 结果永远不会因为"验证完成了"这件事重新计算——读者只有刷新整个页面（组件重新挂载、`scan` 拿着当时已经验证好的缓存重新跑一遍）才能看到标记变蓝，这正是现场证实的那个 bug。
- **要达到的效果**：落定瞬间该来的验证结果照常显示（不依赖这条 patch，本就走 `streaming` 翻转触发的既有重渲）；验证批次异步完成后的 tick 无需刷新页面即可让已落定消息的新增验证结果显形（新增单测：手动触发 tick 后 `PROSEHIT` 从不可点变按钮，组件全程未重新挂载）；`referents` 换身份（provider 组合切换）正确退订旧监听、订阅新监听（新增单测覆盖）；无 `subscribe` 时 `revision` 恒定、行为与本 patch 之前逐字节一致。
- **退役条件**：同一条 `proseReferents` 缝隙退役时一并退役。
- **状态**：在役

## feat(client-runtime): broadcast the connection's coarse state as a typed client event
- **改了什么**：`packages/client/runtime/src/client/index.ts` 的连接接线里，`onStateChange` 处理器新增 `ctx.emit('connection/state', state)`（`sessions.handleDisconnected()` 的既有调用与时机不变）；`declare module '@deepseek-ai/cordis'` 的 `Events` 合并在 `connection/reset` 旁新增 `'connection/state'(state: ConnectionState): void`，JSDoc 按 `@mode`/`@param` 同款写法。`ConnectionState` 经 `packages/api/remotes/src/client/index.ts` 补一行具名重导出（`ConnectionHandle, ConnectionSinks, ConnectionState, ContentBlock` 字母序插入）送达 runtime 包。`scripts/gen-cordis-catalog.ts` 的 `EVENT_WALK_EXEMPTIONS`、`scripts/gen-cordis-inspect-catalog.ts` 的 `CLIENT_EVENTS` 各追加一条与 `connection/reset` 同款的豁免/白名单项；重跑两个生成器后 `packages/extensions/cordis-client-runner/src/client/api-catalog.ts` 落地新事件与 `ConnectionState` 类型条目，`gen-doc-graphs`/`verify-cordis-catalog` 复跑确认无漂移。`wire-events.client.spec.ts` 新增两条单测：一条断言连续三次假状态迁移按序广播，一条断言无人监听时状态迁移不抛异常且不泄漏进 `remote.$dispatch` 通道。
- **为什么**：断线重连横幅这类客户端 UI 需要感知连接的粗粒度状态迁移（`'connected'`/`'reconnecting'`），但 `ConnectionController.onStateChange` 此前只驱动 `sessions.handleDisconnected()` 这一个内部消费者——状态迁移本身从未作为具名 cordis 事件对外广播，插件层（例如断线横幅）无法订阅，只能自行探测连接对象。
- **要达到的效果**：每次连接生成的粗粒度状态迁移（`ConnectionController` 已做的去重——同状态不重复触发）都通过 `ctx.emit('connection/state', state)` 广播给任何监听者；没有监听者时行为与改动前逐字节一致（`handleDisconnected()` 的调用时机、参数、`remote.$dispatch` 通道均不受影响）。
- **退役条件**：上游自己发出等价的客户端连接状态事件。
- **状态**：在役

## fix(ui-conversation): degrade a prose referent's not-found race to the composer's own notice
- **改了什么**：三层可点引用架构 A3 的补漏——`apply.ts` 的 `buildProseReferents` 新增两个参数 `notifyNotFound`/`notFoundText`；`open` 闭包对 `dispatchReferentOpen` 的 `.catch` 分支新增 `error instanceof PathOpenError && error.rpcError.code === 'not-found'` 判支，命中时调用 `notifyNotFound(sessionId, notFoundText)`，未命中（其余任何失败）维持原样只落 `console.error`。调用点 `referents: buildProseReferents(...)` 把 `notifyNotFound` 绑定为 `(id, text) => inputHub.shell(id).notify('error', text)`——复用 `InputHub`/`SessionInputShell` 已有的会话级 composer 通知通道（`InputBar.tsx` 既有的 `Toast` 渲染，`hub.ts` 的 `queue.steerFailed` 同款用法），`notFoundText` 由调用点解析一次 `t('referent.notFound')`。`locales.ts` 的 `queue.*` 组之后新增 `referent.notFound` 键（中/英各一条）。
- **为什么**：一次由所有者发起的验证层审查（三层架构的 §C 场景③）指出 `VerificationStore.check()` 把索引命中直接判定为 verified，索引命中的路径可能早已从磁盘删除——插件层（`dsh-plugins` clickable-refs 0.3.3）已改为 stat 唯一验证，但 stat 到点击之间仍存在窗口：一个曾经 stat 确认存在的 span，点击瞬间该文件已被删除。终端卡（`ClickableSpan.tsx`）对这条赛跑早已有降级——`ClickOutcome` 的 `not-found` 分支渲染一条会自动淡出的内联提示、并把该 span 永久降级为死文本——但正文（`buildProseReferents.open`）从未走 `openReferentTarget`/`ClickOutcome`（那是插件自己的终端/web 收口点），它自建的 `onDefault` 直接调用 `ctx.workspaces.openPath`，失败只落 `console.error`，用户侧零反馈，静默失败。`fileMention` 按钮（`ui-primitives` 的 `render.tsx`）是 `scan`/`resolveLink` 输出的纯渲染，没有自己的点击态，装不进终端卡那套内联提示状态机，改为复用会话级 composer 通知通道是现有的、已装配好的最小改动路径。
- **要达到的效果**：`not-found` 从静默失败变成用户可见的会话级错误提示（同一条 `InputBar` 已有的 `Toast` 通道，与 `queue.steerFailed` 同一机制、同一渲染路径）；除 `not-found` 外的任何其他打开失败维持改动前行为，只落 `console.error`，没有新增 UI（新增单测覆盖两条分支：`not-found` 触发 `notices` 快照变为 `{level:'error', text: '该文件已不存在，可能已被移动或删除。'}`，任意其他 `Error` 只触发 `console.error` 且 `notices` 保持 `null`）；`apply-inject.client.spec.tsx` 既有 20 条用例逐字节不受影响。
- **退役条件**：同一条 `proseReferents` 缝隙退役时一并退役；若上游自己的 `fileMention` 渲染获得独立的每-span 点击态（能装下与终端卡同款的内联降级），这条补丁可以退役换成那套更贴近终端卡的展示。
- **状态**：在役

## feat(ui-conversation,ui-attachment,host-apiproxy): confirm before sending a file that lives in a known secret container — ebd4e9c1f4
- **改了什么**：新增纯函数 `matchSecretContainerFiles`（`ui-conversation/src/client/secret-container.ts`）：硬编码基础名单（`.env`/`.env.*`、`id_rsa`/`id_ed25519`/`id_ecdsa` 排除 `.pub`、`*.pem`/`*.key`/`*.keychain`/`*.p12`/`*.pfx`、`credentials*`/`secrets.*`、`.netrc`/`.npmrc`/`.pypirc`）+ 路径段（`/.ssh/`/`/.aws/`/`/.gnupg/`/`/.kube/`/`/.docker/`，仅当调用方提供路径时生效，即桌面 `File.path` 存在、web 无此字段）+ 部署追加的文件名子串（仅可新增匹配，无法移除或覆盖基础名单，因为函数签名里基础名单不接受外部输入）。`InputBar.tsx` 用 `secretHits`/`secretHitIds` 两个 `useMemo` 在草稿文件变化时重算；新增 `requestSubmit` 包一层两个既有提交入口（键盘 Enter 的 `keyboard.submit`、主发送按钮的 `inputActions.submit`，二者本就汇合到同一 `SessionInputShell.submit`）——命中则先弹出两键 `Modal`（`仍要发送`/`先不发送`，`ui-primitives` 既有的 `Modal`+`Button`，非新造弹窗系统），确认后才真正调用被包的入口，取消则仅关闭对话框，草稿与附件原样保留；`secretHitIds` 经 `ComposerAttachmentsOwnerProps.secretContainerHitIds`（可选字段，默认空）下传给 `ui-attachment` 的 `ComposerAttachments`/`FileChip`，命中文件的草稿芯片即时渲染 `StateDot(warning)` + 描边（`data-secret-warning` 供测试挂钩），不弹窗。`locales.ts` 新增 `secretConfirm.*` 五个键（中/英）。部署追加名单走 host 侧新投影键 `secretContainerExtraPatterns`：`apiproxy` 自己的 `Config` 新增同名字段（`z.array(z.string())`，仅可追加，基础名单从不上这根线），`sessions.ts`/`sessions.schema.ts` 按 `imageLimits`/`fileLimits` 同款声明合并 `SessionProjectionMap`，`api-proxy.ts` 用同款 `ctx.inject(['sessionProjections'], ...)` 注册常量投影单元（无需 `attachments` 依赖，无该服务时也存在，值为空数组）。追加一轮（同一系列后续提交，rc.25 现场测试报告）：composer 文件条形卡片此前与图片附件栏未对齐（`.row` 缺少附件栏同款 `padding: 4px 12px 0`）、右侧为绝对定位删除按钮预留 28px 死区、文件名硬截断在 220px、字节大小文案（`ui-conversation` 的 `attachmentSizeText`）恒以 `x.xMB` 呈现使小文件读作 `0.0MB`——一并重排：`FileChip.tsx`/`.module.css` 改为 28px 高、8px 圆角、`--dsw-alias-bg-layer-2` 背景，左侧新增 14px 内联 SVG 文档图形，文件名 `flex: 1 1 auto` 省略号，删除按钮改为内联 flex 子项（16px，非绝对定位，占位不挪动），芯片行与附件栏共用 `padding: 4px 12px 0`、两者同时出现时以 2px 补足 6px 间距；`attachmentSizeText` 改为 1 KiB 以下 `N B`、1 MiB 以下 `N KB`（不带小数）、否则 `N.N MB`（同时修复消息气泡 `FileCard` 的同一格式问题）。命中密钥容器名单的芯片原本只有描边+8px 圆点，现场测试用户未能注意到——同一提交追加：芯片在文件名之后渲染固定文案「密钥文件」（`title` 为"这类文件通常存放密钥，发送前会再向你确认"）；行下方在任一芯片命中时渲染一条提示（12.5px，警示色圆点+文字，指名第一个命中文件的文件名）与其自带的「移除」按钮（复用 `onRemoveImage`），不弹窗、不进模型可见面。`locales.ts` 的 `secretConfirm.*` 组新增 `chipLabel`/`chipLabelTitle`/`notice`/`noticeRemove` 四键（中/英）。
- **为什么**：文件附件系列（`98020a23cd`）打通了 composer 的文本文件草稿通路，但发送前没有任何一道针对"这文件八成是密钥/密码存放处"的确认——用户拖入 `.env` 或 `id_rsa` 会像任何其他文本文件一样原样发送。产品三原则（零术语、系统弹窗给按钮、逐次同意）加一条站内禁令：文案绝不能暗示读取过内容，因为确实没有读——判定只看文件名/路径。追加一轮的两处动因各自独立：芯片布局与附件栏脱节、删除按钮死区、文件名截断过窄、字节数文案对小文件失真，均为 rc.25 现场测试报告的视觉缺陷；而单靠描边+圆点的警示态过于隐晦，用户完全没有注意到，需要一段可读文字把同一条产品原则（零术语、绝不暗示读取内容）落到警示态本身，而不仅是发送时的确认弹窗。
- **要达到的效果**：命中名单的草稿文件即刻在芯片上带警示态；用户按发送时命中文件会先弹出列出全部命中文件名的两键确认，选择"先不发送"取消本次发送且草稿/附件原样保留，选择"仍要发送"才走原有发送路径；无命中时零弹窗零视觉变化，且发送时机、参数与改动前逐字节一致。确认窗本身不进模型可见面、不产会话事件，纯 UI 闸。部署方可通过 `secretContainerExtraPatterns` 追加名单但无法收窄或替换基础名单。命中矩阵单测覆盖 `.env`/`.env.local`、`ID_RSA` 大小写、`.pub` 排除、路径段仅桌面生效等全矩阵；发送链闸单测覆盖键盘 Enter 与按钮两条入口、先不发送/仍要发送两个分支、无命中零弹窗；host 侧新增 `secretContainerExtraPatterns` 投影的常量单元测试与追加即真值测试。`tsc -b tsconfig.host.json`/`tsconfig.client.json`、`oxlint`（限定改动文件）均干净；`ui-conversation`/`ui-attachment`/`host-apiproxy` 三包全量测试套件逐文件 100% 覆盖被改动源文件。追加一轮效果：芯片行与附件栏视觉对齐、删除按钮不再占用死区、字节数在小文件上不再失真为 `0.0MB`；警示态从「容易被忽略的描边+圆点」变为「圆点+可读文案+行下方可操作提示」，单测覆盖标签/提示文案的存在性（仅在有命中芯片时出现，且指名第一个命中文件）与「移除」按钮命中正确的草稿附件；文案不使用"检测/发现/识别"等暗示读取内容的措辞。
- **退役条件**：上游自带等价的发送前密钥容器确认（同款零内容读取、名单可追加的产品行为，覆盖警示态文案与芯片布局）。
- **状态**：在役

## feat(attachment,llm,llm-deepseek,llm-pi-ai): spill oversized file attachments instead of truncating them — 5cd83e5a14
- **改了什么**：新增 `@deepseek-ai/dsh-attachment-spill`（`ctx.attachmentSpill`），位于 `dsh-agent`/`dsh-attachment`/`dsh-llm`/`dsh-spill` 之上；`resolveSpill(attachment, content)` 用进程内 `Map<SessionId, Map<AttachmentId, SpillRef>>` 把同一（会话、附件 id）组合的 `store.saveText` 调用与 `attachment/materialized` 会话事件各限定为每进程一次。`dsh-llm/src/file-lowering.ts` 新增 `FileSpillOptions`/`LoweredFileSpillRef`/`lowerSpilledFileBlockText`，给 `lowerFileBlocksFromStore` 加第四个可选参数 `spill?`（不传时行为逐字节不变）。`llm-deepseek`/`llm-pi-ai` 两个适配器在各自既有的逐适配器降级调用点接入 `fileSpillOptionsFrom(ctx.get('attachmentSpill'))`。`AttachmentSpill.Config` 新增 `inlineWholeUnderChars`（默认沿用退役的 `DEFAULT_MAX_LOWERED_FILE_CHARS`）与 `previewChars`（默认 4,000），均 schemastery 校验。`SessionEventMap` 新增 `'attachment/materialized'`。`ui-conversation/src/client/locales.ts` 的拖放遮罩文案不再断言文本内容"原样发送"。
- **为什么**：`lowerFileBlockText` 此前把任何文本文件附件的解码内容在 `DEFAULT_MAX_LOWERED_FILE_CHARS`（16,000）处截断，超过的部分永久静默丢失，模型没有任何办法取回——这与工具输出早已具备的 spill 通路（`dsh-spill-policy`：超大结果落盘、模型按需 `read`/`grep`）不对称。落位问题经实测确认而非假设：`'agent/request'` waterfall（`packages/core/agent/src/runtime-types.ts:234-244`）的 payload 根本没有 `messages` 字段，其自身 JSDoc 明写"this waterfall cannot mutate messages"，因此设计沿用了原截断逻辑已经在用的落位——每个适配器自己的降级调用点。幂等性设计基于实测：`saveTextFile`（`packages/spill/spill-local/src/store.ts:107-121`）对同一 `suggestedName` 的重复调用总是落到全新的随机路径，没有按名查找也没有内容哈希去重。
- **要达到的效果**：一个超阈值的文本文件附件不再被截断丢内容，而是 spill 成会话作用域的产物，模型可按需 `grep`/`read` 取回全文；进程内缓存保证同一次回合的多个 step 不会为同一个附件重复 spill；`attachment/materialized` 事件让降级文本里出现的定位符始终可从会话日志重建（模型可见⟺已记录）；跨进程的定位符稳定性是写明的已知局限，不是承诺。每个改动包逐文件 100% 覆盖（窄口径确认）；`pnpm run typecheck`、`pnpm run doc-sync`（28/28）、`pnpm run hygiene` 均干净。已对着真实 DeepSeek API、从 scratch `$DSH_HOME` 实机验证一次：一个 95,562 字节、末段带唯一哨兵句的 Markdown 附件，经浏览器 composer 自身也会调用的 `session.prompt` wire 调用发送，模型对记录在案的定位符依次调用 `bash`/`grep`/`read`（`read` 按尾部偏移量精准命中哨兵句所在行）并正确作答；`user/message` 自己的 `file` 内容分片全程只携带 `FileAttachmentRef`，从未携带那 95KB 文本。
- **退役条件**：上游自己的文件附件降级路径为超大文件添加等价的 spill-on-lowering 能力，包括以同一种方式解决"请求重建不变式 vs 降级落位"这一张力（与既有 file-attachment-wire-log-request 补丁同一条张力、同一种解法）。
- **状态**：在役
