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
- **状态**：退役（rc.26 同步，基座 0.1.2-alpha.2）。依据：在新基座上未重落本补丁、直接跑 `pnpm run rescope-vendor:check` 结果为 `post-state verified — no residue, every exact edit landed, idempotent`，全绿；上游 `scripts/rescope-vendor.ts` 的 `EXACT_EDITS` 表里旧的 `packages/util/home` 锚点已随上游自身改动整体消失，中文 vendoring cookbook 链接锚点也已在上游侧修正为 `../rescope.zh.md`。core-patches-v2 未重落此补丁。

## feat(permission-presets): let a host-configured preset name its selector glyph — 00770bab13
- **改了什么**：`PresetSpec`/`PresetOption` 新增可选 `glyph` 字段（三选一闭合枚举，贯穿 schemastery Config schema 与权限投影的 zod wire schema）；`PermissionSelect.tsx` 按 `permissionGlyph(option.glyph ?? option.value)` 解析每行与 trigger 图标。
- **为什么**：Web composer 的权限选择器按选项 `value` 从写死的图形集里选一枚盾牌图标，只有三个内置 preset id 能解析出图标；一个部署自定义的 preset（例如保留审批提示的 full-access 变体）会渲染成夹在带图标行之间的纯文字行，且被选中时 trigger 也丢图标——玻璃 map 硬编码在客户端里，没有任何插件层能触达这个选择。
- **要达到的效果**：宿主配置的 preset 可以显式声明使用哪一枚设计集图标；未声明的键退回到内置图标已经在用的裸盾牌轮廓，选择器里不再出现无图标的行。
- **退役条件**：上游以任何形式获得等价能力（让 preset 自己命名视觉呈现），即退役该 overlay，依赖插件适配上游形式。
- **状态**：在役（rc.26 同步已核实未退役）。核实依据：上游 0.1.2-alpha.2 已有的标签本地化机制（commit `8769d57c98`，`fix(web): localize permission preset labels`）只解决了预设文案的本地化，未新增任何图标/glyph 命名能力——`permissionGlyph` 仍只按 `option.value` 从写死集合取图标；已随重落适配到上游把 `permissionGlyphs` 由对象字面量改成 `Map`、把 `optionLabel(option, t)` 拆成 `permissionLabel(value, name, t)` 后的新结构，补丁本身逻辑不变。

## feat(ui-conversation): open a contribution seat on user messages — 88be8656ab
- **改了什么**：新增会话作用域 list slot `conversation.chat.user-actions`；`ChatView` 声明该位并经 `ChatNodeOwnerProps` 向每个 chat node 传下 `renderUserActions`；`slot-catalog.ts`/`ChatNodeSeat.tsx`/`MessageItem.tsx` 相应改动。
- **为什么**：已定稿 assistant 消息有 `conversation.chat.assistant-actions` 贡献位，用户消息没有对应物——`UserMessageNodeView` 不声明 children 表，插件只能整体遮蔽 keyed `user` 条目才能加一个按钮，逼得想要该能力的插件把操作放到不是该消息的地方（composer dock 或 assistant 行）。
- **要达到的效果**：插件只需注册一个条目即可在用户自己的消息（含已接纳的 steering 气泡）上添加逐消息操作，无需 fork conversation 包；owner currency 携带该消息的日志位置 `seq` 与已渲染文本。
- **退役条件**：上游以任何形式获得等价的用户消息逐消息贡献位，即退役该 overlay，依赖插件适配上游形式。
- **状态**：在役。**落点更新（rc.26 同步，基座 0.1.2-alpha.2）**：上游把 chat 相关实现与其 slot 契约整体从 `packages/client/ui-conversation` 搬到新包 `packages/client/ui-chat`——不仅 `ChatView.tsx`/`MessageItem.tsx`/`ChatNodeSeat.tsx` 等组件文件搬了家，`contract/slots.ts` 里的 `ChatNodeOwnerProps`/`AssistantActionOwnerProps`/`ChatViewSlotProps`/`ChatFileMentions`/`TurnTailOwnerProps` 等 chat 专属类型，以及 `conversation.view` 的 slot 注册点（原在 `ui-conversation/src/client/apply.ts`）也一并搬到 `ui-chat`。本补丁新增的 `RenderUserActions`/`UserActionOwnerProps` 类型与 `conversation.chat.user-actions` 的 SlotMap 声明因此改落 `packages/client/ui-chat/src/client/contract/slots.ts`（挨着同款的 `AssistantActionOwnerProps`），`children` 里的 `'conversation.chat.user-actions': { kind: 'list', scope: 'session' }` 改落 `packages/client/ui-chat/src/client/apply.ts`；`ui-conversation` 自身不再持有任何 chat 专属类型或注册点。

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
- **状态**：**SKIPPED — 需要设计（rc.26 同步，基座 0.1.2-alpha.2）**。上游把整个 `packages/host/apiproxy` 包连根拔起（不是文件内搬家）：`packages/host/` 下已不存在该包，取而代之的是 `directory-picker`/`directory-picker-auto`/`directory-picker-browse`/`directory-picker-native`/`frontend-static`/`plugin-inventory`/`webserver` 等更细分的新包；`host.openPath`/`openTarget` 的职责整体移进了 `packages/api/session-controller`（新模式：`internals.openPath ?? openNativePath` + `canOpenNativePath()`），且原来的扁平 `RpcErrorDetailsMap`/`rpcErrorSchema`（本补丁往这里加 `not-found` 码）已被上游替换成 `packages/client/connection/src/rpc-schema.ts` 里按域命名空间分类的 `RemoteError<'domain/code'>` 闭合联合（如 `session/not-found`、`workspace/not-found`），不再是一个跨域共享的扁平错误码枚举。要不要新增、往哪个命名空间加、`openNativePath` 的 stat 预检与 abort 竞态怎么接，都是需要设计的决定，不是机械搬家；已按红线原地停下、`git cherry-pick --skip`，未重落，交由协调者设计端口。

## fix(ui-primitives): stop silently discarding a disallowed link destination — 5ea5351dae
- **改了什么**：`markdown/render.tsx` 的 `renderSafeLink`：不被允许的目的地不再渲染成裸 `Fragment`（吞掉目的地），改为渲染成 `链接文字 (目的地)` 这样可见、不可交互的文本；两个 `links-and-autolinks` DOM fixture 与 `markdown.client.spec.tsx` 的相关断言随之更新。
- **为什么**：一个未通过协议白名单的链接目的地（相对路径、绝对本地路径、`file:` URL 等）此前被静默丢弃，读者完全看不出这里曾经存在过一处链接，更看不到它指向哪里。
- **要达到的效果**：读者始终能看到一处链接曾被作者写下、以及它指向哪里，即便该目的地无法成为可点击链接；协议白名单本身不变，只是不允许分支的呈现方式变了。
- **退役条件**：上游自己的 markdown renderer 不再悄悄丢弃不被允许的链接目的地。
- **状态**：在役
