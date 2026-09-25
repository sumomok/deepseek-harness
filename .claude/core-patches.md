# core-patches 补丁登记

本文件登记 `feature/core-patches` 线上的每一个补丁族。新增、修改、退役补丁时必须同步更新本文件。

**当前补丁线**：`feature/core-patches`。

**基座 tag**：`dsh-v0.1.7-rc.2`

上面两行是门禁读的声明。基座是 `refs/tags/dsh-v0.1.7-rc.2^{commit}`，且 `git merge-base HEAD <tag>` 必须等于它，即声明的上游发布已经并进本线。本线由 `core-patches-v11` 用 `-s ours` 合并 tag `core-patches-z` 接续，不再变基；`core-patches-v9` 与旧的 `core-patches` 线经 `core-patches-z` 并入了历史。上游发布用 `git merge` 并入本线；`core-patches` 只从本线快进，`develop` 只通过合并 `core-patches` 取得核心改动。

## 身份规则

**补丁身份是 slug，不是提交哈希。** 每个补丁族有一个 kebab-case slug，全线唯一、稳定，由补丁标题派生。同一族的多个提交共用一个 slug。上游的 `verify-repository-references` 拒绝在维护中的散文里出现能解析成本仓提交的十六进制串，所以提交哈希不进本文件。

**first-parent 链上的每个非合并提交带一条 `Patch: <slug>` trailer。** 链从基座 tag 数到 HEAD（`git log --first-parent <base>..HEAD`）。`core-patches-z` 带进来的旧线提交、上游发布里的提交都挂在合并提交的第二父之下，不在链上，不要求 trailer。

**合并规则**：first-parent 链上的合并提交只接受两种。(a) 恰有两个父提交，且第二父恰好是某个 `refs/tags/dsh-v*` tag 指向的提交（附注 tag 取解引用后的提交），即并入上游发布；点名了发布的 octopus 合并仍会带进其余父提交，不算这一种；不对声明的 tag 附加任何祖先条件，因为声明改成更新的 tag 之后，前几轮的发布合并仍留在链上。(b) 合并后的树等于第一父的树，即 `-s ours` 接续。其余合并一律违规：话题分支的合并会把不带 trailer 的提交藏在第二父之下。本线上的改动直接提交或 squash，不走 PR 的合并提交。

**路径认领**：每条 `在役` 或 `局部退役` 记录带一行 `- **路径**：`，后面是若干反引号包住的 git pathspec，门禁给每条加 `:(glob)` 后匹配，可以写 `**`。差异集是 `git diff --no-renames --name-only <base> HEAD` 扣掉生成物豁免集：`**/*.i18n.yaml`、`pnpm-lock.yaml`、`THIRD_PARTY_NOTICES.md`、`docs/{config-catalog,capability-seams,event-producer-consumer}.md`、`docs/{config-catalog,event-producer-consumer}.zh.md`、`docs/persistence-catalog.{md,zh.md}`、`docs/persistence-schema.json`、`packages/extensions/cordis-client-runner/src/client/{slot-catalog,api-catalog}.ts`、`packages/extensions/tool-cordis/src/api-catalog.ts`、`snapshots/**/*.expected.md`、`apps/web/tests/expected/**`（脚本里逐条写死）。`snapshots/**` 下的会话日志、`snapshot.yml`、`workspace.expected/**` 是输入夹具，由对应的族认领；`docs/{config-catalog,event-producer-consumer}.zh.md` 自 `dsh-v0.1.7-rc.2` 起由生成器写入生成区块，与英文对侧一样在豁免集里；`docs/capability-seams.zh.md` 仍是人工维护的对侧，不在豁免集里，与基座不同时由 `rolling-sync-settle` 认领（它因 `auto-compaction-policy-seat` 新增的服务行进入差异集）。同一路径可以由多个族认领。`退役` 记录不带 `路径` 行。

**退役就是差异消失。** 一族的改动全部回到与基座相同时，它的 pathspec 不再命中任何路径，门禁报 `unused-active-slug`，状态改为 `退役`、删掉 `路径` 行。它的旧提交可以留在线上，不要求从线上拿掉。

**门禁**：`pnpm run verify-core-patches`（`scripts/verify-core-patches.ts`，已登记进 `doc-sync`）。违规类型：`unclaimed-path`（差异路径没有在役记录认领）、`unused-active-slug`（在役记录一个差异路径都没认领到）、`unused-pathspec`（某条 pathspec 一个差异路径都没命中）、`missing-paths`（在役记录缺 `路径` 行）、`retired-record-claims-paths`（`退役` 记录带了 `路径` 行）、`trailer-count`（链上提交的 `Patch:` trailer 不是恰好一条——按 git 自己的 `%(trailers:key=Patch)` 读，因此必须落在提交信息的最后一段）、`malformed-trailer`（trailer 的值不是 slug：git 的 trailer key 匹配大小写不敏感、值也来者不拒，slug 格式只能由本门禁把关）、`unregistered-slug`（trailer 点名的 slug 本文件未登记；任何状态都算登记）、`merge-commit`（不属于合并规则 (a)(b) 的合并）、`duplicate-slug`、`missing-status`、`malformed-heading`（`## ` 标题既不是记录格式、也不是 `身份规则`／`历史轮次` 之一——标题解析失败会让整条记录连同它的检查一起蒸发，所以标题本身是违规）。

**门禁的执行面与后果**：**skip（退出 0）只有两种**——checkout 不在本文件声明的补丁线上（`develop`、`core-patches`、集成线、detached HEAD），或本检出是浅克隆（截断的历史够不到基座 tag）；分支这条判在前。**failed（退出 1）** 是其余一切，且不分分支：本文件读不到、代码围栏未闭合、`**当前补丁线**` 或 `**基座 tag**` 声明不是恰好一条（围栏代码块里的示例既不算记录也不算声明）、声明的 tag 不存在（`base-tag-missing`，先 `git fetch upstream --tags`）或未并入 HEAD（`base-tag-not-merged`）、任何一条 git 命令失败（一行诊断，不抛栈），以及上面的违规本身。并入更新的上游 tag 之后、把声明改成它之前，整段上游跨度都会报 `unclaimed-path`；声明与认领在合并之后的登记提交里一起改。**后果**：`ci.yml` 只在 `pull_request` 上跑，`actions/checkout` 在该事件下检出的是这次 PR 的合并提交（detached HEAD），`ci-master.yml` 只在 `master` 上跑，两条都落在第一条 skip 上——漏 trailer、漏登记、漏认领，仍然只有在补丁线分支上跑 `doc-sync` 的人能抓到（那条静态 lane 用的是 `fetch-depth: 0`，所以浅克隆那条 skip 不是 CI 落点）。一个例外是手动触发：`ci-master.yml` 另有 `workflow_dispatch`，在补丁线分支上手动 dispatch 时 `actions/checkout` 按分支名检出，其 linux lane（同样 `fetch-depth: 0`，跑 `check:ci:linux-primary`）会真跑本门禁而不是 skip。决定与实测见 Agent Note [`merge-based-core-patch-line`](../.agents/notes/implemented/process/2026-09-24-merge-based-core-patch-line.md)。

**指向历史的写法**：指向本 fork 的改动写 slug 或相对链接指向该补丁的 Agent Note；指向上游的改动写上游 PR 号（`Merge pull request #NNNN`，即合并提交标题里的那个号，不是分支名里的 issue 号）或发布 tag。

**每条记录的五要素**：改了什么 / 为什么 / 要达到的效果 / 退役条件 / 状态；`在役` 与 `局部退役` 的记录另带 `路径` 行。状态取 `在役`、`局部退役`、`退役` 之一：在役与局部退役写明所在线，退役写明在哪一条线上退的役。**局部退役**指同一族里的部分子件已被上游覆盖或在新基座上失去落点、而族整体仍在役；子件逐条列出，族自己的退役条件不变。

## ansi-line-parser-export — ui-primitives 导出 ANSI 行解析器

- **改了什么**：`packages/client/ui-primitives/src/index.ts` 增加 `parseAnsiLines` 与其行类型的包入口导出，实现文件不动。
- **为什么**：解析器已在包内 `ansi.ts` 实现并由 `TerminalBlock.tsx` 使用，但不在包入口上，仓外客户端插件要渲染同样的 ANSI 输出只能自带一份副本。
- **要达到的效果**：仓外插件与仓内组件读同一份实现，终端输出的换行、控制序列处理只有一处行为。
- **退役条件**：上游自己把 `parseAnsiLines` 加进 `packages/client/ui-primitives/src/index.ts` 的导出面。
- **状态**：在役（`feature/core-patches`）。核实依据：上游 `parseAnsiLines` 三处命中全在包内（`TerminalBlock.tsx`、`ansi.ts`、`ansi.client.spec.ts`），包入口仍不导出。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`ui-primitives` README 两块冲突取上游段落，再接回本族的 allowlist 一句与 `parseAnsiLines` 一句；`src/index.ts` 上游新增的若干导出与本族那一行自动合并。
- **Agent Note**：[`export-ansi-parser`](../.agents/notes/implemented/feature/2026-08-27-export-ansi-parser.md)
- **路径**：`.agents/notes/implemented/feature/2026-08-27-export-ansi-parser.*` `packages/client/ui-primitives/README.*` `packages/client/ui-primitives/src/index.ts`

## approval-detail-by-tool — 审批详情按工具名键控

- **改了什么**：`conversation.approval.detail` 槽由 `kind: 'single'` 改为按工具名键控（`packages/client/ui-approval`），`ui-tool` 为 `write`／`edit`／`str_replace_editor` 占位并新增 `approval-diff-row`，`ui-chat` 的既有占位保持为其余工具的兜底；新增 `apps/web/tests/approval-preview-diff.e2e.ts` 与 `snapshots/web/approval-preview-diff`。
- **为什么**：文件改动等待审批时，卡片只显示工具名与参数摘要，看不到它将写入的路径与行；`single` 槽一次只能有一个占用者，第三方无法只为文件类工具换一张卡。
- **要达到的效果**：文件改动的审批卡显示路径与将写入的行，diff 模型与会话行共用一份；其余工具的审批卡不变。
- **退役条件**：上游把 `conversation.approval.detail` 改成按工具名键控的槽，或自己为文件改动的审批卡渲染 diff。
- **状态**：在役（`feature/core-patches`）。核实依据：上游 `packages/client/ui-approval/src/client/index.ts` 仍声明 `kind: 'single'`。`core-patches-v11` 那一轮适配两处上游改动：`SessionSummary` 新增必填的 `retainedBy`、`SessionListState` 去掉 `current` 与 `currentAddress`（上游 PR #4368），本族 diff 行的列表桩照上游自有卡片 spec 的写法重建；`SlotTestRuntime` 自己提供 `remote`（上游 PR #4231），本族注册用例不再另建一个 `TestRemote`。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：三处。① `ApprovalPanel.tsx` 以上游为底（上游 PR #4793 新增 `displayReason` 与键盘操作）：三参数 `renderSlot` 保留，标题改读上游的 reason，容器改用 `css.detail`；`ui-approval` spec 保留本族用例并补上上游 6 例。② 上游把工具行拆成 preparing／start／result 三阶段（上游 PR #4985），diff 预览只在 `root.phase === 'start'`（已派发的调用）时出现，spec 加一条 preparing 用例；`ApprovalDiffPreview` 的 props 用 `Pick` 收窄到它读取的字段，spec 改成有类型的快照字面量（上游 PR #4610 禁止新增 `as unknown`）。③ 上游新增的两份欠费提示 spec（上游 PR #4858）挂载 `ui-chat` 时要声明本族的 keyed 子位，否则注册失败；它们因此进入本族 `路径`。
- **Agent Note**：[`approval-detail-keyed-by-tool`](../.agents/notes/implemented/feature/2026-09-06-approval-detail-keyed-by-tool.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-06-approval-detail-keyed-by-tool.*` `apps/web/tests/approval-preview-diff.e2e.ts` `apps/web/tsconfig.json` `packages/client/ui-approval/src/client/ApprovalPanel.module.css` `packages/client/ui-approval/src/client/ApprovalPanel.tsx` `packages/client/ui-approval/src/client/contract/slots.ts` `packages/client/ui-approval/src/client/index.ts` `packages/client/ui-approval/tests/ui-approval.client.spec.tsx` `packages/client/ui-chat/src/client/apply.ts` `packages/client/ui-chat/src/client/chat/ApprovalCommand.module.css` `packages/client/ui-chat/src/client/chat/ApprovalCommand.tsx` `packages/client/ui-chat/tests/chat-apply.client.spec.tsx` `packages/client/ui-chat/tests/quota-notice.client.spec.tsx` `packages/client/ui-settings-account/tests/quota-notice-hold.client.spec.tsx` `packages/client/ui-tool/README.*` `packages/client/ui-tool/package.json` `packages/client/ui-tool/src/client/apply.ts` `packages/client/ui-tool/src/client/host-info.ts` `packages/client/ui-tool/src/client/tool/toolviews/approval-diff-row.module.css` `packages/client/ui-tool/src/client/tool/toolviews/approval-diff-row.tsx` `packages/client/ui-tool/tests/approval-diff-row.client.spec.tsx` `snapshots/web/approval-preview-diff/session.v2.jsonl` `snapshots/web/approval-preview-diff/session.v3.jsonl` `snapshots/web/approval-preview-diff/snapshot.yml` `snapshots/web/approval-preview-diff/workspace.expected/notes.txt` `tsconfig.host.json`

## auto-compaction-policy-seat — 自动压缩的实时策略位、分子对齐上下文计量与压缩失败卡

- **改了什么**：三片。① 策略位：`compaction-basic` 的 `types.ts` 新增 Service Definition `CompactionPolicy`（`isEnabled()`、`thresholdRatio()`），`index.ts` 把它声明合并到 cordis `Context` 的 `compactionPolicy` 键并从包根再导出，`agent/pre-step` 的压力路径在 `isEnabled()` 答 `false` 时不进入，`pressureSpec()` 用 `thresholdRatio()` 覆盖加载期阈值；`scripts/gen-cordis-catalog.ts` 的 `SERVICE_PAGE` 与 `scripts/gen-doc-graphs.ts` 的 `SERVICE_ROLES` 各登记一行（两张表是写死在门禁脚本里的完备性名单）。② 分子对齐：`static inject` 加 `sessionProjections`，`occupancyTokens()` 在用量锚定时取 `contextPressure` 投影已发布的 `projectedTokens`（环形计所除的同一个值），未锚定时仍取 `measure()` 的总量；`package.json` 把 `@deepseek-ai/dsh-session-projection` 提为 peer，`tsconfig.json` 加 project reference。③ 失败卡：`ui-chat` 的压缩节点 Definition 收下带 `error` 的 `compaction/end`，没有落地检查点时发出 `compaction-failure` 节点（`contract/chat-nodes.ts` 的 `CompactionFailureChatData`、`MessageItem.tsx` 的行、`register-node-renderers.ts` 的座位、`locale.ts` 的本地化整句）；取消（abort 措辞）不出卡，后端原文只挂 `title`；`turn: null` 的轮外标记对同样出卡。文档：包 README、`docs/subsystems/compaction.*`；生成物 `docs/{capability-seams,config-catalog}.md`、`api-catalog.ts`、`slot-catalog.ts` 由各自的 `gen-*` 重生成，中文对侧手工对齐。本族还订正了两份上游 Agent Note：`2026-07-20-routed-model-context-and-compaction-policy` 与 `2026-07-29-projected-token-usage-and-request-context` 各加一句「部分被本族取代」的交叉链接（核心路径改动，随本族退役时一并还原）。
- **为什么**：触发用的数与用户看的数不是同一个——环形计除的是 prompt 侧的 `projectedTokens`，引擎比的是含 output 的 `totalTokens`；`thresholdRatio` 与 `auto` 只在加载期存在，设置页没有可写入的对象，而引擎每个 agent preset 一实例，插件层加不了 `Context` 键也改不了 pre-step 的读取点。自动压缩失败时标记对以带 `error` 的 `compaction/end` 闭合，但 `buildViewNode` 没有检查点就返回 `null`，对话里什么都不画。
- **要达到的效果**：host 平面插件挂一个 `compactionPolicy` 服务，就能把自动压缩变成运行期生效的用户设置；`isEnabled(): false` 只停压力路径，溢出恢复照常；未挂载提供方时行为与上游逐字相同。用量锚定的会话按环形计显示的百分比触发，未锚定的会话（尤其图片密集）触发点逐字不变——分子只在 `baseline.kind === 'usage'` 时读投影，这道门让 `snapshots/acp/image-compaction` 仍然压缩。自动压缩失败时对话里出现一行本地化提示，手动 `/compact` 的失败仍只走命令卡。
- **退役条件**：三条，分别退役。① 上游让自动压缩获得运行期策略输入，即退役策略位（判据 `git grep -nE "compactionPolicy|thresholdRatio\(\)" <tag> -- packages/compaction`）；② 上游把触发改到 context-pressure 投影上，即退役分子对齐（判据 `git grep -n contextPressure <tag> -- packages/compaction`）；③ 上游以任何形式渲染自动压缩失败，即退役失败卡（判据 `git grep -n compaction-failure <tag>`）。
- **状态**：在役（`feature/core-patches`）。核实依据：`compactionPolicy` 与 `compaction-failure` 在 `dsh-v0.1.7-rc.2` 零命中。随附桌面组合里 `@haoran/dsh-auto-compact` 让 `isEnabled()` 答 `false`、在轮末自己调 `compactNow`，所以那里压力路径不进入、`thresholdRatio()` 没有读者；核心补丁本身不因此改动。Agent Note 的 Related 行点名的桌面 Note「automatic compaction moves to the end of the turn」只在 fork 产品线上，这里不加链接。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游在 `config.ts` 新增 `headroomTokens` 并按「窗口 − 预留输出 − headroom」算压力触发点（上游 PR #4530）。`pressureSpec(policy, contextWindow, reservedCompletionTokens, targetKey)` 现在取 `floor(min(W × ratio, W − O − headroomTokens))`：策略比例只能把触发点往前移，不能越过上游的预留；spec 的测试引擎以 `headroomTokens: 0`、`maxTokens: 8192` 构造，README 中英第 96 行补上 headroom 限定。失败卡 `CompactionFailureNodeView` 的 props 收窄为 `Pick<…, 'node' | 't'>`，失败行 spec 改用有类型的 `ChatNode`（上游 PR #4610）。
- **滚动同步注意**：`compaction-basic` 的两份 README 是活跃冲突面，每轮先解 README 再看代码。上游改 `compactIfNeeded` 的压力段、`TokenMeasurement`／`contextPressure` 投影字段、`resolveCompactSpec` 的参数（`dsh-v0.1.7-rc.2` 在 `config.ts` 新增 `headroomTokens`，要在新语义下重核分子），或往两张门禁名单里插行，都会与本族撞行。失败卡落在 `ui-chat` 的压缩节点 Definition、`MessageItem.tsx`、`locale.ts`，是 client-UI 补丁。生成物冲突时取上游侧后重跑对应 `gen-*`，中文对侧手工带上新增行再 `verify-translation-pairing --write`。
- **Agent Note**：[`auto-compaction-policy-seat`](../.agents/notes/implemented/feature/2026-09-14-auto-compaction-policy-seat.md)
- **路径**：`.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.*` `.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.*` `.agents/notes/implemented/feature/2026-09-14-auto-compaction-policy-seat.*` `docs/subsystems/compaction.*` `packages/client/ui-chat/src/client/chat/MessageItem.module.css` `packages/client/ui-chat/src/client/chat/MessageItem.tsx` `packages/client/ui-chat/src/client/chat/register-node-renderers.ts` `packages/client/ui-chat/src/client/contract/chat-nodes.ts` `packages/client/ui-chat/src/client/conversation-nodes/compaction.ts` `packages/client/ui-chat/src/client/locale.ts` `packages/client/ui-chat/tests/compaction-failure-row.client.spec.tsx` `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` `packages/compaction/compaction-basic/README.*` `packages/compaction/compaction-basic/package.json` `packages/compaction/compaction-basic/src/index.ts` `packages/compaction/compaction-basic/src/types.ts` `packages/compaction/compaction-basic/tests/auto-compaction-policy.spec.ts` `packages/compaction/compaction-basic/tsconfig.json` `scripts/gen-cordis-catalog.ts` `scripts/gen-doc-graphs.ts`

## auto-compaction-running-card — 自动压缩进行中的运行行

- **改了什么**：`ui-chat` 的压缩节点 Definition（`conversation-nodes/compaction.ts`）新增无载荷类别 `compaction-running`：标记对打开、尚无检查点也无失败时，发出锚在 `compaction/start` seq 上的运行行；标记对闭合（`bracketClosed()` 读 `compaction/end`）或所在 step/turn 已关闭（`bracketAbandoned()`，与工具卡的 `interruption()` 读同一个位置状态）时，以同 key 发布 `visibility: 'hidden'` 的节点收束，不返回 `null`。`chat-snapshot-builder.ts` 把 `compaction-running` 登记为已知但不贡献的行；`CompactionItem.tsx` 接受 `node: null` 并走运行态标题 `message.compaction.running`，另有一条视觉隐藏的播报；`MessageItem.tsx` 与 `register-node-renderers.ts` 挂座位；`slot-catalog.ts` 重生成。零新增 locale 键。`ui-chat` README 双语新增「Automatic compaction」一节。
- **为什么**：自动压缩的摘要调用要花数秒，标记对打开期间 `buildViewNode` 返回 `null`，对话里什么都不画；同一笔事务手动发起时从第一刻起就显示「正在压缩…」。本 fork 的策略位让部署方调低触发阈值，这个缺口在长会话里反复出现。
- **要达到的效果**：自动压缩三态齐全：打开时「正在压缩…」，落地后变成既有的已压缩标记，出错时仍是失败卡；Stop 取消后这一行隐藏。实时尾部按 key upsert，撤回已物化目标会抛 `withdrew materialized target`，所以收束一律发布隐藏节点。已闭合的历史标记对渲染路径零改动；start 不在已加载窗口内的历史标记对不出运行行。
- **已知限制**：`turn: null` 的轮外标记对落在 `session` 位置，该位置永不关闭。随附 `@haoran/dsh-auto-compact` 的轮末压缩正是这种标记对，所以压缩进行的那几秒内宿主被杀，该会话重开后会永久保留一行「正在压缩…」。收口判据可以复用引擎自己的「存在 seq 大于该未配对 start 的 `session/end-seed`」，但该事件不在本 Context 的 Matches 里，排在后续版本。
- **退役条件**：上游以任何形式为打开中的自动压缩标记对渲染出任何东西（判据 `git grep -n compaction-running <tag>`）。
- **状态**：在役（`feature/core-patches`）。核实依据：`compaction-running` 在 `dsh-v0.1.7-rc.2` 零命中，上游 `buildViewNode` 没有落地检查点时仍 `return null`。与 `auto-compaction-policy-seat` 的失败卡共用 `ui-chat` 的同一批文件，每轮同步一起移植、一起核实。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游 V4 把检查点来源写成 `{ kind: 'compact-checkpoint', compactionId }`（上游 PR #4429），`conversation-node-definitions` 的运行行夹具随之改写；运行行的 props 收窄为 `Pick<…, 't'>`，运行行 spec 直接渲染 `t` 与落地后的 `CompactionItem`（上游 PR #4610）。**待定**：上游「工作步骤展示」在 compact 与 standard 档下连进行中的轮次也折叠，轮内压缩（溢出恢复、关闭 auto-compact 后的步间压力压缩）的运行行与失败卡会被折进过程组、组标题显示「思考中」；本轮未改，方案（运行行不进组，或给组标题加压缩活动）待定。轮末 idle 压缩写 `turn: null`，不进组。
- **滚动同步注意**：client-UI 补丁，落点 `conversation-nodes/{compaction,chat-snapshot-builder}.ts`、`chat/{CompactionItem,MessageItem}.tsx`、`register-node-renderers.ts`；`dsh-v0.1.7-rc.2` 大改 `CompactionItem.tsx`、`chat-snapshot-builder.ts` 与 `conversation-node-definitions.client.spec.ts`，合并后要重新核对「运行行结算后隐藏」仍然成立。README 冲突时取上游段落再接回本族那一节，然后 `verify-translation-pairing --write`。
- **Agent Note**：[`auto-compaction-running-card`](../.agents/notes/implemented/feature/2026-09-18-auto-compaction-running-card.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-18-auto-compaction-running-card.*` `packages/client/ui-chat/README.*` `packages/client/ui-chat/src/client/chat/CompactionItem.tsx` `packages/client/ui-chat/src/client/chat/MessageItem.tsx` `packages/client/ui-chat/src/client/chat/register-node-renderers.ts` `packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts` `packages/client/ui-chat/src/client/conversation-nodes/compaction.ts` `packages/client/ui-chat/tests/compaction-running-row.client.spec.tsx` `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`

## chat-prose-referents — Assistant 正文的 proseReferents 缝

- **改了什么**：`ui-primitives` 的 `MarkdownRenderContext` 增加不透明的 `referents`（`scan`/`open`/`resolveLink`/`subscribe`），`MarkdownProseSpan` 只携带 `start`/`end`；`ui-chat` 的 `contract/slots.ts` 声明 `ProseReferents` 可选服务，`apply.ts` 的 `buildProseReferents` 绑定 `cwd` 与 Host `home` 并经 `referent/open` 派发；本地路径的 markdown 链接目标经 `resolveLink` 路由，校验节拍上重渲已定稿消息。
- **为什么**：Assistant 正文里的路径与 URL 只有行内代码一条通路（`chatFileMentions`），纯文本与未被认领的行内代码无法成为可点元素，仓外的校验索引插件没有接入口。
- **要达到的效果**：正文命中渲染成与文件提及同一枚常显按钮；`ui-primitives` 不依赖运行时的 `ReferentKind`；无提供者时行为与改动前一致。
- **子件：正文引用 not-found 竞态降级**。`buildProseReferents.open` 的 stat-到-click 竞态失败复用 composer 的通知通道给出用户可见提示，而不是只写 console。它有自己的退役条款，与父族的不同：`git grep path-not-found <tag> -- packages/client` 非空即退役（`dsh-v0.1.7-rc.2` 上为空），或父族整体退役时随之消失。
- **退役条件**：上游自己的会话 UI 原生扫描并派发 Assistant 正文里的可点引用。
- **状态**：在役（`feature/core-patches`）。核实依据：`proseReferents`、`resolveLink`、`linkPlainText` 在 `dsh-v0.1.7-rc.2` 零命中；子件的判据 `git grep path-not-found dsh-v0.1.7-rc.2 -- packages/client` 同样为空。`core-patches-v11` 那一轮适配三处上游改动：`ui-chat` 的 `inject` 列表新增 `uiWorkspace`（上游 PR #4368），本族的 `connection` 与它并列；`ChatView` 的 props 新增 `openExternalLink`（上游 PR #4379），`referents` 与它并列；`MarkdownText` 新增 `variant` prop（上游 PR #4390），`referents` 与 `referentsRevision` 与它同在参数表与依赖数组里；`renderAnchor` 的调用点新增 `context.streaming` 实参（上游 PR #4379），本族的本地路径分支仍在该调用之前返回；`apply-inject` 测试台的 `chatViewApi` 改收 `SessionReference` 而不是裸 `SessionId`（上游 PR #4368），本族 13 条用例改传 `b.rootReference`。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：四处。① `apply.ts` 抽出 `openExternalLink`，跟随上游的链接打开偏好 `linkOpening`（上游 PR #4671），作为新参数传给 `buildProseReferents`（§9 Q14 默认）。② `render.tsx` 的本地路径链接分支加 `classifyLinkPath(destination) !== 'image'`：图片链接交给上游的图片链接预览（上游 PR #5029），不再经本族的 `resolveLink`（§9 Q22 默认），另加一条 markdown 用例。③ `scripts/gen-cordis-catalog.ts` 在第 182–186 行冲突，本族的 `proseReferents` 行与上游新增的 `shortcuts` 行（上游 PR #4891）都保留。④ 上游新增的两份欠费提示 spec（上游 PR #4858）挂载 `ui-chat` 时要提供本族注入的 `connection` 服务；`apply-inject` 测试改用类型守卫 `isComposerBarInject`，它们进入本族 `路径`。
- **Agent Note**：[`chat-prose-referents-seam-port`](../.agents/notes/implemented/feature/2026-09-01-chat-prose-referents-seam-port.md)、[`markdown-link-destination-fallback`](../.agents/notes/implemented/bug-fix/2026-08-27-markdown-link-destination-fallback.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-01-chat-prose-referents-seam-port.*` `packages/client/ui-chat/package.json` `packages/client/ui-chat/src/client/apply.ts` `packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx` `packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx` `packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx` `packages/client/ui-chat/src/client/chat/ChatView.tsx` `packages/client/ui-chat/src/client/contract/slots.ts` `packages/client/ui-chat/src/client/locale.ts` `packages/client/ui-chat/tests/apply-inject.client.spec.tsx` `packages/client/ui-chat/tests/chat-apply.client.spec.tsx` `packages/client/ui-chat/tests/chat-view.client.spec.tsx` `packages/client/ui-chat/tests/quota-notice.client.spec.tsx` `packages/client/ui-primitives/src/index.ts` `packages/client/ui-primitives/src/markdown/MarkdownText.tsx` `packages/client/ui-primitives/src/markdown/render.tsx` `packages/client/ui-primitives/tests/markdown-render-units.client.spec.tsx` `packages/client/ui-primitives/tests/markdown.client.spec.tsx` `packages/client/ui-settings-account/tests/quota-notice-hold.client.spec.tsx` `packages/client/ui-tool/tests/assembly-surfaces.client.spec.tsx` `packages/client/ui-tool/tests/chat-ptc-subcalls.client.spec.tsx` `packages/client/ui-tool/tests/toolview-slot.client.spec.tsx` `packages/client/ui-workflow-run/tests/workflow-run.client.spec.tsx` `scripts/gen-cordis-catalog.ts`

## claude-skills-roots — 扫描项目与用户的 `.claude/skills` 根

- **改了什么**：`packages/skill/skill-filesystem` 新增 `PROJECT_CLAUDE_RANK` 210 与 `USER_CLAUDE_RANK` 510 两个根、`claudeHome` 配置字段（覆盖变量 `$DSH_CLAUDE_HOME`）、`roots()` 按规范路径去重；`packages/skill/skill` 的 `SkillSource` 增加 `project-claude`／`user-claude`；不可扫描的单个根被跳过而不是让整个提供方归零；`tool-skill` 在部分根失败时发布部分目录而不是不发布。`packages/test-support/loader-smoke` 新增并导出 `isolatedSkillRootEnv(cwd, overrides)`，由它驱动测试与脚本里的钉根环境块。
- **为什么**：本 fork 的用户把技能写在 `.claude/skills` 下（与 Claude Code 同一约定），标准 harness 不扫描这两个根，这些技能对模型不可见。
- **要达到的效果**：两个 `.claude/skills` 根按既定优先级参与技能发现；一个根不可读只损失该根，不再让同提供方的全部根一起归零；测试与脚本用同一个函数钉隔离根，不再各写一份键名。
- **退役条件**：上游自己扫描项目与用户的 `.claude/skills` 根（出现等价的根与 `SkillSource` 取值）。另一条独立条款：上游自己按根降级——单根扫描失败只丢该根、不清零整个提供方，无论落在 `skill-filesystem`、`packages/skill/skill` 聚合层，还是 `tool-skill` 改为从部分观测发布目录——本族的按根降级扩展与模型面补齐一并退役（线上 5 个提交属于这一半）。
- **状态**：在役（`feature/core-patches`）。核实依据：`PROJECT_CLAUDE_RANK` 与 `isolatedSkillRootEnv` 在 `dsh-v0.1.7-rc.2` 零命中；上游 `skill-filesystem` 的 `list()` 仍只为 `watchManager.observeRoots` 失败降级（`complete: false`），`discoverRoot` 抛出仍会整个 `list()` 拒绝，第二条退役条款（按根降级）未满足。`core-patches-v11` 那一轮适配一处上游改动：`apps/web/tests/scaffold.ts` 把 `dsh-app-boot` 的函数导出改为在函数体内动态 import、顶部只留类型导入（上游 PR #4471），本族新增的 `isolatedSkillRootEnv` 导入改挂在那条类型导入之后。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游新增的三个启动器——`apps/cli/tests/profiles/headless/tests/profile-resolution.ts`、`source-tool.built.e2e.ts`（上游 PR #4570）与 `apps/web/tests/server-restart.e2e.ts`（上游 PR #4855）——只钉了 `DSH_HOME` 与 `DSH_AGENTS_HOME`，现在各自展开 `isolatedSkillRootEnv`，沿用原来的 home 与 agents 路径。
- **Agent Note**：[`claude-skills-root`](../.agents/notes/implemented/feature/2026-09-06-claude-skills-root.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-06-claude-skills-root.*` `apps/cli/tests/agent-team-headless.e2e.ts` `apps/cli/tests/github-webhook-real.e2e.ts` `apps/cli/tests/headless-shutdown.e2e.ts` `apps/cli/tests/profiles/headless/tests/profile-resolution.ts` `apps/cli/tests/profiles/headless/tests/source-tool.built.e2e.ts` `apps/cli/tests/web-auth.e2e.ts` `apps/cli/tests/web-browser-open.expected.e2e.ts` `apps/web/tests/scaffold-hermetic.e2e.ts` `apps/web/tests/scaffold.ts` `apps/web/tests/server-restart.e2e.ts` `apps/web/tests/smoke-real.e2e.ts` `docs/subsystems/skills.*` `packages/skill/skill-filesystem/README.*` `packages/skill/skill-filesystem/src/index.ts` `packages/skill/skill-filesystem/tests/skill-filesystem-watcher.spec.ts` `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` `packages/skill/skill/src/index.ts` `packages/skill/tool-skill/README.*` `packages/skill/tool-skill/src/index.ts` `packages/skill/tool-skill/tests/tool-skill.spec.ts` `packages/test-support/loader-smoke/README.*` `packages/test-support/loader-smoke/src/index.ts` `packages/test-support/loader-smoke/tests/loader-smoke.spec.ts` `packages/test-support/session-snapshot/src/harness.ts` `packages/test-support/session-snapshot/src/launcher.ts` `scripts/publish-npm-baseline.ts` `scripts/release/verify-packed-install.ts` `scripts/smoke-python-runtime.py` `snapshots/sdk/sdk.snapshot.ts`

## command-engages-session — 命令自己声明是否让所在会话转正

- **改了什么**：`CommandDefinition` 增加 `engages?: boolean`（默认 true），只有声明为 false 时把 `engages: false` 写进 `command/run` 载荷；`session-format-v0-to-v1` 的处置表与 payload 校验收该成员为可选布尔；`applySessionListMetadata` 在 `turn/start` 与未写 `engages: false` 的 `command/run` 上清除 `blank`，`stateVersion` 有意保持 1；客户端只在观察到本会话自己的 `command/run` 时转正，并落闩防止陈旧摘要把它抬回去；`/plan` 与 `/permission` 声明 `engages: false`。
- **为什么**：全新会话里把一条命令作为第一条消息发出，host 已执行并落盘，但界面停在欢迎页、侧栏不列出该会话——host 折叠只认 `turn/start`。而「每条命令都转正」同样错：欢迎页自己的访问模式 chip 运行的就是 `/permission`，会话若因此转正，人在为尚未开始的会话设访问模式的那一刻就失去欢迎页。
- **要达到的效果**：只跑过转正命令的会话有侧栏行、打开在自己的转录上；只跑过 `/plan`／`/permission` 的会话一切照旧。翻转点是 `command/run` 而非 `command/done`。
- **退役条件**：上游自己让命令声明是否使会话转正（`CommandDefinition` 出现等价字段，或 `applySessionListMetadata` 自己按某种声明在 `command/run` 上清除 `blank`），且客户端镜像在同一判据上转正。两半各自判定。
- **状态**：局部退役（`feature/core-patches`）。宿主半在役，核实依据：`engages` 在 `dsh-v0.1.7-rc.2` 的 `commands`、`session-controller`、`plan`、`permission-presets` 四包零命中；上游改了 `list.ts` 的周边，`applySessionListMetadata` 的 fold 未动，仍只在 `turn/start` 上清除 `blank`。客户端半被上游覆盖（上游 PR #4351、#4349：客户端经宿主 fold 的 `sessionListMetadata` 投影读 blank 位），以下子件退役、取上游原文：
  1. `packages/api/session-controller/src/client/sessions/session.ts` 的 `observeEngagement` 与 `engaged` 闩；
  2. `packages/api/session-controller/tests/session.client.spec.ts` 的 `blankOpened` 与本族七个用例，以及 `tests/event-script.client.ts` 的 `commandRunConfiguring`；
  3. `packages/client/ui-commands/README.*` 的「Admission is all this package does…」一句与 `tests/service.client.spec.ts` 的「engagement is not this layer's business」用例；
  4. `packages/client/ui-conversation/tests/skeleton.client.spec.tsx` 的注释改动。
  rc.30 及更早版本留下的、只跑过转正命令的旧会话，客户端不再自愈；但这些会话在侧栏里不列出，用户在界面上够不到它们。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：客户端半取上游（见上）；Agent Note 的客户端一节改写为「客户端经上游 #4351 读宿主 fold 的 `sessionListMetadata` 投影」，删掉「第二个标签页要等下次 list pull」这条限制；`web-client-session-scope` Note 取上游段落，再接回 `command/run` 插入语。回归覆盖见 `session-format-out-of-repo-events` 的目录测试（`engages: false` 经 V0→V4 保留）。上游自带的四份 V4 web 夹具日志按本族重录，`/permission` 与 `/plan` 的 `command/run` 带上 `engages: false`，与同名 V2／V3 日志一致。
- **待拍板：要不要继续背这条语义分歧**。`dsh-v0.1.7-rc.2` 上该 spec 的模块头注释明写「standalone plugin events — command lifecycle records … never flip it」，与本族的契约相反；该注释在 v9 基座上就已经是这样，v9 已经覆盖它，不是本轮新出现的冲突。上游的意图是明示的，不是疏忽，fork 的「退化条款」（上游一改同处即退役去适配）在字面上未触发（上游改了 `list.ts` 的周边，fold 未动），但这正是该条款想覆盖的情形，需要显式确认「继续背」。
- **已知后果（未立案迁移）**：`applySessionListMetadata` 的 `stateVersion` 有意停在 1（`packages/api/session-controller/src/list.ts` 的注释写明理由：升版会让每个未重开的会话丢掉 `lastPromptAt`，整条侧栏改按创建时间排序与标注，代价大于纠正 `blank`）。因此**本次构建之前跑过命令的会话保留旧的 blank 判决，不会自愈**；要不要做一次性迁移未定。
- **Agent Note**：[`command-engages-blank-session`](../.agents/notes/implemented/bug-fix/2026-09-10-command-engages-blank-session.md)
- **路径**：`.agents/notes/implemented/architecture/2026-07-25-web-client-session-scope-and-provide-channel.*` `.agents/notes/implemented/bug-fix/2026-09-10-command-engages-blank-session.*` `apps/web/tests/feedback-command.e2e.ts` `docs/persistence-changes/2026-09-17-command-run-engages.md` `docs/persistence-changes/2026-09-17-command-run-engages.schema.json` `docs/persistence-changes/2026-09-17-command-run-engages.zh.md` `docs/subsystems/commands.*` `packages/api/session-controller/src/list.ts` `packages/api/session-controller/tests/session-list-blank.host.spec.ts` `packages/client/ui-workspace/README.*` `packages/feedback/command-feedback/README.*` `packages/interaction/commands/README.*` `packages/interaction/commands/src/index.ts` `packages/interaction/commands/src/types.ts` `packages/interaction/commands/tests/commands.spec.ts` `packages/interaction/permission-presets/src/index.ts` `packages/interaction/permission-presets/tests/projection.spec.ts` `packages/plan/plan-mode/src/index.ts` `packages/plan/plan-mode/tests/plan-mode.spec.ts` `packages/session/session-format-v0-to-v1/src/dispositions.ts` `packages/session/session-format-v0-to-v1/src/payload-validation.ts` `packages/session/session-format-v0-to-v1/tests/validation.spec.ts` `packages/session/session-format-v1-to-v2/tests/migration.spec.ts` `snapshots/web/approval-composer/session.v2.jsonl` `snapshots/web/approval-composer/session.v3.jsonl` `snapshots/web/approval-composer/session.v4.jsonl` `snapshots/web/permission-policy-context/session.v2.jsonl` `snapshots/web/permission-policy-context/session.v3.jsonl` `snapshots/web/permission-policy-context/session.v4.jsonl` `snapshots/web/plan-review/session.v2.jsonl` `snapshots/web/plan-review/session.v3.jsonl` `snapshots/web/plan-review/session.v4.jsonl` `snapshots/web/ptc-escalation-approved/session.v3.jsonl` `snapshots/web/ptc-escalation-approved/session.v4.jsonl`

## connection-state-event — 连接粗粒度状态作为类型化客户端事件

- **改了什么**：`packages/client/connection/src/client/index.ts` 声明 ROOT 作用域客户端事件 `connection/state`，`packages/api/gateway/src/client/index.ts` 在连接状态变化时派发它，取值为该连接实际的三态模型。
- **为什么**：仓外客户端插件要按连接状态显隐自己的界面，只能轮询运行时内部对象。
- **要达到的效果**：插件订阅一个类型化事件即可跟随连接状态，不碰运行时内部。
- **退役条件**：上游自己广播等价的连接状态事件。
- **状态**：在役（`feature/core-patches`）。核实依据：`connection/state` 在 `dsh-v0.1.7-rc.2` 零命中。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：无改动，自动合并。
- **路径**：`packages/api/gateway/src/client/index.ts` `packages/api/gateway/tests/gateway.client.spec.ts` `packages/client/connection/src/client/index.ts` `scripts/gen-cordis-catalog.ts` `scripts/gen-cordis-inspect-catalog.ts`

## core-patches-ledger — 补丁登记文档自身

- **改了什么**：`.claude/core-patches.md` 本身——每轮同步登记基座、逐条补丁的五要素与状态。
- **为什么**：补丁线是一组长期存在的对上游的偏离，没有一份登记就无法判断某条补丁是否已被上游实现、是否该退役。
- **要达到的效果**：任何一轮同步都能只读本文件决定每条补丁的去留。
- **退役条件**：不适用——fork 不再维护补丁线时本文件随之消失。
- **状态**：在役（`feature/core-patches`）。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：基座声明改为 `dsh-v0.1.7-rc.2`，全部在役记录改写状态行与核实依据，新增 `llm-tool-choice` 与 `llm-response-format` 两条，`legacy-preset-alias` 退役。
- **路径**：`.claude/core-patches.md`

## core-patches-registry-gate — 按 slug 登记补丁身份与其门禁

- **改了什么**：新增 `scripts/verify-core-patches.ts` 与 `package.json` 的 `verify-core-patches` 脚本，登记进 `scripts/run-gates.ts` 的 `doc-sync` 叶子列表，附 `scripts/verify-core-patches.spec.ts`；全线提交加 `Patch: <slug>` trailer；本文件按 slug 重写；Agent Notes 与 `packages/preset/agent-presets/src/index.ts` 里指向提交的散文改写为 slug、上游 PR 号或描述。门禁按本文件开头的 `**基座 tag**` 取基座，核对三件事：first-parent 链上每个非合并提交恰有一条登记过的 `Patch:` trailer；链上的合并只能是恰有两个父提交、第二父为 `dsh-v*` 发布提交的合并，或树等于第一父的 `-s ours` 接续；与基座的每一处差异（生成物除外）都由某条在役记录的 `路径` 行认领，每条在役记录和它的每条 pathspec 都至少命中一处差异。
- **为什么**：登记曾用提交哈希做身份。哈希每轮变基全部作废——上一轮登记的 284 个哈希里只有 72 个还能在当时的线上解析——而上游新增的 `verify-repository-references`（上游 PR #4060）拒绝维护中的散文里出现能解析成本仓提交的十六进制串，两条一起使哈希不可用。
- **要达到的效果**：补丁身份不依赖提交哈希且可机械核对；登记写明每族相对上游占着哪些路径，线上多出一处无主改动、或某族改动已消失而记录仍在役，门禁都会失败。
- **退役条件**：上游为引用门禁提供排除或配置口且本 fork 改回哈希登记，或上游自己提供等价的补丁登记机制。
- **状态**：在役（`feature/core-patches`）。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`dsh-v0.1.7-rc.2` 起 `gen-config-catalog`、`gen-doc-graphs` 自己写 `docs/config-catalog.zh.md` 与 `docs/event-producer-consumer.zh.md` 的生成区块，两份进入 `GENERATED_PATHSPECS`；spec 加一例：两份只有生成区块与基座不同时无人认领也通过，并加一例反证：人工维护的 `docs/capability-seams.zh.md` 无人认领时仍报 `unclaimed-path`。
- **提交信息订正**：提交 `fix(scripts): close the four ways the patch-registry gate let real errors by` 的信息写「`upstream/master` was checked for existence, not for being this line's base. A stale ref silently widened the range, and the extra upstream commits surfaced as trailer violations pointing at upstream's own work. It is now compared against `git merge-base upstream/master HEAD`」。这条修法没有解决它声称解决的问题：`upstream/master` 落后真实基座时它仍是 HEAD 的合并基座，基座判据照样接受它，范围照样撑到上游的提交上，门禁随即把上游自己的提交报成 `trailer-count`／`merge-commit` 违规而失败——就是该信息描述的那个症状，只是落点从基座判据挪到了违规清单。反方向（`upstream/master` 前进，每次 `git fetch upstream` 之后的常态）则直接失败在基座判据上，而提示里的「fetch」只会让它更红。基座现由本文件的 `**基座 tag**` 声明给出，按 `refs/tags/<tag>` 解析并要求已并进 HEAD，门禁不读 `upstream/master`。本线只追加提交、不改写历史，以本条为准。
- **Agent Note**：[`core-patch-identity-trailers`](../.agents/notes/implemented/process/2026-09-17-core-patch-identity-trailers.md)、[`merge-based-core-patch-line`](../.agents/notes/implemented/process/2026-09-24-merge-based-core-patch-line.md)
- **路径**：`.agents/notes/implemented/process/2026-09-17-core-patch-identity-trailers.*` `.agents/notes/implemented/process/2026-09-24-merge-based-core-patch-line.*` `package.json` `scripts/run-gates.ts` `scripts/verify-core-patches.spec.ts` `scripts/verify-core-patches.ts`

## disallowed-link-destination-notice — 被阻止的链接目标不再静默丢弃

- **改了什么**：`packages/client/ui-primitives` 的 markdown 渲染在链接目标不被允许时保留可读文本与目标串，而不是渲染成空。自 `core-patches-v11` 那一轮起覆盖两条通路：`renderSafeLink` 的 `safeHref === ''` 分支，以及上游新增的 `MarkdownFileLink` 在 `openFile === undefined` 时的分支（`renderAnchor` 把归一化后的目标串一并传下去，两条通路写出同一串 `文本（目标）`）。
- **为什么**：模型写出的本地路径或非允许协议链接被静默丢成空元素，读者既看不到文本也看不到目标。
- **要达到的效果**：被阻止的目标仍以纯文本呈现，用户能读到模型实际写了什么。
- **退役条件**：上游 `renderSafeLink` 自己对不被允许的目标保留可读文本。
- **状态**：在役（`feature/core-patches`）。核实依据：上游 `renderSafeLink` 的 `safeHref === ''` 分支仍返回只含 children 的 `Fragment`，上游 `MarkdownFileLink` 在 `openFile === undefined` 时仍 `return <>{children}</>`，两条通路都仍丢目标串（`git show dsh-v0.1.7-rc.2:packages/client/ui-primitives/src/markdown/render.tsx`）。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游改写了 `render.tsx` 的文件链接段（上游 PR #5029 的图片链接预览等），合并时取上游那 6 行，本族只改其中没有 opener 的那一行，让它在文本后接 `（目标）`；`ui-primitives` README 的块变了，取上游段落后接回本族那半句。
- **`core-patches-v11` 那一轮适配**：上游把 anchor 渲染拆成 `MarkdownAnchor` 组件、由 `MarkdownDelegateProvider` 提供 `openExternalLink`（上游 PR #4379），本补丁只改那条被拒分支，允许分支改为返回上游的 `MarkdownAnchor`；`ui-primitives` README 的「Rendering agent output」整段被上游重写，本补丁那半句重新落在 `MarkdownText` 段里；上游同一 PR 新增的 `parseFileLink`／`MarkdownFileLink` 把本地路径形状的目标从 `renderSafeLink` 手里接走，本补丁跟进到那条新通路的无委托分支上；上游新增的 `markdown-file-links.client.spec.tsx` 那 17 条惰性目标断言与 1 条撤委托断言改成本 fork 的渲染，并新增 4 条无委托用例。
- **判错订正（`core-patches-v11` 那一轮）**：本族一度被记成「局部退役」，理由是「没有委托时目标丢失不是产品里的配置」。该前提不成立：全仓产品代码里 `MarkdownDelegateProvider` 只有 `packages/client/ui-chat/src/client/chat/ChatView.tsx` 一处，且只包住 `ChatNodeList`；`ui-sidebar-documentpreview` 的 `MarkdownBody`、`ui-plan` 的 `PlanPreview`、`ui-trajectory` 的 `TrajectoryTable`、`ui-user-questions` 的 `QuestionComposer` 四处分别挂在 `sidebar.right.pane.tab`／`conversation.view`／`conversation.composer` 上，都是 `conversation.chat` 的兄弟槽，不可能落进那棵子树。实测真实的 `MarkdownBody` 渲染 `[relative](/settings) and [js](javascript:alert(1))`：跟进前是 `relative and js (javascript:alert(1))`（本地路径目标被丢），跟进后是 `relative (/settings) and js (javascript:alert(1))`。因此这是那一轮新引入的用户可见回归（`file-link.ts` 在上一轮基座上不存在），不是上游接管。族整体维持在役。
- **提交信息订正**：提交 `test(ui-primitives): follow the destination the file-link path now claims` 与 `docs(notes): name the half of the link-destination fallback upstream now owns` 的信息写「no product surface renders markdown without the delegate」及等价中文表述，该前提按上一条订正；两条提交已推 origin、不改写历史，以本条为准。
- **Agent Note**：[`markdown-link-destination-fallback`](../.agents/notes/implemented/bug-fix/2026-08-27-markdown-link-destination-fallback.md)
- **路径**：`.agents/notes/implemented/bug-fix/2026-08-27-markdown-link-destination-fallback.*` `packages/client/ui-primitives/README.*` `packages/client/ui-primitives/src/markdown/render.tsx` `packages/client/ui-primitives/tests/fixtures/markdown-dom/links-and-autolinks.settled.txt` `packages/client/ui-primitives/tests/fixtures/markdown-dom/links-and-autolinks.streaming.txt` `packages/client/ui-primitives/tests/markdown-file-links.client.spec.tsx` `packages/client/ui-primitives/tests/markdown.client.spec.tsx` `packages/client/ui-tool/tests/approval-diff-row.client.spec.tsx`

## factory-zero-deepseek-egress — 出厂零 DeepSeek 出站

- **改了什么**：`packages/bundle/base/cordis.patch.yml` 的 `session-telemetry-otel` 与 `plugin-package-inventory-deepseek` 两行加 `disabled: true`，`session-log-deepseek` 一行加 `config: { enabled: false }`；`packages/bundle/sdk-minimal/cordis.patch.yml`（该 bundle 刻意不叠加 base，是自己完整的树）的 `plugin-package-inventory-deepseek` 一行加 `disabled: true`、`session-log-deepseek` 一行加 `config: { enabled: false }`；各行的上游配置声明原样保留；两个 bundle 的 `tests/*.spec.ts` 各自钉住本 bundle 每一行的字面内容，并把 `session-log-deepseek` 行再经该插件自身 schema 解析一遍钉住实际取值；四份 README 改述本产品出厂状态。`snapshots/sdk/text-turn/cordis.yml` 补一行 `session-log-deepseek` 的 `enabled: true`：该组合是语料里对上传通路的覆盖，原先靠插件 schema 默认开启，base 出厂关闭后覆盖会变成死覆盖。
- **为什么**：本 fork 的产品决定是出厂即零会话遥测、零已装插件清单、零会话日志贡献流向 DeepSeek 官方 API，且不依赖用户设置环境变量。`session-telemetry-otel` 的 `mode` 只选采集策略、表达不了「关」；`plugin-package-inventory-deepseek` 没有等价开关；`session-log-deepseek` 的 `enabled` 在 `0.1.6-alpha.1` 基座上默认为 true。
- **要达到的效果**：两个 bundle 各自把通往 DeepSeek 的上报路径出厂关闭；用行标志的那些 `apply()` 根本不运行，`session-log-deepseek` 用的是插件自身的 `enabled` 字段——`apply()` 仍运行一次，但在注册 `dsh_session_log` 请求贡献之前返回，而那条贡献是该插件贡献的全部；profile patch 重新开启任一行即得到上游自己的行为。
- **退役条件**：上游自己把这些行出厂关闭，或 fork 不再发布面向终端用户的产品。
- **状态**：在役（`feature/core-patches`）。核实依据：上游 `packages/bundle/base/cordis.patch.yml` 两行仍无 `disabled: true`、`session-log-deepseek` 行仍无 `config`；上游 `packages/bundle/sdk-minimal/cordis.patch.yml` 的 `plugin-package-inventory-deepseek` 行仍无 `disabled`、`session-log-deepseek` 行仍无 `config`；该插件 schema 为 `enabled: z.boolean().default(true)`。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：两个判定（§9 Q13）。① 上游自 `dsh-v0.1.7-rc.1` 起在 base 新挂 `deepseek-account`。② `dsh-v0.1.7-rc.2` 把 base 的 `llm-deepseek` 行改装 `@deepseek-ai/dsh-llm-deepseek-api-key`，并新增启用的 `llm-deepseek-account` 行（账户认证的 LLM 路由 `deepseek-account`，`packages/bundle/base/cordis.patch.yml` 第 524–528 行）；sdk-minimal 与 `snapshots/sdk/text-turn/cordis.yml` 同步改名。账号推理路由无 token 不出站：未登录时 `discoverModels` 返回 `[]`。本族的 `enabled: false`／`disabled: true` 在别的行，自动合并；base 第 43、77、204 行三行仍是开启，退役条件未满足。`apps/web/tests/scaffold.ts` 的冲突块与上一轮相同。
- **提交信息订正**：提交 `chore(bundle): hold the DeepSeek session-log contributor shut through its own config field` 的信息写「withholds the `dsh_session_log` request contribution while the plugin's remaining contributions stay mounted」——不成立：`packages/session/session-log-deepseek/src/index.ts` 的 `apply()` 只注册一样东西，且在 `enabled !== true` 时直接返回，「其余部分」是空集；与 `disabled: true` 的唯一差别是模块仍被导入、`apply()` 仍空跑一次。本文件返工前写的「插件其余部分照常挂载」是同一处失真的中文措辞，出自本文件自己而非那条提交信息，已按事实改写。提交已推 origin、不改写历史，以本条为准。
- **提交信息订正**：提交 `test(sdk): declare the upload policy on the text-turn composition` 的信息写 `snapshots/sdk/text-turn` 是「the corpus's only coverage of the DeepSeek upload path」——「唯一」不成立：`snapshots/sdk/serial-created` 与 `snapshots/sdk/subagent-dsh-sdk-diagnostic` 的 `cordis.yml` 同样声明 `enabled: true`，两者的金样里都有 `session-log-deepseek/delivery-accepted`。该提交信息的另一半成立：text-turn 是当时唯一还靠插件 schema 默认继承该策略的组合。本线只追加提交、不改写历史，以本条为准。
- **提交信息订正**：提交 `test(bundle): read the base patch once and title each case by what holds it` 的标题里「read the base patch once」这半句过实：同一份 `packages/bundle/base/tests/base.spec.ts` 的第二个用例仍就地重解析 `cordis.patch.yml`（它按 `Record<string, unknown>` 读平台表达式，与 `patchRows()` 的行类型不是一回事），该文件在同一 spec 里仍被读两次。去重只落在第一个用例上。本线只追加提交、不改写历史，以本条为准。
- **滚动同步注意**：patch 是整段替换目标行的 `config` 而非合并，因此后续任何一层只要给 `session-log-deepseek` 行任何 `config` 却没重述 `enabled: false`，就会恢复上游的默认开启。
- **不回补的一半**：壳侧的 `DSH_TELEMETRY_DISABLED` 与桌面组装层用例——补丁线上没有 fork 外壳，上游同名的 `apps/desktop` 是另一个应用。
- **Agent Note**：[`fork-kills-session-telemetry-and-plugin-inventory`](../.agents/notes/implemented/process/2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.md)
- **路径**：`.agents/notes/implemented/process/2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.*` `apps/web/tests/scaffold.ts` `packages/bundle/base/README.*` `packages/bundle/base/cordis.patch.yml` `packages/bundle/base/tests/base.spec.ts` `packages/bundle/sdk-minimal/README.*` `packages/bundle/sdk-minimal/cordis.patch.yml` `packages/bundle/sdk-minimal/tests/sdk-minimal.spec.ts` `snapshots/sdk/text-turn/cordis.yml`

## llm-tool-choice — 要求直接请求的回答调用已提供的工具

- **改了什么**：`packages/llm/llm/src/types.ts` 的 `GenerateOptions` 新增 `toolChoice?: { type: 'any' }`（紧跟 `toolHistory`），不进 `LlmCallConfig`；`packages/core/agent-loop/src/invariant.ts` 要求 loop 请求不带它。`llm-deepseek` 把它映射成 Messages 的 `tool_choice: { type: 'any' }`，所有思考档位照常映射；`tools` 为空或缺省时在 HTTP 之前抛 `INVALID_REQUEST`。`llm-pi-ai` 在任何 I/O 之前以 `UNSUPPORTED_OPTION` 拒收，消息点名 `GenerateOptions.toolChoice`。三份 README、`docs/subsystems/llm-streaming` 的类型粘贴块、`docs/user/develop/practice/llm-adapter` 和 Agent Note 同步更新。
- **为什么**：仓外的判官要一个机器可读、不会跑题的回答。rc.33 的 JSON 模式（`llm-response-format`）落在 chat-completions 协议上，上游 #4629 删掉了这个协议；harness 的 Messages 请求类型里没有 JSON 模式字段。强制工具调用是 Messages 原生的结构化回答方式。2026-09-24 的实测：`{ type: 'any' }` 在 thinking 开和关下都返回 `tool_use`；`{ type: 'tool', name }` 在 thinking 开时返回 400。
- **要达到的效果**：判官请求只提供 `submit_verdict` 一个工具并强制调用，结论只从 tool_use 的 input 里读，不再依赖模型是否听从「只写 JSON」；做不到的适配器明确失败，不会悄悄退回纯文本；不带这个字段的请求逐字节不变。
- **退役条件**：上游 `GenerateOptions` 出现 `toolChoice` 或等价的工具选择字段。核实只读声明点：`git grep -n "toolChoice" upstream/master -- packages/llm/llm/src/types.ts`，非零即人工复核。不要 grep 整个仓库：openrouter 夹具里的 `tool_choice`、`python/sdk/tests/test_smoke_model.py` 的 `"toolChoice"`、README 里「不映射 `tool_choice`」的旧句都会命中，它们都不是退役信号。局部退役：上游加了字段但 `llm-deepseek` 仍不映射时，本族只剩 deepseek 映射那一半。
- **状态**：在役（`feature/core-patches`，基座 `dsh-v0.1.7-rc.2`）。同一改动将作为 PR 提给上游（推送与提 PR 待确认，提交后补上 PR 号）。
- **滚动同步注意（无门禁的一处）**：随包的 gateway 用声明合并重述 `GenerateOptions.toolChoice`，本仓没有任何东西编译它；声明合并只要求属性类型一致。核心这个字段的类型一变（例如上游加成员），两处必须同一轮改。
- **Agent Note**：[`llm-tool-choice`](../.agents/notes/implemented/feature/2026-09-26-llm-tool-choice.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-26-llm-tool-choice.md` `.agents/notes/implemented/feature/2026-09-26-llm-tool-choice.zh.md` `docs/subsystems/llm-streaming.md` `docs/subsystems/llm-streaming.zh.md` `docs/user/develop/practice/llm-adapter.md` `docs/user/develop/practice/llm-adapter.zh.md` `packages/core/agent-loop/src/invariant.ts` `packages/core/agent-loop/tests/invariant.spec.ts` `packages/llm/llm-deepseek/README.md` `packages/llm/llm-deepseek/README.zh.md` `packages/llm/llm-deepseek/src/serialize.ts` `packages/llm/llm-deepseek/src/wire-types.ts` `packages/llm/llm-deepseek/tests/adapter.e2e.ts` `packages/llm/llm-deepseek/tests/adapter.spec.ts` `packages/llm/llm-deepseek/tests/serialize.spec.ts` `packages/llm/llm-pi-ai/README.md` `packages/llm/llm-pi-ai/README.zh.md` `packages/llm/llm-pi-ai/src/adapter.ts` `packages/llm/llm-pi-ai/tests/adapter.spec.ts` `packages/llm/llm/README.md` `packages/llm/llm/README.zh.md` `packages/llm/llm/src/types.ts`

## open-path-not-found-error — 路径打开器返回可区分的 not-found

- **改了什么**：`session/openWorkspacePath` 在目标不存在时返回带 `session/path-not-found` 码的失败，而不是一个无法区分的通用错误。
- **为什么**：客户端要把「目标不存在」降级成自己的提示，但拿不到可判别的失败码，只能匹配错误文案。
- **要达到的效果**：调用方按码分支；文案变化不影响判别。
- **退役条件**：上游为该端点提供等价的可判别失败码。
- **状态**：在役（`feature/core-patches`）。核实依据：`session/path-not-found` 在 `dsh-v0.1.7-rc.2` 零命中。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游 `openWorkspacePath` 改为先查询桌面文件应用（上游 PR #4562，`workspacePathApplications`／`verifyDesktopPath`）。合并后的顺序是 `verifyDesktopPath` → `stat`（`ENOENT` 映射为 `session/path-not-found`）→ `signal.throwIfAborted()` → 三路打开；`@throws` 文案随之改写。host spec 以上游为底重写，用 `statOverride` 桩与 `realpath(mkdtemp)` 下的真实文件，本族三例改用真实文件。
- **路径**：`packages/api/session-controller/src/index.ts` `packages/api/session-controller/src/types.ts` `packages/api/session-controller/tests/session-open-workspace-path.host.spec.ts`

## permission-preset-glyph — 宿主配置的预设可点名选择器图标

- **改了什么**：`PresetSpec` 与 `PresetOption` 增加可选 `glyph`，取值为封闭设计集 `read-only`／`workspace-write`／`danger-full-access`；schemastery Config schema 用 `PRESET_GLYPHS` 做闭集校验，未知名称在插件加载时带配置路径失败；`PermissionSelect` 每一行与 trigger 都按 `option.glyph ?? option.value` 取图标，设计集外的键画裸盾牌轮廓。
- **为什么**：选择器的图标表按 option 值硬编码在客户端里，只有三个内置预设 id 能解析到图样；部署自配的预设渲染成一行没有图标的文字，且没有任何插件层能从外部修正。
- **要达到的效果**：部署自配的预设能点名一枚设计集图标；任何其他键画裸盾牌，因此没有一行是无图标的。
- **退役条件**：上游让宿主配置的预设决定选择器图标（`PresetSpec`／`PresetOption` 出现等价字段）。
- **状态**：局部退役（`feature/core-patches`）。族整体在役，核实依据：`PresetGlyph` 在 `dsh-v0.1.7-rc.2` 零命中；schemastery 侧的闭集校验（`PRESET_GLYPHS` + `z.union`）与 `optionOf` 透传原样保留，未知名称仍在插件加载时带配置路径失败。四处局部退役：
  1. **投影 wire schema 里的 `glyph` 校验**：上游 PR #3304 把目录改成类型化的 `@Remote('catalog')`，`permissions` 投影的 wire view 只剩 `currentValue`，本补丁加在那份 zod 里的闭集校验随该 schema 一并消失。
  2. **`projection.spec` 的「经 wire schema 服务一枚配置的 glyph」用例**：同一原因，该投影不再带 `options`，用例已无被测对象，取上游侧。替代覆盖在 `permission-presets.spec.ts` 的「carries a configured design-set glyph into the option and rejects any other name at load」（含 `glyph: 'sparkles'` 的加载期拒绝）。
  3. **本补丁自带的 `shieldOutline` 路径数据**：上游 PR #4461 把三枚内置图标改成了图标组件，`PermissionSelect.tsx` 不再就地组合 svg；本补丁的裸盾牌随之改用 `IconShieldOutlineRegular`（`const bareShield = <IconShieldOutlineRegular />`），不再自带路径数据。
  4. **README Summary 里的 glyph 说明**：上游整段重写了 `packages/interaction/permission-presets/README.md` 的 Summary（上游 PR #3304），且该段受字数上限约束，本补丁原先压进去的那句（「A table entry may also name its selector `glyph`.」）随之丢弃。glyph 只剩「Configuring presets」一段说明。
  trigger 上那条注释的丢失**不是** `ModelSelect` 迁包造成的——`ModelSelect.tsx` 在 v9 基座上就已在 `ui-model-selection`，与 `PermissionSelect` 本就不同包。真实原因是上游把 `PermissionSelect` 迁进新包 `ui-permission-presets`（上游 PR #3304）并自己拥有了那几行 chevron JSX，本补丁不再新增它们，注释因此失去落点。
- **提交信息订正**：本族有一条 `adapt(permission-preset-glyph)` 提交的信息首段描述的是前一提交已完成的组件搬迁（glyph 用例随组件进入 `ui-permission-presets`），与它自己的 diff 不符——该提交的实际改动只有既有用例的 svg 计数 1→2 加一条注释。提交已推 origin、不改写历史，以本条为准。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游 PR #4587 把 `permission` 的 Config 改成 volatile 并让目录带 `defaultPreset`／`defaultOptions`：本族 glyph 用例的 Config 写成有类型的字面量（`'sparkles' as string as PresetGlyph`，上游 PR #4610 禁止 `as unknown`），`permission-select` 的 glyph 目录夹具补上两个必填字段；`src/index.ts` 以 `static Config = z.object({ presets: z.dict(presetSpecSchema) … })` 合并，删掉 `presetChoice()`。
- **Agent Note**：[`permission-preset-glyph`](../.agents/notes/implemented/feature/2026-08-23-permission-preset-glyph.md)
- **路径**：`.agents/notes/implemented/feature/2026-08-23-permission-preset-glyph.*` `docs/subsystems/permission-presets.*` `packages/client/ui-permission-presets/src/client/PermissionSelect.tsx` `packages/client/ui-permission-presets/tests/permission-select.client.spec.tsx` `packages/interaction/permission-presets/README.*` `packages/interaction/permission-presets/src/index.ts` `packages/interaction/permission-presets/src/types.ts` `packages/interaction/permission-presets/tests/permission-presets.spec.ts` `scripts/type-equiv.manifest.json`

## permission-preset-tone — 宿主配置的预设可点名选择器色调

- **改了什么**：`PresetSpec` 与 `PresetOption` 在 `glyph` 旁增加可选 `tone`，取值为封闭集 `PresetTone`（只有 `danger`）；schemastery 预设表 schema 用 `PRESET_TONES` 做闭集校验，未知色调在插件加载时带配置路径失败；`optionOf` 把 `tone` 透传到选项上。`settings-store.ts` 把 `catalog.defaultOptions[i].tone` 透传到行选项。两个访问模式菜单——输入框旁的 `PermissionSelect` 与设置页的 `PermissionRow`——把 `tone: 'danger'` 映射成 `Menu` 原语已有的破坏性行，不新增 CSS 或颜色 token。`packages/bundle/base/cordis.patch.yml` 给 `danger-full-access` 标 `tone: danger`，插件自带的默认表不标。`/permission` 命令弹出的选择器不上色。文档：两包 README、`docs/subsystems/permission-presets.*`（含 `PresetTone` 的 type-equiv 块与 `scripts/type-equiv.manifest.json` 一行）；`docs/config-catalog.md`、`api-catalog.ts` 由 `gen-*` 重生成。
- **为什么**：两个访问模式菜单把每个预设都画成普通文字色，`danger-full-access` 与 `workspace-write` 看起来一样，直到点下去才弹风险确认。哪一行危险是宿主配置决定的，不是客户端事实：gateway 层的 `yolo-access` 也是完全权限，但仍要问人，必须保持普通色。
- **要达到的效果**：宿主给哪个预设标 `danger`，两个菜单就把那一行画成破坏性行；共用完全权限图标不等于标了危险色调；未标的行与改动前相同。
- **退役条件**：上游让宿主配置的预设决定菜单行的色调（`PresetSpec`／`PresetOption` 出现等价字段）。判据：`git grep -n "PresetTone\|tone?:" <tag> -- packages/interaction/permission-presets/src` 零命中即未退役。
- **状态**：局部退役（`feature/core-patches`）。族整体在役，核实依据：`PresetTone` 在 `dsh-v0.1.7-rc.2` 零命中。四个子件在新基座上失去落点：
  1. **投影 zod wire schema 里的 `tone`**：上游 PR #3304 把可选项改成类型化的进程级目录，`permissions` 投影的 wire view 只剩 `currentValue`，`tone` 随 `PresetOption` 的类型透传即可。与 `permission-preset-glyph` 的第 1 条同因。
  2. **`projection.spec.ts` 的 glyph 与 tone 用例**：同一原因，该投影不再带 `options`，用例没有被测对象，取上游侧。
  3. **`input-bar.client.spec.tsx` 的「paints the row whose tone the host named」用例**：上游把 `PermissionSelect` 迁进 `ui-permission-presets`，输入框的 spec 不再引用它；用例改写后搬进 `ui-permission-presets/tests/permission-select.client.spec.tsx`（本族的 `adapt(permission-preset-tone)` 提交），去掉映射那一行即失败。
  4. **设置行经 schemastery `extra` 槽读 tone**：上游 PR #4587 把 `defaultPreset` 改成 volatile 字符串，设置行从 `catalog.defaultOptions` 取选项，`defaultPreset` 的 union 成员、`presetChoice()` 与 `PERMISSION_SETTINGS_NAMESPACE` 都不存在了；tone 只走 `optionOf` 一条通路。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：tone 用例改读 `mounted` 的目录，删掉 settings union 那一半与它独占的 `defaultPresetChoices` 导入；Config 写成有类型的字面量（`'caution' as string as PresetTone`）；设置行 spec 的目录类型化为 `PermissionCatalog`、给 `danger-full-access` 标 `tone: 'danger'`；`permission-select` 的 tone 目录补上 `defaultPreset`／`defaultOptions`；Agent Note 第 17 行改写为「两个菜单都读进程级目录」，删掉 Alternatives 里「用 schemastery 的 `role` 承载色调」一条。上游的 `focus-rings.e2e.ts` 用 End／Home 走访问模式菜单并要求每一行都是普通悬停底色，而 base bundle 给最后一行 `danger-full-access` 标了 `danger`，它是破坏性行、底色取 `--dsw-alias-interactive-bg-hover-danger`；该用例改为对最后一行断言这个 token。
- **提交信息订正**：本族首条提交沿用 develop 的提交信息，其中「carried on the permission projection's zod wire schema」与上面第 1 条不符——本线上 `tone` 不经过任何 zod wire schema。以本条为准。
- **随附组合**：桌面组合里 gateway 包按 id 替换 `permission` 行的整个 `config`，所以桌面实际跑的是 gateway 重述的预设表；`tone: danger` 要在那张表里再标一次（属 fork 插件侧，不在本线）。
- **滚动同步注意**：与 `permission-preset-glyph` 同文件（`permission-presets` 的 `src/index.ts`、`src/types.ts`、README、spec，`ui-permission-presets` 的 `PermissionSelect.tsx`），两族一起移植、一起核实。`dsh-v0.1.7-rc.2` 把 `defaultPreset` 改成 volatile 并删掉 `PERMISSION_SETTINGS_NAMESPACE`，`settings-store.ts` 以上游为底接回 `tone` 的透传；rc.2 起行选项来自 `catalog.defaultOptions`。
- **Agent Note**：[`permission-preset-danger-tone`](../.agents/notes/implemented/feature/2026-09-17-permission-preset-danger-tone.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-17-permission-preset-danger-tone.*` `apps/web/tests/focus-rings.e2e.ts` `docs/subsystems/permission-presets.*` `packages/bundle/base/cordis.patch.yml` `packages/client/ui-permission-presets/README.*` `packages/client/ui-permission-presets/src/client/PermissionRow.tsx` `packages/client/ui-permission-presets/src/client/PermissionSelect.tsx` `packages/client/ui-permission-presets/src/client/settings-store.ts` `packages/client/ui-permission-presets/tests/permission-presets-row.client.spec.tsx` `packages/client/ui-permission-presets/tests/permission-select.client.spec.tsx` `packages/client/ui-permission-presets/tests/settings-store.client.spec.ts` `packages/interaction/permission-presets/README.*` `packages/interaction/permission-presets/src/index.ts` `packages/interaction/permission-presets/src/types.ts` `packages/interaction/permission-presets/tests/permission-presets.spec.ts` `scripts/type-equiv.manifest.json`

## referent-open-seam — `referent/open` 引用点击拦截缝

- **改了什么**：`packages/api/session-controller` 新增 ROOT 作用域 waterfall 事件 `referent/open` 与 `dispatchReferentOpen(ctx, ref, onDefault)`；`ReferentRef` 只携带引用身份——`kind`、`target`、`raw`、可选 `sessionId`、点名派发点的 `source`、以及 `enteredAs`（`structured`／`model-text`／`tool-output`／`user-text`）——绝不携带被引用内容；`ui-chat` 的 `openFile` 闭包与正文 span 打开器都经该缝派发。
- **为什么**：浏览器会话 UI 里每一处「打开该引用」各自直连打开动作，仓外插件无法在任何一处之前介入。
- **要达到的效果**：此后新增的可点元素只要派发就自动可拦截；监听者不调用 `next()` 即认领该次点击，抛出或拒绝按等同于 `next()` 处理，因此一次点击总能落到某个打开动作上。
- **退役条件**：上游自己提供等价的引用点击拦截点。
- **状态**：在役（`feature/core-patches`）。核实依据：`referent/open` 在 `dsh-v0.1.7-rc.2` 零命中。上游 PR #3151 新增的 `scripts/verify-concrete-terms.ts` 拒绝本缝原字段名里那个含糊的来源标签，字段因此改名为 `enteredAs`，取值与语义不变。`core-patches-v11` 那一轮适配一处上游改动：`packages/api/session-controller/src/client/index.ts` 新增 `typertOwnedValue` 导入（上游 PR #4368），`ClientReferent` 的导入与它并列。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`session-controller` README 冲突块取上游段落，本族的 referent 段接在「During uninterrupted…」之后、`skills/list` 之前；`apply.ts` 与 `gen-cordis-catalog.ts` 的并集见 `chat-prose-referents`。
- **Agent Note**：[`referent-open-seam-port`](../.agents/notes/implemented/feature/2026-09-05-referent-open-seam-port.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-05-referent-open-seam-port.*` `apps/web/tests/navigation-panes.e2e.ts` `docs/subsystems/session.*` `packages/api/session-controller/README.*` `packages/api/session-controller/src/client/index.ts` `packages/api/session-controller/src/client/referent.ts` `packages/api/session-controller/tests/referent.client.spec.ts` `packages/client/ui-chat/src/client/apply.ts` `packages/client/ui-chat/tests/apply-inject.client.spec.tsx` `packages/test-support/client-runtime/src/index.ts` `scripts/gen-cordis-catalog.ts`

## referent-target-probe — 批量路径存在性探测 `probeTargets`

- **改了什么**：`session-controller` 新增 `probeTargets` 端点，一次调用回答一批路径是否存在。
- **为什么**：引用校验层要在渲染前判断一批目标是否可打开，逐条 RPC 的往返次数与正文里的引用数同阶。
- **要达到的效果**：一次调用得到整批结论，校验层不按引用数发请求。
- **退役条件**：上游自己提供等价的批量存在性探测端点。
- **状态**：局部退役（`feature/core-patches`）。族整体在役，核实依据：`probeTargets` 在 `dsh-v0.1.7-rc.2` 零命中。一处局部退役：原先给穷举式客户端假实现 `packages/api/session-controller/tests/fake-api.client.ts` 绑定 `probeTargets` 的那条提交在 `core-patches-v11` 那一轮退役——上游 PR #3960 把该假实现整体换成 `tests/remote/{session,bench,history}.client.ts` 的部分规则表，不再要求绑定每个端点，该补丁存在的理由消失。宿主侧覆盖未损失：`session-probe-targets.host.spec.ts` 与 `test-remote.ts` 仍钉着该端点。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`session-controller/src/index.ts` 的 import 取并集；上游新增的 `workspacePathApplications`／`verifyDesktopPath`（上游 PR #4562）在前，本族的 `probeTargets` 在后，各自带 JSDoc。`types.ts` 上游新增的 `session/provider-*` 错误码与本族的 `PROBE_TARGETS_MAX_PATHS` 共存。
- **路径**：`docs/subsystems/session.*` `packages/api/session-controller/src/index.ts` `packages/api/session-controller/src/types.ts` `packages/api/session-controller/tests/session-probe-targets.host.spec.ts` `packages/api/session-controller/tests/test-remote.ts` `scripts/gen-cordis-catalog.ts`

## rolling-sync-settle — 每轮滚动同步的适配与生成物收敛

- **改了什么**：每轮同步里**没有所属补丁族**的跨仓适配与生成物收敛：重跑 `gen-*` 生成物、重录双语配对记录、把跨多族的合并文档收敛到字数上限、把横跨多族的测试夹具搬到本基座的 harness 上。
- **为什么**：补丁本身不变，但它依赖的上游 API、测试夹具与生成器输出每轮都在动；不收敛这些，补丁在新基座上编译不过或门禁不绿。而这类收敛里有一部分跨了多个补丁族，挂不到任何一族的 slug 上。
- **要达到的效果**：生成物与源树一致，`gen-*`／`verify-*` 的 `--check` 全部退出 0；跨族的文档与夹具在当前基座上成立。
- **归属规则**：**只服务单一补丁族的适配提交挂那一族自己的 slug**，不挂本族——`core-patches-v10` 上的三条 `adapt(referent-open-seam)`／`adapt(permission-preset-glyph)`／`adapt(command-engages-session)` 即如此。否则按 slug 退役某一族时会找不到它这一轮的适配提交。并入上游 tag 时的冲突解决是另一回事：它落在并入 tag 的那个合并提交里，合并提交不带 trailer；合并之后的适配提交再按上面的规则，只服务单一族的挂那一族的 slug，跨族的挂本族。`core-patches-v11` 及以前各轮是变基，冲突解决直接落在被重放的补丁提交里，逐处记在各族的状态行上。
- **退役条件**：不适用——本族随每轮同步重生成，不是可退役的 overlay；它服务的补丁族退役时，对应的适配随之消失。
- **状态**：在役（`feature/core-patches`）。`dsh-v0.1.7-rc.2` 这一轮新增：合并后重跑全部 `gen-*`（client、Cordis、Cordis-inspect、config、persistence 目录与 doc graphs），并把 22 份旧格式配对记录按基座的逐标题格式重录（18 份合并进来的 fork 记录，加回补线新增的 4 份 Note）；web 与会话快照金样的重录见各自所属的族。`core-patches-v11` 那一轮新增 1 条（重跑 `gen-*` 收敛生成物），线上另有 4 条继承自 `core-patches-v9`。
- **路径**：`docs/capability-seams.zh.md` `packages/session-query/session-log-export/README.*` `packages/session/session-format-v1-to-v2/tests/migration.spec.ts` `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts`

## session-export-progress — 导出面板显示进度与失败

- **改了什么**：`session-log-export` 的导出路由回送条目总数头（`SESSION_EXPORT_ENTRIES_HEADER`），页面据此显示进度并在失败时留在页面上说明原因；面板文案与两趟测量的实际语义同步。
- **为什么**：大会话导出期间页面没有任何进展迹象，失败时也只是弹窗消失。
- **要达到的效果**：导出有可见进度条与可读的失败说明。
- **退役条件**：上游自己让导出回送进度信息并在页面显示。
- **状态**：在役（`feature/core-patches`）。核实依据：`SESSION_EXPORT_ENTRIES_HEADER` 在 `dsh-v0.1.7-rc.2` 零命中。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游把导出改为请求文档相对路由（上游 PR #4203），`controller.ts` 以 `GET` 请求该路由，`controller` spec 的 null-origin 用例改名为「requests the document-relative route through the default carrier」，删掉 `downloadUrl` 用例；Agent Note 第 15 行删掉 null-origin 兜底从句。强转改写（上游 PR #4610）：`dialog.client.spec.tsx` 的 props 断言保持与上游逐 token 相同，`cancel` 移到断言之外展开；`controller` spec 的 save mock 类型化后直接取 `save.mock.calls[0]!`，无响应体用例改用 `new Response(null, { status: 200 })`。
- **Agent Note**：[`session-export-progress`](../.agents/notes/implemented/feature/2026-09-03-session-export-progress.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-03-session-export-progress.*` `apps/web/tests/navigation-panes.e2e.ts` `packages/client/ui-chat/tests/apply-inject.client.spec.tsx` `packages/session-query/session-log-export/README.*` `packages/session-query/session-log-export/src/archive.ts` `packages/session-query/session-log-export/src/client/Dialog.module.css` `packages/session-query/session-log-export/src/client/Dialog.tsx` `packages/session-query/session-log-export/src/client/controller.ts` `packages/session-query/session-log-export/src/client/index.ts` `packages/session-query/session-log-export/src/client/locales.ts` `packages/session-query/session-log-export/src/client/progress.ts` `packages/session-query/session-log-export/src/export-extent.ts` `packages/session-query/session-log-export/src/index.ts` `packages/session-query/session-log-export/tests/archive.host.spec.ts` `packages/session-query/session-log-export/tests/client-apply.client.spec.tsx` `packages/session-query/session-log-export/tests/controller.client.spec.ts` `packages/session-query/session-log-export/tests/dialog.client.spec.tsx` `packages/session-query/session-log-export/tests/header-action.client.spec.tsx` `packages/session-query/session-log-export/tests/progress.client.spec.ts` `packages/session-query/session-log-export/tests/route.host.spec.ts` `packages/session-query/session-log-export/tsconfig.client.json` `packages/session-query/session-log-export/tsconfig.host.json`

## session-export-size-text — 导出面板尺寸文案取自 ui-primitives

- **改了什么**：删除 `session-log-export` 自带的 `byte-size.ts` 与其用例，`Dialog.tsx` 改用 `ui-primitives` 已导出的 `fileSizeText`。
- **为什么**：那是仓内已有格式化函数的私有副本。
- **要达到的效果**：面板读数走仓内唯一一份实现；文案随之变化（不加空格、所选单位十以下保留一位小数）。
- **退役条件**：不适用——本条是删除自有代码改用上游实现，不构成对上游的补丁负担。
- **状态**：在役（`feature/core-patches`）。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：无改动，自动合并。
- **路径**：`packages/session-query/session-log-export/src/client/Dialog.tsx` `packages/session-query/session-log-export/tests/dialog.client.spec.tsx` `packages/session-query/session-log-export/tsconfig.client.json`

## session-export-unreadable-entries — 不可读附件写成归档条目而不撕裂流

- **改了什么**：`session-log-export` 的 `archive.ts` 在附件对象读不出来时，把一条说明记录写进归档里该附件本该占的条目，而不是让 ZIP 流中断。图片半边是 `mediaEntry`/`unreadableMediaEntry`；通用文件半边是 `fileEntry`/`unreadableFileEntry`/`resumedFileChunks`——`fileEntry` 在产出条目前先拉存储的第一个分块（写入器本就在花这一个分块的内存预算），拉取被拒才改记录。两条路径共用 `unreadableAttachmentReason`。记录的路径键与碰撞前提写在 `archive.ts` 的 JSDoc 里。
- **为什么**：一个读不出来的附件会让整次导出失败，用户拿不到任何内容，也看不到是哪个附件出的问题。现场触发源是仓外截图插件把 JPEG 按 `image/png` 声明保存，已写进日志的引用永久保留；通用文件半边则是上游把文件对象搬到 `file-objects/`／`files/`（上游 PR #3109）之后，`attachment-text-file-kind` 时代写下的文件对象一律读不到（见该条的破坏性变化）。
- **要达到的效果**：不可读的图片留下带 `attachmentId`、`mediaType`、`bytes`、`width`、`height` 的记录，不可读的通用文件留下带 `attachmentId`、`name`、`bytes` 的记录（**文件记录没有 `mediaType`**，引用本身不带）；两者都附失败原因，条目数因此把它计在内。
- **三项例外——导出并非总能完成**：(1) **取消仍撕裂**：`archive.ts` 的 `fileEntry` 与 `mediaEntry` 在返回不可读条目之前都先 `signal?.throwIfAborted()`，取消在两条路径上都让流出错；(2) **通用文件第一个分块之后抛出的失败仍撕裂**，字节已经上线，无法再改写成记录；(3) **读不出来的子会话日志仍让流出错**——`sessionLogTextEntries` 对没有存储日志的子会话直接抛错。
- **安全动机（不可回退）**：`unreadableAttachmentReason` 只在失败是 `AttachmentError` 且带字符串 `code` 时写出 `code` 与 `message`，其余一律只写一行匿名原因。理由是本包对 attachment 包只有类型依赖、按 `name` 结构匹配，而 Node 的 fs 错误同样带字符串 `code` 且 `message` 含主机绝对路径——归档是用户会下载并转发的文件，**绝不回显可能含主机绝对路径的 message**。这比 `error.ts` 的「按 code 路由」更严，是有意的。
- **退役条件**：上游自己在导出遇到不可读附件时记录并继续（图片与通用文件同一判据）。
- **状态**：在役（`feature/core-patches`）。核实依据：`unreadableMediaEntry` 在 `dsh-v0.1.7-rc.2` 零命中。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`archive.ts` 保留本族整块，接上上游的两行 JSDoc（上游 PR #4603 把附件发现限定在声明过的事件内容上）；archive spec 保留本族三例、删掉上游已删的 nested 用例；两条不可读图片事件改写成有类型的 V4 `user/message`（上游 PR #4610）；上游把侧栏搜索框的占位符改成「Search session names」（仍经内容索引匹配正文），`navigation-panes.e2e.ts` 的不可读媒体导出用例跟着改定位器。
- **Agent Note**：[`export-records-unreadable-media`](../.agents/notes/implemented/bug-fix/2026-09-04-export-records-unreadable-media.md)
- **路径**：`.agents/notes/implemented/bug-fix/2026-09-04-export-records-unreadable-media.*` `apps/web/tests/navigation-panes.e2e.ts` `packages/session-query/session-log-export/README.*` `packages/session-query/session-log-export/src/archive.ts` `packages/session-query/session-log-export/src/index.ts` `packages/session-query/session-log-export/tests/archive.host.spec.ts`

## session-format-legacy-message-source — 一种历史消息来源种类过 V3 迁移边

- **改了什么**：`session-format-v2-to-v3` 接受语料里仍在的一种仓外历史消息来源种类，并说明每处检查与定位器各自在判断什么。
- **为什么**：该来源种类由本 fork 的产品线写入，V3 边不认识它就拒绝整份会话日志，而一次拒绝会让派生索引的整轮观察中止、内容搜索全库退回名称匹配。
- **要达到的效果**：携带该来源种类的会话能迁移、能索引；接受面仍是一份按盘上实测列出的名单，不是通用放行。
- **退役条件**：上游把该来源种类纳入已发布来源词表，或为来源分类提供自定义扩展点，或语料里不再存在它。
- **状态**：在役（`feature/core-patches`）。核实依据：`git grep -c 'LEGACY_UNINTERPRETED_SOURCE_KINDS\|at-file-mention' dsh-v0.1.7-rc.2 -- packages/session` 零命中，上游既没纳入该来源种类也没开扩展点；备份 home 语料（`~/.dsh.backup-2026-09-02-before-rc27` 的 121 份日志）里 `at-file-mention` 仍命中 8 份。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`legacy-uninterpreted.spec.ts` 的历史 `at-file-mention` 事件直接标注为 `SessionFormatEvent`，不再经 `as unknown`（上游 PR #4610）。经完整目录 V0→V4 的回归测试 `session-format-catalog/tests/fork-historical-events.spec.ts` 同时断言 `at-file-mention` 来源原样保留，该文件登记在 `session-format-out-of-repo-events`。
- **Agent Note**：[`v2-to-v3-legacy-source-kind`](../.agents/notes/implemented/bug-fix/2026-09-10-v2-to-v3-legacy-source-kind.md)
- **路径**：`.agents/notes/implemented/bug-fix/2026-09-10-v2-to-v3-legacy-source-kind.*` `apps/web/tests/navigation-panes.e2e.ts` `packages/session/session-format-v2-to-v3/README.*` `packages/session/session-format-v2-to-v3/src/index.ts` `packages/session/session-format-v2-to-v3/src/payload.ts` `packages/session/session-format-v2-to-v3/tests/legacy-uninterpreted.spec.ts`

## session-format-out-of-repo-events — 已落盘的仓外历史事件过迁移边

- **改了什么**：`session-format-v0-to-v1` 的 `LEGACY_UNINTERPRETED_EVENT_TYPES` 点名本 fork 产品线写过的仓外事件类型，三条迁移边读同一个被点名集合，逐条原样带过并在 v2 标记 `ignorable: true`。
- **为什么**：迁移边拒绝一切不在冻结清单上的历史事件类型，本 fork 的产品线写过的事件因此让整份会话日志打不开。
- **要达到的效果**：被点名的类型原样过边，其余未点名的仍被拒绝。
- **退役条件**：上游把这些类型纳入自己的迁移清单，或为迁移边提供自定义词汇扩展点，或 fork 不再需要打开这些会话。
- **状态**：在役（`feature/core-patches`）。核实依据：`LEGACY_UNINTERPRETED_EVENT_TYPES` 在 `dsh-v0.1.7-rc.2` 零命中。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`dsh-v0.1.7-rc.2` 新增 V3→V4 边：未知类型的 ignorable 事件在 V4 保留为名为 `plugin:<type>` 的不透明事件。`session-format-v0-to-v1` README 中英与 `dispositions.ts` 的 JSDoc 改写为「在 V0–V3 各边原样带过并在到达 V3 时标 `ignorable: true`；V3→V4 边再把它保留为 `plugin:<type>`」。新增 `packages/session/session-format-catalog/tests/fork-historical-events.spec.ts`：以 strict + current 跑完整目录 V0→V4，断言 8 个点名类型变成 ignorable 的 `plugin:<名>`、`at-file-mention` 原样保留、`command/run` 的 `engages: false` 保留。
- **实证（按盘上语料，不是推断）**：本机 `~/.dsh` 全部 128 份日志逐份解压扫描——`permissionRules/decision` 命中 3 份，`attachment/materialized` **命中 0 份**。那 3 份的只读副本补丁前 `OPEN FAILED`、补丁后全部读回，原始文件 sha256 前后一致。语料回放另证第三条边（V2→V3）必要：`permissionRules/decision` 在纯 `upstream/master` 上被拒，只加本补丁即全部读出。
- **测试覆盖**：`session-format-v1-to-v2/tests/migration.spec.ts` 的「carries a named uninterpreted historical event into v2 with its ignorable envelope」用例按事件逐条跑 v1→v2 这条边，并用 `restoreReleasedV2Artifact` 断言被点名的类型经已安装的当前还原器的 `ignorable` 分支到达 v2 世代。它的 `carried` 数组同时列了本族的 `attachment/materialized`、`permissionRules/decision` 与 `session-format-v0-legacy-shapes` 的六种内容事件类型；测的是「按名单原样带过」这条机制，归本族。
- **提交信息订正**：本族提交信息写的「Two such types exist on this fork's disks」对 `attachment/materialized` 不成立——它在本机零命中，只会出现在触发过溢出附件的 rc.29／rc.30 用户机上。提交已推 origin、不改写历史，以本条为准。
- **路径**：`packages/session/session-format-catalog/tests/fork-historical-events.spec.ts` `packages/session/session-format-v0-to-v1/README.*` `packages/session/session-format-v0-to-v1/src/dispositions.ts` `packages/session/session-format-v0-to-v1/src/migration.ts` `packages/session/session-format-v0-to-v1/src/validation.ts` `packages/session/session-format-v0-to-v1/tests/migration.spec.ts` `packages/session/session-format-v1-to-v2/src/migration.ts` `packages/session/session-format-v1-to-v2/tests/migration.spec.ts` `packages/session/session-format-v2-to-v3/README.*` `packages/session/session-format-v2-to-v3/src/payload.ts` `packages/session/session-format-v2-to-v3/tests/legacy-uninterpreted.spec.ts`

## session-format-v0-legacy-shapes — 接住语料里仍在的三种遗留 v0 形状

- **改了什么**：`session-format-v0-to-v1` 增加两个归一化器——`permission/preset` 去掉旧构建写下的多余成员，`subagent/descriptor` 把版本 2 改写为 3——并在处置表里点名本 fork 产品线写过的六种内容事件类型。
- **为什么**：这三种形状由本 fork 发过的构建写下，v0 边拒绝它们，对应会话打不开，并连带让内容搜索全库不可用。
- **要达到的效果**：携带这三种形状的会话能打开、迁移、索引；接受面仍窄——其他多余成员、其他描述符版本、未点名的事件类型一律仍被拒绝。
- **退役条件**：上游把 `origin` 纳入 `permission/preset` 处置、为 descriptor 版本提供迁移、把这些内容事件类型纳入清单，或为迁移边提供自定义词汇扩展点，或语料里不再存在写下它们的构建的产物。
- **状态**：在役（`feature/core-patches`）。核实依据：`git show dsh-v0.1.7-rc.2:packages/session/session-format-v0-to-v1/src/dispositions.ts` 里 `'permission/preset'` 仍是 `disposition(['preset'])`、不含 `origin`；`LEGACY_SUBAGENT_DESCRIPTOR_VERSION` 在上游零命中（descriptor 版本 2→3 的迁移仍是 fork 独有）；备份 home 语料（121 份日志）里本族三种形状各自的命中：`permission/preset` 带 `origin` 11 份、`subagent/descriptor` 的 `version: 2` 4 份、六种内容事件类型里 `content/shown` 6 份（共 46 处）与 `content-surface/*` 2 份（共 40 处）。`attachment/materialized` 与 `permissionRules/decision` 虽与本族共用 `LEGACY_UNINTERPRETED_EVENT_TYPES` 这一张表，归属的是 `session-format-out-of-repo-events`，语料数字记在那一族。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：无改动，自动合并。
- **测试覆盖**：`session-format-v0-to-v1/tests/legacy.spec.ts` 让六种内容事件的迁移结果再过一遍已发布 v1 世代的校验器 `assertReleasedV1Artifact`；这些类型不在 `RELEASED_V0_EVENT_DISPOSITIONS` 里，校验器不检查它们的载荷，这一步钉住的是 v1 表头版本与连续的 seq。这六种类型经 v1→v2 边带到 v2 的断言在 `session-format-out-of-repo-events` 那一族认领的 `session-format-v1-to-v2/tests/migration.spec.ts` 里。
- **Agent Note**：[`v0-migration-legacy-shapes`](../.agents/notes/implemented/bug-fix/2026-09-07-v0-migration-legacy-shapes.md)
- **路径**：`.agents/notes/implemented/bug-fix/2026-09-07-v0-migration-legacy-shapes.*` `packages/session/session-format-v0-to-v1/README.*` `packages/session/session-format-v0-to-v1/src/dispositions.ts` `packages/session/session-format-v0-to-v1/src/migration.ts` `packages/session/session-format-v0-to-v1/tests/legacy.spec.ts` `packages/session/session-format-v1-to-v2/tests/migration.spec.ts`

## session-index-generation-identity — 派生索引身份带上 Session 世代

- **改了什么**：`session-query-sqlite` 的索引身份（`SESSION_QUERY_SQLITE_INDEX_IDENTITY`）纳入 Session 世代，世代变化时重建派生索引。
- **为什么**：重置判据只比对 schema 版本，会话格式换代后旧索引被当作仍然有效，搜索结果指向已不存在的行。
- **要达到的效果**：会话世代变化即重建索引，搜索结果与当前世代一致。
- **退役条件**：上游把世代纳入自己的索引重置判据。
- **状态**：在役（`feature/core-patches`）。核实依据：上游 `session-query-sqlite/src/schema.ts` 的 `PRAGMA user_version` 仍只比对 schema 版本。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：无改动，自动合并。上游 #4311、#4635 给历史 revision 加的后缀，在本轮 3→4 升级中会重读同一批会话，与本补丁部分重叠；是否退役留到下一轮（§9 Q16）。
- **路径**：`packages/session-query/session-query-sqlite/README.*` `packages/session-query/session-query-sqlite/src/index.ts` `packages/session-query/session-query-sqlite/src/schema.ts` `packages/session-query/session-query-sqlite/tests/sqlite.spec.ts`

## settings-navigation-groups — 设置页导航两级化

- **改了什么**：`ui-settings-general` 新增 `nav-groups.ts`（分组键闭合联合 `SettingsNavGroupKey`、固定分组表与兜底「其他」组、纯投影 `groupNavRows(rows)`）。`SettingsRoot.tsx` 用按组键取图标的 `GROUP_ICONS` 取代按分区 id 取图标的 `navIcon()`，导航栏改为「组（`role="group"` + `aria-labelledby` 指向不可点击的组标题）+ 组内成员行」两级，成员行不画图标；`SettingsRoot.module.css` 让导航可滚并加两级版式；`locales.ts` 中英各加 7 条 `nav.group.*`；`index.ts` 的分区投影改用 `entriesOfSlot(...)`，同 id 的遮蔽条目只出一行。成员行与组标题重名时改成员行文案：`general.nav` 英文 `General settings`，`ui-settings-models` 的 `nav` 英文 `Providers & models`、中文「提供方与模型」；随之改两包的 README 入口句、`docs/user/guide/{index,providers}` 的导航指引、两包 `apply.client.spec.ts` 的文案断言，以及 `apps/web/tests/` 下六个 e2e 的导航定位器。
- **为什么**：fork 的桌面组合在上游的分区之外再加七个，导航栏是一条十余项的平铺列表，`navIcon()` 只点名几个上游 id，其余全画齿轮；`.navList` 没有 `min-height: 0` 也没有 overflow，视口再矮或再多一个插件就会被静默裁掉。`settings.section` 注册项只带 `key`/`id`/`order`/`label`/`priority`，浏览器端插件收不到 cordis.yml 配置，所以分组表只能写在外壳里。
- **要达到的效果**：导航栏画六个具名分组（通用／模型／智能体／扩展／账户与用量／关于）加兜底「其他」，每组一个图标与一个不可点击的组标题；分区 id、`order`、label、`openSection(id)` 入口不变。被点名的分组按表内顺序排成员，成员全缺席的分组不画，表中未点名的 id 按账本顺序留在「其他」，没有分区会因为不被认识而消失；导航超高时自行滚动。
- **退役条件**：上游让 `settings.section` 注册项自带分组或图标，或外壳自己长出分组、图标或导航滚动——对应部分退役，fork 适配上游形式。核实：`git grep -l navGroup <tag> -- packages/client/ui-settings-general` 零命中，且上游 `SettingsRoot.module.css` 的 `.navList` 块里没有 `overflow-y`／`min-height`（只看这一块，`.options` 本来就带这两条）。
- **状态**：在役（`feature/core-patches`）。核实依据：`navGroup` 在 `dsh-v0.1.7-rc.2` 的 `ui-settings-general` 零命中。回补时适配三处：① 基座新增的 `archived-sessions` 设置页放进「通用」组、排在 `at-file` 之后（develop 的分组表没有收录它，否则会落进「其他」；放哪一组待拍板，这里取默认）；② 基座给 `archived-sessions` 行配的 `IconArchiveOutline20` 随 `navIcon()` 一起让位给组图标；③ 基座新增的 `deepseek-messages-settings.e2e.ts` 的导航定位器跟着改名。`settings-chrome.e2e.ts` 里插件页的断言保留本基座的写法（单一贡献直接显示页面、无标签行），只把模型行的名字换成新名。受影响的 ARIA 金样在并入 `dsh-v0.1.7-rc.2` 之后统一重录（见下）。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：五处。① 上游新增账号设置页（`ui-settings-account`，id `account`，order −10，上游 PR #4475），分组表把它排进 `account` 组、在 `balance` 之前（§9 Q3 默认）；上游 `settings-root` spec 的账号启动器用例原先断言行按钮带图标，改为断言账号行在「Account & usage」组内、组标题带图标。② 上游新增的四个 web e2e 按旧行名点击：`bonus-notice.e2e.ts`（上游 PR #5040）、`onboarding-native.e2e.ts`（上游 PR #4475）、`settings-appearance.e2e.ts`（上游 PR #5030）的「模型」改成「提供方与模型」，`agent-preset-selection.e2e.ts`（上游 PR #5108）的「General」改成「General settings」；简报只列了前三个文件，`settings-appearance` 是本轮实测补上的。`onboarding-native` 的该用例在 macOS 本机先失败在第 67 行（账号菜单的「设置」项带出 `⌘,` 快捷键提示，上游只给 `web:linux` 以外的平台配了 `settings.open` 默认键），与本族无关，本族改的第 91 行只能由 Linux CI 验证。③ 合并把上游加在旧 `.navList` 块上的 `overflow-y: auto` 带进了本族的 `.navGroup`，各组自行滚动、导航栏永不溢出，上游 `settings-chrome` 的短视口用例因此失败；已删掉该行，CSS spec 断言 `.navGroup` 不声明 `overflow-y`。④ `SettingsRoot.tsx` 以上游为底接回两级分组，把上游的 `data-modal-autofocus` 加到组内按钮上。⑤ 18 份设置页 ARIA 金样按两级导航重录。
- **滚动同步注意**：client-UI 补丁，落点 `ui-settings-general` 的 `SettingsRoot.tsx`、`SettingsRoot.module.css`、`index.ts`、`locales.ts`、`nav-groups.ts`，以及 `ui-settings-models/src/client/locales.ts` 的 `nav` 中英两行；与 `settings-trigger-action-seat` 同文件，两族一起移植、一起核实。`dsh-v0.1.7-rc.2` 新增 `settings.launcher` 与账号页（`ui-settings-account`），账号页默认进 fork 的 `account` 组；上游把「开发者工具」改名「代码工作工具」，取上游文案，`nav.group.*` 保留。
- **Agent Note**：[`settings-navigation-groups`](../.agents/notes/implemented/feature/2026-09-14-settings-navigation-groups.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-14-settings-navigation-groups.*` `apps/web/tests/agent-preset-selection.e2e.ts` `apps/web/tests/bonus-notice.e2e.ts` `apps/web/tests/deepseek-messages-settings.e2e.ts` `apps/web/tests/models-settings-recovery.e2e.ts` `apps/web/tests/models-settings.e2e.ts` `apps/web/tests/onboarding-deepseek-config.e2e.ts` `apps/web/tests/onboarding-native.e2e.ts` `apps/web/tests/onboarding-usable-provider.e2e.ts` `apps/web/tests/settings-appearance.e2e.ts` `apps/web/tests/settings-chrome.e2e.ts` `docs/user/guide/index.*` `docs/user/guide/providers.*` `packages/client/ui-settings-general/README.*` `packages/client/ui-settings-general/src/client/SettingsRoot.module.css` `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` `packages/client/ui-settings-general/src/client/index.ts` `packages/client/ui-settings-general/src/client/locales.ts` `packages/client/ui-settings-general/src/client/nav-groups.ts` `packages/client/ui-settings-general/tests/apply.client.spec.ts` `packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` `packages/client/ui-settings-general/tests/shell.client.spec.ts` `packages/client/ui-settings-models/README.*` `packages/client/ui-settings-models/src/client/locales.ts` `packages/client/ui-settings-models/tests/apply.client.spec.ts`

## settings-trigger-action-seat — 设置触发行右端的同行贡献位

- **改了什么**：`ui-settings`／`ui-settings-general` 在设置触发行右端开一个同行贡献位（`settings.trigger.action`），并给它一个打开设置面板的 opener；触发行自己拥有该贡献位所在的 hover 面。
- **为什么**：仓外插件要在设置行右端放一个自己的动作，没有任何槽位可用。
- **要达到的效果**：插件在设置行右端占位，hover 表现与该行一致。
- **退役条件**：上游在设置触发行提供等价贡献位，或 fork 改用上游桌面外壳、不再需要那个更新按钮插件。
- **状态**：在役（`feature/core-patches`）。核实依据：`settings.trigger.action` 在 `dsh-v0.1.7-rc.2` 零命中。`core-patches-v11` 那一轮适配一处上游改动：上游在同一行的 `ConnectionIndicator` 之后放了自己的 `DesktopUpdateIndicator`（上游 PR #4033），本族的贡献位改排在它之后，两者同行共存。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游重写快捷键与设置启动器（上游 PR #4891、#4938、#5117、#4475）：`SettingsRoot.tsx` 以上游为底，本族的 `<div className={css.triggerActions}>{renderSlot('settings.trigger.action', { wide, openSection })}</div>` 插在 launcher／Tooltip 之后，`openSection` 仍来自 `actions`；`ui-settings-general/src/client/index.ts` 上游改为闭包，本族的 `settings.trigger.action` 子位接在其中。上游新增的圆角门禁（上游 PR #5030）拒绝不在主题 token 上的圆角，触发行的 `12px` 改为 `var(--dsw-radius-md)`。
- **滚动同步注意**：这是 client-UI 补丁，每轮都要重新移植并重新核实。两处会撞行：`SettingsRoot.tsx` 传给本位的 `openSection` 与 onboarding 位共用同一个 `useCallback`，上游改那段时两处一起看；宽行的悬停面落在 `SettingsRoot.module.css` 的触发行选择器上，上游改触发行悬停样式会与它撞。`slot-catalog.ts` 是生成物，冲突时取上游侧后重跑 `pnpm run gen-client-catalog`。
- **Agent Note**：[`settings-trigger-action-slot`](../.agents/notes/implemented/feature/2026-09-11-settings-trigger-action-slot.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-11-settings-trigger-action-slot.*` `docs/subsystems/slots.*` `packages/client/ui-settings-general/src/client/SettingsRoot.module.css` `packages/client/ui-settings-general/src/client/SettingsRoot.tsx` `packages/client/ui-settings-general/src/client/index.ts` `packages/client/ui-settings-general/src/client/shell-contract.ts` `packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` `packages/client/ui-settings-general/tests/shell.client.spec.ts` `packages/client/ui-settings/src/client/contract/slots.ts` `packages/client/ui-settings/src/client/index.ts`

## stats-usage-pill-seats — 会话 Token 用量药丸上的文案位与明细行位

- **改了什么**：`ui-chat` 的 `contract/slots.ts` 新增会话作用域的 single 槽 `conversation.chat.stats.usageLabel` 与 list 槽 `conversation.chat.stats.usageRows`，以及两者共用的 owner props `StatsUsageOwnerProps`（`totalTokens`、`cacheHitPercent`），`index.ts` 再导出该类型；`apply.ts` 的 `conversation.composer.dock` / `stats` 注册项用 `children` 声明这两个子位；`StatsPills.tsx` 把药丸文案开头那一段交给 `usageLabel`（空位时 fallback 为 token 总量），在弹层 `dl[data-session-stats-usage]` 的 output 行之后渲染 `usageRows`，删掉用量按钮的 `aria-label`，两颗药丸的分隔符去掉 `aria-hidden` 并自带前后空格。`docs/subsystems/slots.{md,zh.md}` 的声明树各加两行，`slot-catalog.ts` 由 `gen-client-catalog` 重生成。
- **为什么**：fork 的余额插件要把金额显示在输入框下的 token 读数里。`conversation.composer.dock` 是纵向排列的会话作用域 list，占位者只能在统计药丸下方自成一行；画出两枚药丸的 `stats` 条目不声明 children，想进药丸或弹层只能整体遮蔽 `stats`，接管随产品发布的时间药丸、用量药丸与两个弹层。槽名是上游 `SlotMap` 的声明合并键，渲染点在上游组件里，插件层做不到。
- **要达到的效果**：插件注册两个条目即可把金额放进药丸文案开头、把花费行追加进弹层明细，不替换任何随产品发布的 chrome；无人占位时药丸与弹层与改动前逐字相同（可访问名由可见文案给出，读作 `105 tok · Cache hit 90%`，与上游原 `aria-label` 字符串相同）。两个位拿到的是药丸自己算出的精确总量与裸百分数。
- **退役条件**：上游以任何形式在统计药丸或其弹层上开出等价贡献位。
- **状态**：在役（`feature/core-patches`）。核实依据：`conversation.chat.stats` 在 `dsh-v0.1.7-rc.2` 零命中。分隔符变成可读文本后，`snapshots/web/**` 与 `apps/web/tests/expected/**` 里两颗药丸的 ARIA 金样要重录；回补阶段没有拣 develop 上的两条金样重录提交，金样在并入 `dsh-v0.1.7-rc.2` 之后统一重录（见下）。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游给统计药丸加了性能与用量的显示偏好（上游 PR #4478）：`StatsPills.tsx` 的 props 类型写成 `InjectFace<PerformanceUsageInjected> & {…} & PropsRenderSlots<…>`，`chat-stats` spec 用上游的 `usePerformanceUsage` 加本族的多行字段；`chat-branch-tails`／`gate-branch-tails` 两份 spec 取上游 import 并保留 `type StatsPillsProps`。47 份 web 金样按可读分隔符重录（药丸的可访问名读作 `16K tok · Cache hit 98%`）。
- **滚动同步注意**：client-UI 补丁，落点 `ui-chat` 的 `contract/slots.ts`、`apply.ts`、`chat/StatsPills.tsx`，上游改药丸标记、弹层明细或 chat 槽契约都会撞行。`slot-catalog.ts` 冲突时取上游侧后重跑 `pnpm run gen-client-catalog`。
- **Agent Note**：[`stats-usage-pill-seats`](../.agents/notes/implemented/feature/2026-09-14-stats-usage-pill-seats.md)
- **路径**：`.agents/notes/implemented/feature/2026-09-14-stats-usage-pill-seats.*` `docs/subsystems/slots.*` `packages/client/ui-chat/src/client/apply.ts` `packages/client/ui-chat/src/client/chat/StatsPills.tsx` `packages/client/ui-chat/src/client/contract/slots.ts` `packages/client/ui-chat/src/client/index.ts` `packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx` `packages/client/ui-chat/tests/chat-stats.client.spec.tsx` `packages/client/ui-chat/tests/gate-branch-tails.client.spec.tsx`

## user-message-action-seat — 用户消息上的贡献位

- **改了什么**：`ui-conversation` 在用户消息上开一个贡献位（`conversation.chat.user-actions`）与对应的 `renderUserActions` 传参。
- **为什么**：仓外插件要在用户消息旁放自己的动作（例如引用该消息），没有槽位可用。
- **要达到的效果**：插件在用户消息上占位；无占用者时渲染不变。
- **退役条件**：上游在用户消息上提供等价贡献位。
- **状态**：在役（`feature/core-patches`）。核实依据：`conversation.chat.user-actions` 与 `renderUserActions` 在 `dsh-v0.1.7-rc.2` 零命中。`core-patches-v11` 那一轮适配两处上游改动：`ChatView` 把节点列表包进 `MarkdownDelegateProvider`（上游 PR #4379），`renderUserActions` 随 `ChatNodeList` 一起进了那层包裹；`TurnTailNodeView` 的 `renderSlotChain` prop 被上游删除（上游 PR #4414），本族测试台里那条随之删除的桩不再重建。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：`chat-branch-tails.client.spec.tsx` 的 props 断言恢复为上游逐 token 相同的写法，`renderUserActions` 在断言之外展开，基座 baseline 登记的那条强转照旧命中（上游 PR #4610）。
- **Agent Note**：[`user-message-action-slot`](../.agents/notes/implemented/feature/2026-08-24-user-message-action-slot.md)
- **路径**：`.agents/notes/implemented/feature/2026-08-24-user-message-action-slot.*` `packages/client/ui-chat/src/client/apply.ts` `packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx` `packages/client/ui-chat/src/client/chat/ChatView.tsx` `packages/client/ui-chat/src/client/chat/MessageItem.tsx` `packages/client/ui-chat/src/client/contract/slots.ts` `packages/client/ui-chat/src/client/index.ts` `packages/client/ui-chat/tests/chat-branch-tails.client.spec.tsx` `packages/client/ui-chat/tests/chat-view.client.spec.tsx` `packages/client/ui-workflow-run/tests/workflow-run.client.spec.tsx`

## workspace-gate-private-apps — 工作区门禁看见不发布的 app

- **改了什么**：`scripts/check-workspace-constraints.ts` 与其 `.spec.ts` 给 `apps/*` 引入 private／发布成员两种类别（`isPrivateApp`、`checkPrivateAppManifest`），并让 `checkDshFamilyVersion` 对私有 app 跳过共享版本校验。
- **为什么**：本 fork 在 `apps/*` 下有只随客户端构建分发、从不发到 npm 的产品装配，却被当成发布成员校验，四条发布元数据规则同时落空；上游自己只按名字排除了它自有的两个目录，覆盖不到 fork 的目录。私有 app 带的是各自的产品发行版本（桌面更新源与已安装外壳据以比对的那一个），不能由 dsh 家族共享版本占有。
- **要达到的效果**：`apps/*` 下未发布的产品装配通过门禁，同时仍受工作区卫生规则约束；判别只靠 `private: true` 一个布尔字段。
- **退役条件**：上游的 `check-workspace-constraints.ts` 自己区分 `apps/*` 下未发布的私有产品装配与发布成员，或 fork 不再拥有此类目录。
- **状态**：在役（`feature/core-patches`）。核实依据：`isPrivateApp` 在 `dsh-v0.1.7-rc.2` 零命中。`core-patches-v11` 那一轮适配一处上游改动：上游自己的 `check-workspace-constraints.spec.ts` 也导入了 `checkWorkspaceManifest`，变基把两份导入表并了起来，本族只保留自己新增的 `checkPrivateAppManifest`。
- **本轮适配（`dsh-v0.1.7-rc.2`）**：上游在 `check-workspace-constraints.ts` 加了 shortcuts 的 files 规则（上游 PR #4891），自动合并；`.spec.ts` 冲突块合并头注释，保留上游两例与本族那一段。
- **Agent Note**：[`private-apps-are-not-release-members`](../.agents/notes/implemented/process/2026-08-20-private-apps-are-not-release-members.md)
- **路径**：`.agents/notes/implemented/process/2026-08-20-private-apps-are-not-release-members.*` `scripts/check-workspace-constraints.spec.ts` `scripts/check-workspace-constraints.ts`

## legacy-preset-alias — 遗留 `code` 预设 id 解析为 `ptc`

- **改了什么**：`packages/preset/agent-presets` 新增 `LEGACY_PRESET_IDS` 与 `rosterIdFor`，在没有任何根提供 `code` 时把它解析为 `ptc`；别名只按自有键查找，查找是全函数。
- **为什么**：上游把 `code` 预设改名为 `ptc`（上游 PR #3074）并只保留会话持久化词汇，落在设置默认值、已恢复会话与切换动作里的 `code` 因此指向不存在的预设。
- **要达到的效果**：旧设置与旧会话继续解析到同一个预设；有根提供 `code` 时别名让位给该根。
- **退役条件**：上游自己为改名前的预设 id 提供别名解析，或语料里不再存在 `code`。
- **状态**：退役（`feature/core-patches`，随 `dsh-v0.1.7-rc.2` 合并）。两条依据：上游 PR #4569 把 Agent 组合改为在 profile YAML 里声明，删掉了本补丁的落点 `packages/preset/agent-presets/src/index.ts` 与 `tests/settings.spec.ts`；日志侧 `code`→`ptc` 的改写已在上游的 v2→v3 迁移里。

## llm-response-format — 请求上的 JSON 应答格式

- **改了什么**：`GenerateOptions.responseFormat?: { type: 'json_object' }`；`llm-deepseek` 在 chat-completions 协议上映射成 `response_format`；`llm-pi-ai` 以 `UNSUPPORTED_OPTION` 拒收；agent-loop 不变式要求 loop 请求不带它。
- **为什么退役**：上游 #4629 把官方 DeepSeek 适配器改成只走 Messages，并删掉了 `packages/llm/llm-deepseek/src/protocols/**`；harness 的 Messages 请求类型里没有 JSON 模式字段，这一族在新基座上没有落点。判官改用 `llm-tool-choice` 的强制工具调用。
- **退役条件**：已退役。
- **状态**：退役（在 `feature/core-patches` 以 `dsh-v0.1.7-rc.2` 为基座的这一轮退役；它从未进入 v11 线，最后一次随包是 `desktop-v0.1.0-rc.33`，当时的台账留在该 tag 的 `.claude/core-patches.md`）。

## attachment-text-file-kind — 持久附件缝的文本文件种类

- **改了什么**：曾给 `packages/attachment` 增加与图片平行的文件类型族与 `AttachmentStore` 的文件准入／保存／读回方法。
- **为什么**：标准 harness 没有非图片附件通路，第三方插件把文件当原始文本拼进草稿，绕过已有的持久、内容寻址服务边界。
- **要达到的效果**：文本文件像图片一样经服务边界准入、按内容寻址持久化、可按引用重新读取校验。
- **退役条件**：上游为 `@deepseek-ai/dsh-attachment` 添加镜像图片的文件准入与存储服务边界。
- **状态**：退役（在 `core-patches-v7` 上退役，上游 PR #3109 通用文件上传）。核实依据：上游 `packages/attachment` 的文件对象只读写 `file-objects/` 与 `files/` 两棵树，`attachments/v1/objects/` 下的文件对象不在任何读路径上。与我方实现的差异：上游不做文本嗅探、不设限额、按 verbatim 存任意字节，文件对象落在两棵新树而不是与图片共用的对象树。
- **已知破坏性变化（rc.28–rc.30 发出的构建）**：我方实现把文件对象写在 `attachments/v1/objects/`，上游只读 `file-objects/` 与 `files/` 两棵树，因此那两个版本写下的文件附件在 `core-patches-v7` 及其后的基座上**一律读不回来**。2026-09-05 决定**不做读侧回退**：受影响的只有文件附件这一条通路，日志与图片照常，而回退要在上游的存储实现里再加一棵历史树。`session-export-unreadable-entries` 的通用文件半边正是为这批会话仍能整包导出而做。

## llm-file-attachments — 文件附件上线、入日志、进请求

- **改了什么**：曾给 `llm` 与 host 代理增加文件内容块、准入参数与请求期装配。
- **为什么**：文件附件必须像图片一样可重建——日志里有引用、请求期按引用取回。
- **要达到的效果**：文件附件在会话日志里以引用存在，模型请求由引用装配。
- **退役条件**：上游为文件附件提供等价的线上／日志／请求期通路。
- **状态**：退役（在 `core-patches-v7` 上退役，上游 PR #3109）。上游 `ContentBlockMap['file']` 与我方结构相同。

## composer-file-drafts — composer 草稿里的文本文件

- **改了什么**：曾给 `ui-conversation`／`ui-attachment` 增加把文本文件作为 composer 草稿附件的通路。
- **为什么**：没有这条通路，用户只能把文件内容粘成正文。
- **要达到的效果**：文件以草稿附件形式进入消息。
- **退役条件**：上游提供等价的 composer 文件草稿通路。
- **状态**：退役（在 `core-patches-v7` 上退役，上游 PR #3109，`packages/client/file-upload` 提供 HTTP 上传路由与客户端后台上传运行时）。

## composer-file-chip — composer 文件 chip 与尺寸文案

- **改了什么**：曾对齐 composer 文件 chip 与输入栏，并按 B／KB／MB 格式化尺寸。
- **为什么**：chip 与行不对齐、尺寸没有可读格式。
- **要达到的效果**：chip 与输入栏对齐，尺寸可读。
- **退役条件**：上游自带文件卡与混合附件呈现。
- **状态**：退役（在 `core-patches-v7` 上退役，上游 PR #3109 的 `FileCard` 与混合附件呈现；`ui-primitives` 自带 `fileSizeText`）。

## attachment-spill-oversized — 超限文件附件溢出而不截断

- **改了什么**：曾让超过限额的文件附件溢出到可读路径句柄而不是截断正文。
- **为什么**：截断把文件中段悄悄丢掉，模型看到的是不完整且无标记的内容。
- **要达到的效果**：超限文件不进正文，模型拿到可读路径。
- **退役条件**：上游对超限文件采取等价处理。
- **状态**：退役（在 `core-patches-v7` 上退役，上游 PR #3109 的 `projectFilesToText` 把文件降级成可读路径句柄、从不内联正文）。

## ui-attachment-build-purity — 附件族的构建纯净度与装配快照文案

- **改了什么**：曾修复 `ui-attachment`／`web` 的一处构建纯净度缺陷与一处过时的装配快照文案。
- **为什么**：缺陷与文案都属于文件附件族。
- **要达到的效果**：构建纯净、快照文案与实际装配一致。
- **退役条件**：随文件附件族整体退役。
- **状态**：退役（在 `core-patches-v7` 上随 `attachment-text-file-kind` 一族退役）。

## storage-json-legacy-bootstrap — 按同版本遗留文件引导每记录单元

- **改了什么**：曾让 `storage-json` 只从同版本的遗留文件引导每记录单元。
- **为什么**：跨版本引导会把不同格式的记录混进同一个单元。
- **要达到的效果**：引导只发生在版本相同时。
- **退役条件**：上游采取等价判据。
- **状态**：退役（在 `core-patches-v6` 上退役，结论不变，自 `0.1.3-alpha.1` 起未再移植）。
- **退役依据**：上游在同一个 `bootstrapLegacyUnit` 里加了 `acceptedStamps` 判据（上游 PR #3431、#3438）——当前版本加包属主显式声明的 `compatibleVersions`——是我方「必须同版本」的**超集**（同版本照旧引导，异版本默认不引导，另允许属主把特定旧版本声明为可读）；测试等价覆盖逐条核过，无缺口。上游方案还更优：保留我方补丁会让旧版本用户升级后丢掉全部投影缓存标题。
- **为什么当初要做（真机故障链）**：rc.22 的家目录升到 rc.27 后，旧单文档里的记录被原样复制成当前版本的记录文档 → `storage-domain.open` 按新 schema 逐条校验抛错 → session-projection-cache 初始化失败 → 服务端拒启 → 桌面停在 startup failed。

## rescope-exact-edits — 重新锚定两处 rescope 精确编辑

- **改了什么**：曾把两处 rescope 脚本的精确编辑重新锚定到当时的上游树。
- **为什么**：锚点随上游文件变动而失配。
- **要达到的效果**：rescope 脚本在当时的基座上可跑。
- **退役条件**：上游改写该脚本或锚点不再存在。
- **状态**：退役（在 `core-patches-v2` 上退役，结论不变，自 `0.1.3-alpha.1` 起未再移植）。
- **退役依据**：在新基座上不重落本补丁、直接跑 `pnpm run rescope-vendor:check`，结果为 `post-state verified — no residue, every exact edit landed, idempotent`；上游区间内有 4 个提交碰过该脚本，`EXACT_EDITS` 表里旧的 `packages/util/home` 锚点随之消失，对应的是上游移除 Knip，中文 vendoring cookbook 链接锚点也已由上游自己修正。

## file-part-bubble-card — 消息气泡里的文件分片卡

- **改了什么**：曾新增 `FileCard.tsx`，由用户气泡与 Assistant block 直接内联渲染 `{kind:'file'}` 分片；点击先派发 `referent/open`，落空后切换内联展开/收起，经新增的 `loadFile`／`ISession.readFile`（对偶于既有的 `loadImage`／`readAttachment`）惰性抓取文本；`event-projection` 增 file 分支，宿主侧增 `session.file` 回读 RPC 与 `loadFile` 的失败错误码。
- **为什么**：文件分片已经上了 wire、日志与请求物化，也进了 composer 草稿，但已发送的文件分片在消息气泡里完全不渲染。
- **要达到的效果**：文件分片与图片分片一样在消息流里可见、可展开读回原文。
- **退役条件**：上游自己的会话 UI 原生渲染文件内容分片。
- **状态**：退役（在 `core-patches-v7` 上退役）。本条与 `referent-open-seam` 原是同一条补丁的两半：缝那一半在役、另立记录，文件气泡卡这一半连同 `session.file` 回读 RPC 与 `loadFile` 失败码两条随附提交一并不移植；`ReferentRef` 上那个只服务文件卡的 attachment 字段随其唯一生产者删除。**依据订正**：原先写的「上游 PR #3109 的 `FileCard`」认错了对象——`packages/client/ui-attachment/src/FileCard.tsx` 是 composer 里的上传卡；已发送消息里的文件 chip 是 `packages/client/ui-chat/src/client/chat/MessageItem.tsx` 里 `css.fileCard` 那个 span，它让已发送的文件在用户气泡里可见，但没有 onClick，也没有回读 RPC。
- **待重做**：「点击 → `referent/open`、内联展开、惰性读回原文」这一半上游没有覆盖。本条一行代码都没有，新门禁下 `局部退役` 必须认领至少一个差异路径，所以状态仍写 `退役`（偏离复核的局部退役改判，§9 Q19 默认）。重做要在上游的 `file-objects/` 和 `files/` 两棵树上新写回读 RPC；rc.29／rc.30 写下的旧文件对象救不回来。

## clickable-reference-architecture-note — 三层可点引用架构的 Agent Note

- **改了什么**：曾有一份描述三层可点引用架构的 Agent Note。
- **为什么**：该架构横跨多个补丁，需要一处记录。
- **要达到的效果**：读者从一处看懂 nominate／verify／open 三层如何分工。
- **退役条件**：落地的每条缝各自带 Note。
- **状态**：退役（在 `core-patches-v2` 上撤回，其后各轮均未重落）。该记录已拆进 `referent-open-seam` 与 `chat-prose-referents` 各自的 Note，本条不再单独存在。

## secret-container-confirm — 添加位于已知密钥容器内的文件时确认

- **改了什么**：曾新增 `secret-container.ts`——**纯名称/路径启发式判定，零内容读取**；composer 对文件草稿按已知密钥容器匹配（名称类 `.env`、`id_rsa`、`*.pem`；路径段类 `/.ssh/`、`/.aws/`），命中即弹两键确认。芯片进入**持续警示态**（描边 + 圆点 + 行内标签 + 行下方带「移除」的提示）。宿主侧另有一个**只可追加**的 `secretContainerExtraPatterns` 会话投影供部署扩充，基础名单从不上这根线。确认时机是**添加时按批**，不是发送时——发送时确认是被推翻的第一版设计。
- **为什么**：用户可能在不经意间把凭据文件作为附件发出。
- **要达到的效果**：此类文件在**加入草稿**时需要一次显式确认；「不添加」只撤销本批命中的子集，「仍要添加」是纯关闭；发送路径上不再二次追问。
- **退役条件**：上游自带等价的添加时密钥容器确认（同款零内容读取、名单可追加，覆盖警示态文案与芯片布局）。
- **状态**：退役（在 `core-patches-v7` 上随文件附件族退役，线上无提交）。
- **待重做（第二片）**：上游无对应物、产品价值仍在，但整个挂载点（composer 文件草稿）已随文件附件族在 `core-patches-v7` 上退役，重做的挂点是 `InputBar.tsx` 的 `intakeFiles` 里、`addFiles` 调用之前（上游 PR #3109 的 `file-upload` 通路）。同族的另两条改动（确认时机从发送时移到添加时；Config 断言不再架空自己的注解）一并押后。

## 历史轮次

本线由 `core-patches-v1` 起逐轮变基而来，到 `core-patches-v11` 为止；此后改为合并上游发布。变基那些轮次的提交清单随变基作废，不在此登记；下面只留**今天仍然有效**的事实——重复踩会付代价的那些。删掉它们曾让这些事实在全仓没有第二个归宿。

### 只活在 develop 的核心路径改动

下面三处改动碰的是核心路径，却不登记成 slug 记录：它们要么只服务 fork 的产品外壳，要么应当离开核心路径，不随本线同步。

- **fork 产品门禁一族**：桌面外壳需要的门禁并集段、几个新增脚本文件和 electron-updater 补丁。它们只在 develop 上，按 develop 合并时的 allowlist A 处理：并集文件取本线的版本，再加上且只加上为该文件列出的 fork 段。其中新增的文件宜迁到 `apps/desktop-shell/` 下，迁走后就不再碰核心路径。
- **`docs/cookbook/adding-a-tool` 里的「How your tool reaches the model」一节**：迁到 fork 自有文档 `.claude/tool-copy-rules.md`，`.claude/CLAUDE.md` 的链接改指过去，核心文件回到本线的版本。
- **上游 Note `2026-08-18-session-history-and-event-transport` 里删掉的那一句**：develop 回到本线的版本。订正本身成立（上游的 `packages/` 里已经没有 `HostFrame`），应当作为 PR 提给上游，而不是作为补丁留在 fork。

develop 台账里 rc.26–rc.33 的集成审计、gateway 和 vendoring 历史不搬进本文件：那份台账含大量本仓提交哈希，`verify-repository-references` 不允许它们出现在维护中的文件里。需要时用 `git show desktop-v0.1.0-rc.33:.claude/core-patches.md` 取回。

### 基座环境敏感的稳定红（不修，仅记录）

`core-patches-v2` 那一轮的全仓 `pnpm run test` 扫出三项稳定红，与任何补丁提交无关（三次独立复现——全量套件、去沙箱、单文件隔离跑——结果完全一致，不是抖动）：

- `scripts/benchmark-npm-resolution.spec.ts` › `force-kills a timed-out process tree`：`child reported invalid pid`，子进程树 PID 上报在该宿主上不可见。
- `scripts/oxlint-contract.spec.ts` › `preserves successful fix output channels`：`NO_COLOR`/`FORCE_COLOR` 冲突产生的 Node 子进程告警泄漏进 stderr。
- `packages/spill/spill-local/tests/spill-local.spec.ts` › `keeps a file exactly at the boundary`：mtime 边界精度断言失败。

三项的共同性质是**宿主环境特征**（进程 PID 可见性、子进程环境变量继承、文件系统 mtime 精度），不是代码逻辑。**决定：不修，只记录**，留待换宿主／CI 环境重验，再判断是否要改测试自己的环境假设。另有一项真抖动：`locale-dictionary-parity.spec.ts` 与 `oxlint-contract.spec.ts` 并行时往同一个真实源码目录写临时文件。

### 两次重落前风险预审的结论

- **上游 PR #3339（remove SQLite persistence backend）——可继续。** `SESSION_FORMAT_VERSION` 全程未 bump；被删的 `session-persistence-sqlite` 是产品从未使用的候选后端（`packages/bundle/base/cordis.patch.yml` 一直只挂 `session-persistence-jsonl` 作真正的会话日志存储，SQLite 只服务 `session-query-sqlite` 这个派生检索索引），对已落盘的会话文件零影响。fork 自有的事件登记机制未被该 PR 触及。
- **上游 PR #3346（distinguish event seqs from log offsets）——可继续。** 落盘格式其实未变：JSONL 物理头行仍原样携带可选数字 `seedLength`，读时翻译成内存态、写时翻译回去，两道硬拒作用于内存态 header 而非磁盘行；`SessionSeq`/`SessionLogOffset` 是 `dsh-brand` 的编译期品牌，运行期不改变任何值。用旧代码树的生产写路径写出真旧日志实测确认。

### 每轮都适用的做法

- **冲突解决**：生成物（`slot-catalog.ts`、`api-catalog.ts`、`docs/` 下的目录）一律取上游侧后重跑对应 `gen-*`，从不手改；双语文档取并集或按上下文合并措辞；**从不用 `git checkout --ours/--theirs` 整文件覆盖**。
- **退化条款**：上游改了同一处，我方补丁就退役去适配，而不是把补丁改得更复杂去共存。
- **并集的陷阱**：冲突一侧为空、我方侧有内容时，取并集会把**已死**的内容带回来——上游删掉某段的唯一消费者时正是如此。取并集前先确认我方那几行今天还有读者。
- **三方核对脚本的已知盲区**（下一轮若要再用，先补这四条）：它只看「两父都保留而结果丢失」的行，所以「只在一个父里有、另一个父已删除、却出现在结果里」的行不判违规——上一条说的死内容正是从这个口子进来的；结果里缺失的文件只报 SKIP 不判违规；抑制注释正则不含 `TODO|FIXME|XXX`；行频提示在父计数为 0 时会刷屏。
- **覆盖率陷阱**：不带 `--coverage.include` 直接跑单包会退出码 1——插桩范围是全工作区，本包测试够不到的文件一并计入。圈定被改包再跑。
- **冷构建陷阱**：被上游删掉的包目录会残留只含 `node_modules/` 的孤儿目录，tsdown 的 workspace glob 命中后向上找到仓库根，`pnpm run build` 冷跑报 `Cannot find entry`；残留的旧 `lib/` 还会让 tsdown 报 `MISSING_EXPORT`。`pnpm run clean` 再 `pnpm install`；`dsh-v0.1.7-rc.2` 上 `pnpm run clean` 自己因 `lib/desktop-keyboard-test-types` 的 outDir 检查报错，改为手删只含 `lib/`、`node_modules/` 的孤儿目录。

### 旧会话可读性预审（每轮移植前必做）

在**纯 `upstream/master`** 树上，对 `~/.dsh/sessions` 与备份 home 的**只读副本**逐份冷读（`JsonlSessionPersistence.open(id, 'read').read()`，与派生索引观测走同一条路），记下拒读份数与每类拒读原因；移植后同法复测，逐条对应到是哪条补丁清掉了哪一类。`core-patches-v8` 那轮的读数是：纯上游 127/139 与 96/121，五类拒读原因；三条会话格式补丁逐条叠加后 139/139 与 121/121，零拒读；两库共 281 个 `.zstd` 文件在全部回放之后 sha256 逐一未变（读路径只在内存里迁移）。**副本永远放 scratch，绝不对真实 home 做写操作。**
