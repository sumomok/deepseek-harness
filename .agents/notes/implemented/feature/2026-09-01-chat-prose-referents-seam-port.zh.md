# Agent Note: 把「chat 正文 proseReferents 缝隙」补丁移植到 0.1.2 重组之上

Status: implemented

[English](2026-09-01-chat-prose-referents-seam-port.md) | 中文

## 问题

原始补丁（`ae19472402`，"a proseReferents seam for chat prose"）给 Assistant 正文加了第二条可选服务缝隙，与既有的、只认行内代码的 `chatFileMentions` 并列：`MarkdownRenderContext`（`ui-primitives` 的 `render.tsx`）新增 `referents`，一对不透明的 `scan(text, inlineCode)`／`open(span)`，其 `MarkdownProseSpan` 只携带 `start`／`end`——renderer 永远看不到 `kind`／`target`／`raw`，因此 `ui-primitives` 不依赖运行时的 `ReferentKind`。命中会渲染成 file mention 早已在用的同一枚常显 `css.fileMention` 按钮 token，纯文本（此前直接原样返回字符串）与被 `fileMentions` 放弃认领的行内代码都一视同仁；两者在 `inLink` 内都保持关闭，且只作用于 `renderSettled` 的 context，与 `fileMentions` 自身的流式门控完全一致。`contract/slots.ts` 新增完整的 `ProseReferentSpan`（含 `kind`／`target`／`raw`）与可选服务 `ProseReferents`（`ctx.get('proseReferents')`），沿用 `ChatFileMentions` 的既有约定；`apply.ts` 的 `buildProseReferents` 每次调用都现取 `cwd`（会话快照）与 Host `home`，并把自己的 `ReferentRef`（`source: 'chat-prose'`，`provenance: 'model-text'`）经 `dispatchReferentOpen` 派发——绝不经过下方几行的 `openFile` 闭包，那样会重复派发并把 provenance 错标成 `'structured'`。

这是一个六个补丁相互衔接系列中的第一个（`ae19472402` + `0c9b669a3c` + `6e7045d8cf` + `1d8e975c1a` + `f495eefd50` + `83eb0e3ddb`），每一个都是在前一个之上的、可独立评审的顺序设计增量——与 `4b7d225e25` 的压缩合并不同，本次移植把这六个补丁落成六个独立提交，本条是第一个，后续补丁只在这条已定的设计决策集上继续扩展。它早于本次同步里每个补丁都早于的那次包重组：`ui-conversation` 的 `chat/` 子树（含本补丁自身的目标文件）搬到了新的 `ui-chat` 包；它还依赖 `fabc93555c` 的 `referent/open`／`dispatchReferentOpen` 缝隙（已移植为 `0b32bd30ad`）与 `88129b7b44` 的 `probeTargets` RPC（已在 A 组以 `35ca000207` 落地），本次移植开工前两者均已就位。此系列此前有一次尝试（记录在台账里）撤回了一份文档性 Agent Note 提交，因为它把这套架构描述成已经实现，而当时并未实现；本次移植让这份描述对 `ae19472402` 而言恰好变得准确，还有五个补丁待落地。

## 决策

**`ProseReferents`／`ProseReferentSpan` 落在 `packages/client/ui-chat/src/client/contract/slots.ts`，而不是 `ui-conversation` 的同名文件。** 原始补丁的目标包 `ui-conversation` 已不再拥有 `chat/*.tsx` 渲染调用点或 `apply.ts` 的布线——两者都在重组期间搬到了 `ui-chat`，`ChatNodeOwnerProps`／`ChatViewInjected`／`ChatFileMentions` 也随之搬迁（由本次移植之前的 `fabc93555c` 与 `98020a23cd` 移植确立）。`ProseReferents` 沿用完全相同的先例：它接入的正是 `chatFileMentions` 早已在用的那条链——`ChatViewInjected` → `ChatView` → `ChatNodeOwnerProps` → chat node 渲染器 → `AssistantMarkdown` → `MarkdownText`，因此它落在同一文件里紧挨 `chatFileMentions` 自己的 `Context` 合并代码块旁边。

**`Host home` 的读取方式是 `connection.generation.getSnapshot()?.host.home`，而不是 `connection.hostDescription.getSnapshot()?.home`。** 原始补丁所在代码树的 `ConnectionHandle` 直接带一个 `hostDescription` 字段；当前代码树的 `ConnectionHandle`（`packages/client/connection/src/client/index.ts`）根本没有这个字段——`home` 现在嵌套在 `ConnectionGeneration.host: ConnectionHostInfo` 之下，要经由 `connection.generation.getSnapshot()?.host.home` 才能取到。解析机制本身没变：两棵代码树里都不存在任何 `ctx.connection` 的 `Context` 合并声明，所以 `apply.ts` 仍然用 `ctx.get('connection') as ConnectionHandle` 来取——与 `packages/api/gateway/src/client/index.ts`、`packages/client/ui-settings-general/src/client/index.ts` 里完全相同的写法一致，两者也都在自己的 `inject` 数组里声明了 `'connection'`，尽管取值本身仍是无类型断言；本次移植把 `'connection'` 作为 `ui-chat` `apply.ts` `inject` 数组的第一项加入，同样遵循这一惯例。

**默认打开动作调用 `ctx.remote.session.openWorkspacePath({ path })`，而不是 `ctx.workspaces.openPath(target)`。** `ctx.workspaces` 及其 `openPath` 方法在重组后的代码树上哪里都不存在——原始补丁所在的基线早于移除该服务的那次改动。`buildProseReferents` 下方几行既有的 `openFile` 闭包，早已通过一次 RPC 调用——`ctx.remote.session.openWorkspacePath({ path })`，检查 `.ok` 并在失败时抛错——来解析一个未被认领的工作区路径；`buildProseReferents` 自己的默认动作沿用完全相同的调用，与相邻代码保持行为与风格上的一致，而不是为同一个操作另造第二套机制。

**给 `ui-chat` 的必填 `inject` 数组加 `'connection'` 是一次真实的、包可见的依赖新增，不只是内部细节。** `ui-chat/package.json` 的 `dsh.client.inject` 数组与 `devDependencies` 都新增了 `@deepseek-ai/dsh-client-connection`，符合既有约定——插件 `inject` 数组里点名的每一个 cordis 服务键，都要在这两处各有一条对应的工作区包声明（由 `verify-package-dependencies` 校验）。每一个挂载 `ui-chat` 的 `apply` 的 `SlotTestRuntime` 测试台，如今挂载前都必须 `ctx.provide('connection', ...)`，否则 `SlotTestRuntime.mount()` 会报错拒绝——`"mount would suspend: missing service(s) connection"`；`chat-apply.client.spec.tsx` 与 `apply-inject.client.spec.tsx` 都新增了一个最小桩，只提供被测代码实际读取的 `generation.getSnapshot()?.host.home` 这一形状，遵循 `ui-settings-general` 自己的 apply 测试早已确立的最小桩惯例。

**不移植 `ui-conversation/README.md`（现为 `ui-chat/README.md`）的那段说明文字。** 原始补丁给 `ui-conversation/README.md` 加了一段「每一条 Assistant 消息的正文……第二个独立的开关……」的说明，紧跟在既有的 `chatFileMentions`／收尾轮次正文说明段落之后。在重组后的代码树上，这两段说明在 `ui-chat/README.md` 里都不存在——这段新增内容所依附的整个 `chatFileMentions`／`TurnTailOwnerProps` 讨论早已在重组期间被裁掉（`ui-chat/README.md` 是一份短得多的文档，已直接核实），与 `fabc93555c`、`98020a23cd` 两次移植各自遇到的自家 README 新增内容裁剪情形一致。在没有依附对象的情况下单独添一段新说明，会误导读者以为周围文档讨论着实际不存在的内容。

## 考虑过的替代方案

**把 `ProseReferents` 留在 `ui-conversation` 的 `contract/slots.ts` 里，字面照搬原始补丁的文件路径。** 已否决：`ui-conversation` 已不再拥有这条缝隙的任何实际消费方（`AssistantMarkdown.tsx`、`ChatNodeSeat.tsx`、`ChatView.tsx`、`apply.ts`）——它们都已在此前的移植中搬到了 `ui-chat`。把契约放在一个接不上布线的包里，只会因为要照搬原始补丁如今已经过时的路径，而把一个能力缝隙硬拆成两个包。

**加一个兼容垫片，重新引入 `ctx.workspaces.openPath`，让原始调用点不用改。** 已否决：重组后的代码树上哪里都没有能撑住这种垫片的 `ctx.workspaces` 服务实现——`ctx.remote.session.openWorkspacePath` 才是这棵代码树真正的、已经过测试的替代实现，不是同一个东西的改名别名。重新引入一个没有实现支撑的死接口，只为了绕开一处已经由相邻 `openFile` 闭包确立为正确写法的两行改动，得不偿失。

## 后果

`packages/client/ui-primitives/tests/markdown.client.spec.tsx` 新增七个测试，覆盖正文扫描、`fileMentions` 放弃认领后的行内代码扫描、相邻 span 的渲染、`inLink` 门控、流式门控，以及服务缺席时的默认行为；`markdown-render-units.client.spec.tsx` 新增了 `referents: undefined` 这一 context 字段。`packages/client/ui-chat/tests/chat-view.client.spec.tsx` 与 `packages/client/ui-workflow-run/tests/workflow-run.client.spec.tsx` 的 `ChatNodeOwnerProps`／`ChatViewInjected` 测试夹具新增了 `referents: undefined`。`packages/client/ui-chat/tests/apply-inject.client.spec.tsx` 新增五个测试，覆盖注入到 Chat View 面上的 `referents`（无提供者时的缺省值、`scan` 参数的转发、带 `chat-prose` provenance 的派发、以及两条默认动作兜底路径——文件/目录 span 走 `openWorkspacePath`、url span 走 `window.open`——最后一项把原始补丁对 `workspaces.openPath` 的断言改成了对本代码树 RPC 桩的断言）。该文件与 `chat-apply.client.spec.tsx` 都因新增的必填 inject 而各自在 `bench()` 里加了一个 `runtime.ctx.provide('connection', ...)` 桩。`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` 经 `pnpm run gen-client-catalog` 拾取了拓宽后的 `ChatNodeOwnerProps` 形状，并机械性地挪动了若干条无关的 `source:` 行号引用；`scripts/gen-cordis-catalog.ts` 的 `SERVICE_WALK_EXEMPTIONS` 新增了 `proseReferents` 一条，紧挨 `chatFileMentions`，按该表的既有约定归属到 `packages/client/ui-chat/README.md`——即便该 README 的说明文字本身并未新增（这条豁免记录的是这个客户端侧访问器的存在与归属，不是某一段具体文字）。

这条缝隙原本要支撑的、仓库之外的校验索引（nominate → verify → open 架构里真正的 nominate/verify 层）依旧不落在本仓库——它属于一个仓库之外的插件，与本次移植「核心只提供 Service Definition／Consumer」的能力缝隙哲学一致。此系列剩下的五个相互衔接的补丁（`0c9b669a3c`、`6e7045d8cf`、`1d8e975c1a`、`f495eefd50`、`83eb0e3ddb`）都建立在本补丁确立的 `referents` 缝隙之上，作为后续独立提交落地，六个补丁现已全部落地（`43d944b8fd`、`21c8b07bd5`、`bf2537030f`、`bfd732dd65`、`16ad7f6cd8`、`a8cc98f350`）。

## 后续补丁：13cead33dd（not-found 竞态降级）

同一系列工作里还有第七个相关补丁：`13cead33dd`（"degrade a prose referent's not-found race to the composer's own notice"）修的是一个现场证实的真实缺口——一个 `referents.scan` 曾经验证过的 span，仍可能在验证到点击之间被删除，而 `buildProseReferents.open` 对这条竞态毫无用户可见反馈，只落一条 `console.error`。终端卡早已通过自己的 `ClickOutcome`／内联提示机制降级了完全相同的竞态；正文没有自己的每-span 点击态可以降级进去，因此改为复用会话的 composer 通知通道。

**跨包通知布线用 `sessions.scope(id)` + `actx.get('conversation')`，不是原始补丁同文件的 `InputHub` 实例。** 原始补丁所在基线树里，`buildProseReferents` 与它的 `InputHub` 类实例同处一个文件（`ui-conversation/src/client/apply.ts`）；本次移植的 `buildProseReferents` 落在 `ui-chat/src/client/apply.ts`，而 `InputHub` 仍留在 `ui-conversation`，以 `ctx.conversation.input` 的形式暴露。从另一个包够到它，用的正是 `packages/client/ui-commands/src/client/service.ts` 自己的 `noticeFor()` 早已确立的写法：`sessions.scope(id)` 取会话作用域的 `Context`，再 `actx.get('conversation')`（绝不用 `actx.conversation`——第一次尝试直接属性访问在运行时报错 `"cannot get property conversation without inject"`，因为 `actx` 是当前插件自己 `inject` 数组管不到的作用域；`.get()` 才是 cordis 跨作用域安全的动态查找，不同于受 inject 守卫的直接属性访问器）。`'conversation'` 随之加入 `ui-chat` 的必需 `inject` 数组，与既有的 `'uiConversation'` 同源对齐。

**not-found 分类用 `remoteErrorOf(error)`，不是 `instanceof PathOpenError`。** 原始补丁的 `PathOpenError` 类（带 `.rpcError.code === 'not-found'`）在本代码树没有对应物：`openWorkspacePath` 返回 `{ok: false, error: RemoteError}` 而不是抛出一个包装异常，且路径被删除时的真实失败 code 是 `'session/path-not-found'`（声明在 `packages/api/session-controller/src/types.ts` 的 `RemoteErrorDetailsMap` 里），不是 `'not-found'`。`buildProseReferents` 的 `onDefault` 现在重新抛出原始的 `result.error`（一个真实的 `RemoteError`，保留 `.code`），不再像相邻的 `openFile` 闭包那样压扁成纯文本 `Error`（那个闭包没有专门的失败 UI 要路由，压扁不损失任何信息）；`.catch` 用 `remoteErrorOf(error)?.code === 'session/path-not-found'` 分类，遵循本代码树自己文档化的约定——`packages/typert/protocol/src/remote-error.ts` 自己的注释："structural, not instanceof: an Error thrown in another realm... fails instanceof Error here."（结构判定，非 instanceof：另一个 realm 抛出的 Error 在这里 instanceof Error 会失败）。`@deepseek-ai/dsh-typert-protocol` 加入 `ui-chat` 的 `devDependencies`，用来取 `remoteErrorOf`——纯工具值导入，不是 cordis 服务，因此不需要 `dsh.client.inject` 条目，与好几个已经这样依赖它的 `packages/client/*` 包一致。

**顺带发现并修复了 `ae19472402` 遗留的一处测试缺口。** 跑本补丁自己更宽的受影响测试套件（`ui-chat`、`ui-tool`，外加此前的四个）时发现：`ui-tool` 的三个测试文件（`chat-code-subcalls`／`assembly-surfaces`／`toolview-slot`）挂载了 `applyChat`，但 `ae19472402`（`43d944b8fd`）给它加 `'connection'` 必需依赖时从未同步给这三个文件补上桩——那次提交自己的受影响测试范围只圈定了 `ui-chat`／`ui-workflow-run`／`ui-primitives`／`ui-conversation`，完全漏掉了 `ui-tool`。这是那次早先提交自身验证上的真实缺口，不是 `13cead33dd` 自己新引入的要求；修复落在 `13cead33dd` 的提交里而不是拆成独立的修复提交，因为要拆分就得先临时撤回 `ae19472402` 已经合并的 `apply.ts` 改动，才能让修复提交自己有东西可测——这比它想解决的纠缠成本更高。

**退役条件。** 与原始补丁一致：`proseReferents` 是仅存在于本 fork、为上游会话 UI 尚不具备的能力打的拦截缝隙。一旦上游自己的会话 UI 原生具备对 Assistant 正文里可点引用的扫描与派发能力，本补丁（及本次移植）退役，本 fork 转而适配上游的形态。
