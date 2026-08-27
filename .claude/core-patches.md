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
