# core-patches 补丁登记

本文件登记 `core-patches` 线上的每一个补丁族。新增、修改、退役补丁时必须同步更新本文件。

**当前补丁线**：`core-patches-v10`。

**基座合并**：#4192

上面这行是门禁读的基座声明：本线坐落在上游合并 `#4192` 的那个提交之上，门禁在 HEAD 自己的历史里解析它（以 `Merge pull request #4192 ` 开头的 merge 提交必须恰有一条），不读任何远端跟踪引用。该基座是上游 `0.1.6-alpha.1` 之后的第 5 个提交；release tag `dsh-v0.1.6-alpha.1` 只是它的祖先，**不等于基座**——按该 tag 取基座会少 5 个提交、得到另一棵树。本线由 `core-patches-v9` 变基而来：v9 的 92 个提交里 91 个落地、1 个退役（见 `referent-target-probe`），其后是本轮新增的提交。

## 身份规则

**补丁身份是 slug，不是提交哈希。** 每个补丁族有一个 kebab-case slug，全线唯一、稳定，由补丁标题派生。同一族的多个提交共用一个 slug。

**每个提交带一条 `Patch: <slug>` trailer。** 提交哈希不能承载身份：每轮滚动同步都把整条线变基到新的上游基座，全部哈希随之作废；上游的 `verify-repository-references` 也拒绝在维护中的散文里出现能解析成本仓提交的十六进制串。trailer 与 slug 是提交信息文本，变基后原样存活。

**门禁**：`pnpm run verify-core-patches`（`scripts/verify-core-patches.ts`，已登记进 `doc-sync`）双向核对本文件与「声明的基座合并`..HEAD`」，九类违规：`trailer-count`（提交的 `Patch:` trailer 不是恰好一条——按 git 自己的 `%(trailers:key=Patch)` 读，因此必须落在提交信息的最后一段）、`malformed-trailer`（trailer 的值不是 slug：git 的 trailer key 匹配大小写不敏感、值也来者不拒，`Patch: alpha seam` 与折行续写出来的值 git 都收，slug 格式只能由本门禁把关）、`merge-commit`（补丁线必须线性）、`unregistered-slug`（提交点名的 slug 本文件未登记）、`unused-active-slug`（在役或局部退役的 slug 线上无提交）、`retired-slug-in-use`（退役的 slug 线上仍有提交）、`duplicate-slug`、`missing-status`、`malformed-heading`（`## ` 标题既不是记录格式、也不是 `身份规则`／`历史轮次` 之一——标题解析失败会让整条记录连同它的检查一起蒸发，所以标题本身是违规）。

**门禁的执行面与后果**：**skip（退出 0）只有两种**——checkout 不在本文件声明的补丁线上（`develop`、集成线、detached HEAD），或本检出是浅克隆（截断的历史够不到声明的基座合并）；分支这条判在前。**failed（退出 1）** 是其余一切，且不分分支：本文件读不到、`**当前补丁线**` 或 `**基座合并**` 声明不是恰好一条（围栏代码块里的示例既不算记录也不算声明）、声明的基座合并在 HEAD 的历史里零条或多条、任何一条 git 命令失败（一行诊断，不抛栈），以及九类违规本身。**后果**：本门禁不读任何远端跟踪引用，因此不再要求维护者本机配过 upstream remote；但 `ci.yml` 只在 `pull_request` 上跑，`actions/checkout` 在该事件下检出的是这次 PR 的合并提交（detached HEAD），`ci-master.yml` 只在 `master` 上跑，两条都落在第一条 skip 上——漏 trailer、漏登记、slug 改名，仍然只有在补丁线分支上跑 `doc-sync` 的人能抓到（那条静态 lane 用的是 `fetch-depth: 0`，所以浅克隆那条 skip 不是 CI 落点）。一个例外是手动触发：`ci-master.yml` 另有 `workflow_dispatch`，在补丁线分支上手动 dispatch 时 `actions/checkout` 按分支名检出，其 linux lane（同样 `fetch-depth: 0`，跑 `check:ci:linux-primary`）会真跑本门禁而不是 skip。不拿发布 tag 兜底：tag 不等于基座（见本文件开头），用它当基座会把上游的若干提交算进本线，产出一批指着上游提交的假违规。

**指向历史的写法**：指向本 fork 的改动写 slug 或相对链接指向该补丁的 Agent Note；指向上游的改动写上游 PR 号（`Merge pull request #NNNN`，即合并提交标题里的那个号，不是分支名里的 issue 号）或发布 tag。

**每条记录的五要素**：改了什么 / 为什么 / 要达到的效果 / 退役条件 / 状态。状态取 `在役`、`局部退役`、`退役` 之一：在役与局部退役写明所在线，退役写明在哪一条线上退的役。**局部退役**指同一族里的部分子件已被上游覆盖或在新基座上失去落点、而族整体仍在役；子件逐条列出，族自己的退役条件不变。

## ansi-line-parser-export — ui-primitives 导出 ANSI 行解析器

- **改了什么**：`packages/client/ui-primitives/src/index.ts` 增加 `parseAnsiLines` 与其行类型的包入口导出，实现文件不动。
- **为什么**：解析器已在包内 `ansi.ts` 实现并由 `TerminalBlock.tsx` 使用，但不在包入口上，仓外客户端插件要渲染同样的 ANSI 输出只能自带一份副本。
- **要达到的效果**：仓外插件与仓内组件读同一份实现，终端输出的换行、控制序列处理只有一处行为。
- **退役条件**：上游自己把 `parseAnsiLines` 加进 `packages/client/ui-primitives/src/index.ts` 的导出面。
- **状态**：在役（`core-patches-v10`）。核实依据：上游 `parseAnsiLines` 三处命中全在包内（`TerminalBlock.tsx`、`ansi.ts`、`ansi.client.spec.ts`），包入口仍不导出。
- **Agent Note**：[`export-ansi-parser`](../.agents/notes/implemented/feature/2026-08-27-export-ansi-parser.md)

## approval-detail-by-tool — 审批详情按工具名键控

- **改了什么**：`conversation.approval.detail` 槽由 `kind: 'single'` 改为按工具名键控（`packages/client/ui-approval`），`ui-tool` 为 `write`／`edit`／`str_replace_editor` 占位并新增 `approval-diff-row`，`ui-chat` 的既有占位保持为其余工具的兜底；新增 `apps/web/tests/approval-preview-diff.e2e.ts` 与 `snapshots/web/approval-preview-diff`。
- **为什么**：文件改动等待审批时，卡片只显示工具名与参数摘要，看不到它将写入的路径与行；`single` 槽一次只能有一个占用者，第三方无法只为文件类工具换一张卡。
- **要达到的效果**：文件改动的审批卡显示路径与将写入的行，diff 模型与会话行共用一份；其余工具的审批卡不变。
- **退役条件**：上游把 `conversation.approval.detail` 改成按工具名键控的槽，或自己为文件改动的审批卡渲染 diff。
- **状态**：在役（`core-patches-v10`）。核实依据：上游 `packages/client/ui-approval/src/client/index.ts` 仍声明 `kind: 'single'`。
- **Agent Note**：[`approval-detail-keyed-by-tool`](../.agents/notes/implemented/feature/2026-09-06-approval-detail-keyed-by-tool.md)

## chat-prose-referents — Assistant 正文的 proseReferents 缝

- **改了什么**：`ui-primitives` 的 `MarkdownRenderContext` 增加不透明的 `referents`（`scan`/`open`/`resolveLink`/`subscribe`），`MarkdownProseSpan` 只携带 `start`/`end`；`ui-chat` 的 `contract/slots.ts` 声明 `ProseReferents` 可选服务，`apply.ts` 的 `buildProseReferents` 绑定 `cwd` 与 Host `home` 并经 `referent/open` 派发；本地路径的 markdown 链接目标经 `resolveLink` 路由，校验节拍上重渲已定稿消息。
- **为什么**：Assistant 正文里的路径与 URL 只有行内代码一条通路（`chatFileMentions`），纯文本与未被认领的行内代码无法成为可点元素，仓外的校验索引插件没有接入口。
- **要达到的效果**：正文命中渲染成与文件提及同一枚常显按钮；`ui-primitives` 不依赖运行时的 `ReferentKind`；无提供者时行为与改动前一致。
- **子件：正文引用 not-found 竞态降级**。`buildProseReferents.open` 的 stat-到-click 竞态失败复用 composer 的通知通道给出用户可见提示，而不是只写 console。它有自己的退役条款，与父族的不同：`git grep path-not-found upstream/master -- packages/client` 非空即退役（本轮为空），或父族整体退役时随之消失。
- **退役条件**：上游自己的会话 UI 原生扫描并派发 Assistant 正文里的可点引用。
- **状态**：在役（`core-patches-v10`）。核实依据：`proseReferents`、`resolveLink`、`linkPlainText` 在 `upstream/master` 零命中；子件的判据 `git grep path-not-found upstream/master -- packages/client` 同样为空。
- **Agent Note**：[`chat-prose-referents-seam-port`](../.agents/notes/implemented/feature/2026-09-01-chat-prose-referents-seam-port.md)、[`markdown-link-destination-fallback`](../.agents/notes/implemented/bug-fix/2026-08-27-markdown-link-destination-fallback.md)

## claude-skills-roots — 扫描项目与用户的 `.claude/skills` 根

- **改了什么**：`packages/skill/skill-filesystem` 新增 `PROJECT_CLAUDE_RANK` 210 与 `USER_CLAUDE_RANK` 510 两个根、`claudeHome` 配置字段（覆盖变量 `$DSH_CLAUDE_HOME`）、`roots()` 按规范路径去重；`packages/skill/skill` 的 `SkillSource` 增加 `project-claude`／`user-claude`；不可扫描的单个根被跳过而不是让整个提供方归零；`tool-skill` 在部分根失败时发布部分目录而不是不发布。`packages/test-support/loader-smoke` 新增并导出 `isolatedSkillRootEnv(cwd, overrides)`，由它驱动测试与脚本里的钉根环境块。
- **为什么**：本 fork 的用户把技能写在 `.claude/skills` 下（与 Claude Code 同一约定），标准 harness 不扫描这两个根，这些技能对模型不可见。
- **要达到的效果**：两个 `.claude/skills` 根按既定优先级参与技能发现；一个根不可读只损失该根，不再让同提供方的全部根一起归零；测试与脚本用同一个函数钉隔离根，不再各写一份键名。
- **退役条件**：上游自己扫描项目与用户的 `.claude/skills` 根（出现等价的根与 `SkillSource` 取值）。另一条独立条款：上游自己按根降级——单根扫描失败只丢该根、不清零整个提供方，无论落在 `skill-filesystem`、`packages/skill/skill` 聚合层，还是 `tool-skill` 改为从部分观测发布目录——本族的按根降级扩展与模型面补齐一并退役（线上 5 个提交属于这一半）。
- **状态**：在役（`core-patches-v10`）。核实依据：`PROJECT_CLAUDE_RANK` 与 `isolatedSkillRootEnv` 在 `upstream/master` 零命中。
- **Agent Note**：[`claude-skills-root`](../.agents/notes/implemented/feature/2026-09-06-claude-skills-root.md)

## command-engages-session — 命令自己声明是否让所在会话转正

- **改了什么**：`CommandDefinition` 增加 `engages?: boolean`（默认 true），只有声明为 false 时把 `engages: false` 写进 `command/run` 载荷；`session-format-v0-to-v1` 的处置表与 payload 校验收该成员为可选布尔；`applySessionListMetadata` 在 `turn/start` 与未写 `engages: false` 的 `command/run` 上清除 `blank`，`stateVersion` 有意保持 1；客户端只在观察到本会话自己的 `command/run` 时转正，并落闩防止陈旧摘要把它抬回去；`/plan` 与 `/permission` 声明 `engages: false`。
- **为什么**：全新会话里把一条命令作为第一条消息发出，host 已执行并落盘，但界面停在欢迎页、侧栏不列出该会话——host 折叠只认 `turn/start`。而「每条命令都转正」同样错：欢迎页自己的访问模式 chip 运行的就是 `/permission`，会话若因此转正，人在为尚未开始的会话设访问模式的那一刻就失去欢迎页。
- **要达到的效果**：只跑过转正命令的会话有侧栏行、打开在自己的转录上；只跑过 `/plan`／`/permission` 的会话一切照旧。翻转点是 `command/run` 而非 `command/done`。
- **退役条件**：上游自己让命令声明是否使会话转正（`CommandDefinition` 出现等价字段，或 `applySessionListMetadata` 自己按某种声明在 `command/run` 上清除 `blank`），且客户端镜像在同一判据上转正。两半各自判定。
- **状态**：在役（`core-patches-v10`）。核实依据：`engages` 在上游 `commands`、`session-controller`、`plan`、`permission-presets` 四包零命中；`git show upstream/master:packages/api/session-controller/src/list.ts` 的 `applySessionListMetadata` 与 v9 基座逐字相同（折叠仍只认 `turn/start`），上游既没加字段也没改折叠，退役条件两半都未满足。**本轮上游对 `session-list-blank.host.spec.ts` 的唯一改动是 `attach` 改 async**（上游 PR #3583）。本族的适配提交跟了两处上游改动：该 spec 的一行跟 `attach` 改 async，本族 Agent Note 三件套里的 `PermissionSelect.tsx` 链接跟的是上游把该组件迁进 `ui-permission-presets`（上游 PR #3304）。
- **待拍板：要不要继续背这条语义分歧**。`upstream/master` 该 spec 的模块头注释明写「standalone plugin events — command lifecycle records … never flip it」，与本族的契约相反；该注释在 v9 基座上就已经是这样，v9 已经覆盖它，不是本轮新出现的冲突。上游的意图是明示的，不是疏忽，fork 的「退化条款」（上游一改同处即退役去适配）在字面上未触发（上游没改 `list.ts`），但这正是该条款想覆盖的情形，需要显式确认「继续背」。
- **已知后果（未立案迁移）**：`applySessionListMetadata` 的 `stateVersion` 有意停在 1（`packages/api/session-controller/src/list.ts` 的注释写明理由：升版会让每个未重开的会话丢掉 `lastPromptAt`，整条侧栏改按创建时间排序与标注，代价大于纠正 `blank`）。因此**本次构建之前跑过命令的会话保留旧的 blank 判决，不会自愈**；要不要做一次性迁移未定。
- **Agent Note**：[`command-engages-blank-session`](../.agents/notes/implemented/bug-fix/2026-09-10-command-engages-blank-session.md)

## connection-state-event — 连接粗粒度状态作为类型化客户端事件

- **改了什么**：`packages/client/connection/src/client/index.ts` 声明 ROOT 作用域客户端事件 `connection/state`，`packages/api/gateway/src/client/index.ts` 在连接状态变化时派发它，取值为该连接实际的三态模型。
- **为什么**：仓外客户端插件要按连接状态显隐自己的界面，只能轮询运行时内部对象。
- **要达到的效果**：插件订阅一个类型化事件即可跟随连接状态，不碰运行时内部。
- **退役条件**：上游自己广播等价的连接状态事件。
- **状态**：在役（`core-patches-v10`）。核实依据：`connection/state` 在 `upstream/master` 零命中。

## core-patches-ledger — 补丁登记文档自身

- **改了什么**：`.claude/core-patches.md` 本身——每轮同步登记基座、逐条补丁的五要素与状态。
- **为什么**：补丁线是一组长期存在的对上游的偏离，没有一份登记就无法判断某条补丁是否已被上游实现、是否该退役。
- **要达到的效果**：任何一轮同步都能只读本文件决定每条补丁的去留。
- **退役条件**：不适用——fork 不再维护补丁线时本文件随之消失。
- **状态**：在役（`core-patches-v10`）。

## core-patches-registry-gate — 按 slug 登记补丁身份与其门禁

- **改了什么**：新增 `scripts/verify-core-patches.ts` 与 `package.json` 的 `verify-core-patches` 脚本，登记进 `scripts/run-gates.ts` 的 `doc-sync` 叶子列表，附 `scripts/verify-core-patches.spec.ts`；全线提交加 `Patch: <slug>` trailer；本文件按 slug 重写；Agent Notes 与 `packages/preset/agent-presets/src/index.ts` 里指向提交的散文改写为 slug、上游 PR 号或描述。
- **为什么**：登记曾用提交哈希做身份。哈希每轮变基全部作废——上一轮登记的 284 个哈希里只有 72 个还能在当时的线上解析——而上游新增的 `verify-repository-references`（上游 PR #4060）拒绝维护中的散文里出现能解析成本仓提交的十六进制串，两条一起使哈希不可用。
- **要达到的效果**：补丁身份随变基存活且可机械核对；登记与线互为约束，任一侧漏改即门禁失败。
- **退役条件**：上游为引用门禁提供排除或配置口且本 fork 改回哈希登记，或上游自己提供等价的补丁登记机制。
- **状态**：在役（`core-patches-v10`，本轮新增）。
- **提交信息订正**：提交 `fix(scripts): close the four ways the patch-registry gate let real errors by` 的信息写「`upstream/master` was checked for existence, not for being this line's base. A stale ref silently widened the range, and the extra upstream commits surfaced as trailer violations pointing at upstream's own work. It is now compared against `git merge-base upstream/master HEAD`」。这条修法没有解决它声称解决的问题：`upstream/master` 落后真实基座时它仍是 HEAD 的合并基座，基座判据照样接受它，范围照样撑到上游的提交上，门禁随即把上游自己的提交报成 `trailer-count`／`merge-commit` 违规而失败——就是该信息描述的那个症状，只是落点从基座判据挪到了违规清单。反方向（`upstream/master` 前进，每次 `git fetch upstream` 之后的常态）则直接失败在基座判据上，而提示里的「fetch」只会让它更红。基座已改由本文件的 `**基座合并**` 声明给出、在 HEAD 自己的历史里解析，门禁不再读 `upstream/master`。本线只追加提交、不改写历史，以本条为准。
- **Agent Note**：[`core-patch-identity-trailers`](../.agents/notes/implemented/process/2026-09-17-core-patch-identity-trailers.md)

## disallowed-link-destination-notice — 被阻止的链接目标不再静默丢弃

- **改了什么**：`packages/client/ui-primitives` 的 markdown 渲染在链接目标不被允许时保留可读文本与目标串，而不是渲染成空。
- **为什么**：模型写出的本地路径或非允许协议链接被静默丢成空元素，读者既看不到文本也看不到目标。
- **要达到的效果**：被阻止的目标仍以纯文本呈现，用户能读到模型实际写了什么。
- **退役条件**：上游 `renderSafeLink` 自己对不被允许的目标保留可读文本。
- **状态**：在役（`core-patches-v10`）。
- **Agent Note**：[`markdown-link-destination-fallback`](../.agents/notes/implemented/bug-fix/2026-08-27-markdown-link-destination-fallback.md)

## factory-zero-deepseek-egress — 出厂零 DeepSeek 出站

- **改了什么**：`packages/bundle/base/cordis.patch.yml` 的 `session-telemetry-otel` 与 `plugin-package-inventory-deepseek` 两行加 `disabled: true`，`session-log-deepseek` 一行加 `config: { enabled: false }`；`packages/bundle/sdk-minimal/cordis.patch.yml`（该 bundle 刻意不叠加 base，是自己完整的树）的 `plugin-package-inventory-deepseek` 一行加 `disabled: true`、`session-log-deepseek` 一行加 `config: { enabled: false }`；各行的上游配置声明原样保留；两个 bundle 的 `tests/*.spec.ts` 各自钉住本 bundle 每一行的字面内容，并把 `session-log-deepseek` 行再经该插件自身 schema 解析一遍钉住实际取值；四份 README 改述本产品出厂状态。`snapshots/sdk/text-turn/cordis.yml` 补一行 `session-log-deepseek` 的 `enabled: true`：该组合是语料里对上传通路的覆盖，原先靠插件 schema 默认开启，base 出厂关闭后覆盖会变成死覆盖。
- **为什么**：本 fork 的产品决定是出厂即零会话遥测、零已装插件清单、零会话日志贡献流向 DeepSeek 官方 API，且不依赖用户设置环境变量。`session-telemetry-otel` 的 `mode` 只选采集策略、表达不了「关」；`plugin-package-inventory-deepseek` 没有等价开关；`session-log-deepseek` 的 `enabled` 在 `0.1.6-alpha.1` 基座上默认为 true。
- **要达到的效果**：两个 bundle 各自把通往 DeepSeek 的上报路径出厂关闭；用行标志的那些 `apply()` 根本不运行，`session-log-deepseek` 用的是插件自身的 `enabled` 字段——`apply()` 仍运行一次，但在注册 `dsh_session_log` 请求贡献之前返回，而那条贡献是该插件贡献的全部；profile patch 重新开启任一行即得到上游自己的行为。
- **退役条件**：上游自己把这些行出厂关闭，或 fork 不再发布面向终端用户的产品。
- **状态**：在役（`core-patches-v10`）。核实依据：上游 `packages/bundle/base/cordis.patch.yml` 两行仍无 `disabled: true`、`session-log-deepseek` 行仍无 `config`；上游 `packages/bundle/sdk-minimal/cordis.patch.yml` 的 `plugin-package-inventory-deepseek` 行仍无 `disabled`、`session-log-deepseek` 行仍无 `config`；该插件 schema 为 `enabled: z.boolean().default(true)`。
- **提交信息订正**：本族 `chore(bundle)` 那条提交的信息写「withholds the `dsh_session_log` request contribution while the plugin's remaining contributions stay mounted」——不成立：`packages/session/session-log-deepseek/src/index.ts` 的 `apply()` 只注册一样东西，且在 `enabled !== true` 时直接返回，「其余部分」是空集；与 `disabled: true` 的唯一差别是模块仍被导入、`apply()` 仍空跑一次。本文件返工前写的「插件其余部分照常挂载」是同一处失真的中文措辞，出自本文件自己而非那条提交信息，已按事实改写。提交已推 origin、不改写历史，以本条为准。
- **提交信息订正**：本族 `test(sdk)` 那条提交的信息写 `snapshots/sdk/text-turn` 是「the corpus's only coverage of the DeepSeek upload path」——「唯一」不成立：`snapshots/sdk/serial-created` 与 `snapshots/sdk/subagent-dsh-sdk-diagnostic` 的 `cordis.yml` 同样声明 `enabled: true`，两者的金样里都有 `session-log-deepseek/delivery-accepted`。该提交信息的另一半成立：text-turn 是当时唯一还靠插件 schema 默认继承该策略的组合。本线只追加提交、不改写历史，以本条为准。
- **提交信息订正**：本族 `test(bundle)` 那条提交的标题「read the base patch once」过实：同一份 `packages/bundle/base/tests/base.spec.ts` 的第二个用例仍就地重解析 `cordis.patch.yml`（它按 `Record<string, unknown>` 读平台表达式，与 `patchRows()` 的行类型不是一回事），该文件在同一 spec 里仍被读两次。去重只落在第一个用例上。本线只追加提交、不改写历史，以本条为准。
- **滚动同步注意**：patch 是整段替换目标行的 `config` 而非合并，因此后续任何一层只要给 `session-log-deepseek` 行任何 `config` 却没重述 `enabled: false`，就会恢复上游的默认开启。
- **不回补的一半**：壳侧的 `DSH_TELEMETRY_DISABLED` 与桌面组装层用例——补丁线上没有 fork 外壳，上游同名的 `apps/desktop` 是另一个应用。
- **Agent Note**：[`fork-kills-session-telemetry-and-plugin-inventory`](../.agents/notes/implemented/process/2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.md)

## legacy-preset-alias — 遗留 `code` 预设 id 解析为 `ptc`

- **改了什么**：`packages/preset/agent-presets` 新增 `LEGACY_PRESET_IDS` 与 `rosterIdFor`，在没有任何根提供 `code` 时把它解析为 `ptc`；别名只按自有键查找，查找是全函数。
- **为什么**：上游把 `code` 预设改名为 `ptc`（上游 PR #3074）并只保留会话持久化词汇，落在设置默认值、已恢复会话与切换动作里的 `code` 因此指向不存在的预设。
- **要达到的效果**：旧设置与旧会话继续解析到同一个预设；有根提供 `code` 时别名让位给该根。
- **退役条件**：上游自己为改名前的预设 id 提供别名解析，或语料里不再存在 `code`。
- **状态**：在役（`core-patches-v10`）。核实依据：`LEGACY_PRESET_IDS` 与 `rosterIdFor` 在 `upstream/master` 零命中。

## open-path-not-found-error — 路径打开器返回可区分的 not-found

- **改了什么**：`session/openWorkspacePath` 在目标不存在时返回带 `session/path-not-found` 码的失败，而不是一个无法区分的通用错误。
- **为什么**：客户端要把「目标不存在」降级成自己的提示，但拿不到可判别的失败码，只能匹配错误文案。
- **要达到的效果**：调用方按码分支；文案变化不影响判别。
- **退役条件**：上游为该端点提供等价的可判别失败码。
- **状态**：在役（`core-patches-v10`）。核实依据：`session/path-not-found` 在 `upstream/master` 零命中。

## permission-preset-glyph — 宿主配置的预设可点名选择器图标

- **改了什么**：`PresetSpec` 与 `PresetOption` 增加可选 `glyph`，取值为封闭设计集 `read-only`／`workspace-write`／`danger-full-access`；schemastery Config schema 用 `PRESET_GLYPHS` 做闭集校验，未知名称在插件加载时带配置路径失败；`PermissionSelect` 每一行与 trigger 都按 `option.glyph ?? option.value` 取图标，设计集外的键画裸盾牌轮廓。
- **为什么**：选择器的图标表按 option 值硬编码在客户端里，只有三个内置预设 id 能解析到图样；部署自配的预设渲染成一行没有图标的文字，且没有任何插件层能从外部修正。
- **要达到的效果**：部署自配的预设能点名一枚设计集图标；任何其他键画裸盾牌，因此没有一行是无图标的。
- **退役条件**：上游让宿主配置的预设决定选择器图标（`PresetSpec`／`PresetOption` 出现等价字段）。
- **状态**：局部退役（`core-patches-v10`）。族整体在役，核实依据：`PresetGlyph` 在 `upstream/master` 零命中；schemastery 侧的闭集校验（`PRESET_GLYPHS` + `z.union`）与 `optionOf` 透传原样保留，未知名称仍在插件加载时带配置路径失败。四处局部退役：
  1. **投影 wire schema 里的 `glyph` 校验**：上游 PR #3304 把目录改成类型化的 `@Remote('catalog')`，`permissions` 投影的 wire view 只剩 `currentValue`，本补丁加在那份 zod 里的闭集校验随该 schema 一并消失。
  2. **`projection.spec` 的「经 wire schema 服务一枚配置的 glyph」用例**：同一原因，该投影不再带 `options`，用例已无被测对象，取上游侧。替代覆盖在 `permission-presets.spec.ts` 的「carries a configured design-set glyph into the option and rejects any other name at load」（含 `glyph: 'sparkles'` 的加载期拒绝）。
  3. **本补丁自带的 `shieldOutline` 路径数据**：上游把盾牌轮廓提成 `ui-primitives` 的 `SHIELD_OUTLINE_PATH`/`SHIELD_OUTLINE_STROKE`（上游 PR #3745，与本记录其余几处的 #3304 不是同一个 PR），`PermissionSelect.tsx` 的两枚盾牌图标与 `bareShield` 现在全部读这两个常量，补丁不再自带路径。不改用上游的 `IconShieldOutline16`：同文件三枚内置图标都是就地 svg 组合，裸盾牌是这组的第四个成员，就地写法保住了与兄弟行一致的 `aria-hidden`。
  4. **README Summary 里的 glyph 说明**：上游整段重写了 `packages/interaction/permission-presets/README.md` 的 Summary（上游 PR #3304），且该段受字数上限约束，本补丁原先压进去的那句（「A table entry may also name its selector `glyph`.」）随之丢弃。glyph 只剩「Configuring presets」一段说明。
  trigger 上那条注释的丢失**不是** `ModelSelect` 迁包造成的——`ModelSelect.tsx` 在 v9 基座上就已在 `ui-model-selection`，与 `PermissionSelect` 本就不同包。真实原因是上游把 `PermissionSelect` 迁进新包 `ui-permission-presets`（上游 PR #3304）并自己拥有了那几行 chevron JSX，本补丁不再新增它们，注释因此失去落点。
- **提交信息订正**：本族有一条 `adapt(permission-preset-glyph)` 提交的信息首段描述的是前一提交已完成的组件搬迁（glyph 用例随组件进入 `ui-permission-presets`），与它自己的 diff 不符——该提交的实际改动只有既有用例的 svg 计数 1→2 加一条注释。提交已推 origin、不改写历史，以本条为准。
- **Agent Note**：[`permission-preset-glyph`](../.agents/notes/implemented/feature/2026-08-23-permission-preset-glyph.md)

## referent-open-seam — `referent/open` 引用点击拦截缝

- **改了什么**：`packages/api/session-controller` 新增 ROOT 作用域 waterfall 事件 `referent/open` 与 `dispatchReferentOpen(ctx, ref, onDefault)`；`ReferentRef` 只携带引用身份——`kind`、`target`、`raw`、可选 `sessionId`、点名派发点的 `source`、以及 `enteredAs`（`structured`／`model-text`／`tool-output`／`user-text`）——绝不携带被引用内容；`ui-chat` 的 `openFile` 闭包与正文 span 打开器都经该缝派发。
- **为什么**：浏览器会话 UI 里每一处「打开该引用」各自直连打开动作，仓外插件无法在任何一处之前介入。
- **要达到的效果**：此后新增的可点元素只要派发就自动可拦截；监听者不调用 `next()` 即认领该次点击，抛出或拒绝按等同于 `next()` 处理，因此一次点击总能落到某个打开动作上。
- **退役条件**：上游自己提供等价的引用点击拦截点。
- **状态**：在役（`core-patches-v10`）。核实依据：`referent/open` 在 `upstream/master` 零命中。上游 PR #3151 新增的 `scripts/verify-concrete-terms.ts` 拒绝本缝原字段名里那个含糊的来源标签，字段因此改名为 `enteredAs`，取值与语义不变。
- **Agent Note**：[`referent-open-seam-port`](../.agents/notes/implemented/feature/2026-09-05-referent-open-seam-port.md)

## referent-target-probe — 批量路径存在性探测 `probeTargets`

- **改了什么**：`session-controller` 新增 `probeTargets` 端点，一次调用回答一批路径是否存在。
- **为什么**：引用校验层要在渲染前判断一批目标是否可打开，逐条 RPC 的往返次数与正文里的引用数同阶。
- **要达到的效果**：一次调用得到整批结论，校验层不按引用数发请求。
- **退役条件**：上游自己提供等价的批量存在性探测端点。
- **状态**：局部退役（`core-patches-v10`）。族整体在役，核实依据：`probeTargets` 在 `upstream/master` 零命中。一处局部退役：原先给穷举式客户端假实现 `packages/api/session-controller/tests/fake-api.client.ts` 绑定 `probeTargets` 的那条提交本轮退役——上游 PR #3960 把该假实现整体换成 `tests/remote/{session,bench,history}.client.ts` 的部分规则表，不再要求绑定每个端点，该补丁存在的理由消失。宿主侧覆盖未损失：`session-probe-targets.host.spec.ts` 与 `test-remote.ts` 仍钉着该端点。

## rolling-sync-settle — 每轮滚动同步的适配与生成物收敛

- **改了什么**：每轮同步里**没有所属补丁族**的跨仓适配与生成物收敛：重跑 `gen-*` 生成物、重录双语配对记录、把跨多族的合并文档收敛到字数上限、把横跨多族的测试夹具搬到本基座的 harness 上。
- **为什么**：补丁本身不变，但它依赖的上游 API、测试夹具与生成器输出每轮都在动；不收敛这些，补丁在新基座上编译不过或门禁不绿。而这类收敛里有一部分跨了多个补丁族，挂不到任何一族的 slug 上。
- **要达到的效果**：生成物与源树一致，`gen-*`／`verify-*` 的 `--check` 全部退出 0；跨族的文档与夹具在当前基座上成立。
- **归属规则**：**只服务单一补丁族的适配提交挂那一族自己的 slug**，不挂本族——本轮的三条 `adapt(referent-open-seam)`／`adapt(permission-preset-glyph)`／`adapt(command-engages-session)` 即如此。否则按 slug 退役某一族时会找不到它这一轮的适配提交。
- **退役条件**：不适用——本族随每轮同步重生成，不是可退役的 overlay；它服务的补丁族退役时，对应的适配随之消失。
- **状态**：在役（`core-patches-v10`）。本轮零新提交，线上 4 条继承自 `core-patches-v9`。

## session-export-progress — 导出面板显示进度与失败

- **改了什么**：`session-log-export` 的导出路由回送条目总数头（`SESSION_EXPORT_ENTRIES_HEADER`），页面据此显示进度并在失败时留在页面上说明原因；面板文案与两趟测量的实际语义同步。
- **为什么**：大会话导出期间页面没有任何进展迹象，失败时也只是弹窗消失。
- **要达到的效果**：导出有可见进度条与可读的失败说明。
- **退役条件**：上游自己让导出回送进度信息并在页面显示。
- **状态**：在役（`core-patches-v10`）。核实依据：`SESSION_EXPORT_ENTRIES_HEADER` 在 `upstream/master` 零命中。
- **Agent Note**：[`session-export-progress`](../.agents/notes/implemented/feature/2026-09-03-session-export-progress.md)

## session-export-size-text — 导出面板尺寸文案取自 ui-primitives

- **改了什么**：删除 `session-log-export` 自带的 `byte-size.ts` 与其用例，`Dialog.tsx` 改用 `ui-primitives` 已导出的 `fileSizeText`。
- **为什么**：那是仓内已有格式化函数的私有副本。
- **要达到的效果**：面板读数走仓内唯一一份实现；文案随之变化（不加空格、所选单位十以下保留一位小数）。
- **退役条件**：不适用——本条是删除自有代码改用上游实现，不构成对上游的补丁负担。
- **状态**：在役（`core-patches-v10`）。

## session-export-unreadable-entries — 不可读附件写成归档条目而不撕裂流

- **改了什么**：`session-log-export` 的 `archive.ts` 在附件对象读不出来时，把一条说明记录写进归档里该附件本该占的条目，而不是让 ZIP 流中断。图片半边是 `mediaEntry`/`unreadableMediaEntry`；通用文件半边是 `fileEntry`/`unreadableFileEntry`/`resumedFileChunks`——`fileEntry` 在产出条目前先拉存储的第一个分块（写入器本就在花这一个分块的内存预算），拉取被拒才改记录。两条路径共用 `unreadableAttachmentReason`。记录的路径键与碰撞前提写在 `archive.ts` 的 JSDoc 里。
- **为什么**：一个读不出来的附件会让整次导出失败，用户拿不到任何内容，也看不到是哪个附件出的问题。现场触发源是仓外截图插件把 JPEG 按 `image/png` 声明保存，已写进日志的引用永久保留；通用文件半边则是上游把文件对象搬到 `file-objects/`／`files/`（上游 PR #3109）之后，`attachment-text-file-kind` 时代写下的文件对象一律读不到（见该条的破坏性变化）。
- **要达到的效果**：不可读的图片留下带 `attachmentId`、`mediaType`、`bytes`、`width`、`height` 的记录，不可读的通用文件留下带 `attachmentId`、`name`、`bytes` 的记录（**文件记录没有 `mediaType`**，引用本身不带）；两者都附失败原因，条目数因此把它计在内。
- **三项例外——导出并非总能完成**：(1) **取消仍撕裂**：`archive.ts` 的 `fileEntry` 与 `mediaEntry` 在返回不可读条目之前都先 `signal?.throwIfAborted()`，取消在两条路径上都让流出错；(2) **通用文件第一个分块之后抛出的失败仍撕裂**，字节已经上线，无法再改写成记录；(3) **读不出来的子会话日志仍让流出错**——`sessionLogTextEntries` 对没有存储日志的子会话直接抛错。
- **安全动机（不可回退）**：`unreadableAttachmentReason` 只在失败是 `AttachmentError` 且带字符串 `code` 时写出 `code` 与 `message`，其余一律只写一行匿名原因。理由是本包对 attachment 包只有类型依赖、按 `name` 结构匹配，而 Node 的 fs 错误同样带字符串 `code` 且 `message` 含主机绝对路径——归档是用户会下载并转发的文件，**绝不回显可能含主机绝对路径的 message**。这比 `error.ts` 的「按 code 路由」更严，是有意的。
- **退役条件**：上游自己在导出遇到不可读附件时记录并继续（图片与通用文件同一判据）。
- **状态**：在役（`core-patches-v10`）。核实依据：`unreadableMediaEntry` 在 `upstream/master` 零命中。
- **Agent Note**：[`export-records-unreadable-media`](../.agents/notes/implemented/bug-fix/2026-09-04-export-records-unreadable-media.md)

## session-format-legacy-message-source — 一种历史消息来源种类过 V3 迁移边

- **改了什么**：`session-format-v2-to-v3` 接受语料里仍在的一种仓外历史消息来源种类，并说明每处检查与定位器各自在判断什么。
- **为什么**：该来源种类由本 fork 的产品线写入，V3 边不认识它就拒绝整份会话日志，而一次拒绝会让派生索引的整轮观察中止、内容搜索全库退回名称匹配。
- **要达到的效果**：携带该来源种类的会话能迁移、能索引；接受面仍是一份按盘上实测列出的名单，不是通用放行。
- **退役条件**：上游把该来源种类纳入已发布来源词表，或为来源分类提供自定义扩展点，或语料里不再存在它。
- **状态**：在役（`core-patches-v10`）。
- **Agent Note**：[`v2-to-v3-legacy-source-kind`](../.agents/notes/implemented/bug-fix/2026-09-10-v2-to-v3-legacy-source-kind.md)

## session-format-out-of-repo-events — 已落盘的仓外历史事件过迁移边

- **改了什么**：`session-format-v0-to-v1` 的 `LEGACY_UNINTERPRETED_EVENT_TYPES` 点名本 fork 产品线写过的仓外事件类型，三条迁移边读同一个被点名集合，逐条原样带过并在 v2 标记 `ignorable: true`。
- **为什么**：迁移边拒绝一切不在冻结清单上的历史事件类型，本 fork 的产品线写过的事件因此让整份会话日志打不开。
- **要达到的效果**：被点名的类型原样过边，其余未点名的仍被拒绝。
- **退役条件**：上游把这些类型纳入自己的迁移清单，或为迁移边提供自定义词汇扩展点，或 fork 不再需要打开这些会话。
- **状态**：在役（`core-patches-v10`）。核实依据：`LEGACY_UNINTERPRETED_EVENT_TYPES` 在 `upstream/master` 零命中。
- **实证（按盘上语料，不是推断）**：本机 `~/.dsh` 全部 128 份日志逐份解压扫描——`permissionRules/decision` 命中 3 份，`attachment/materialized` **命中 0 份**。那 3 份的只读副本补丁前 `OPEN FAILED`、补丁后全部读回，原始文件 sha256 前后一致。语料回放另证第三条边（V2→V3）必要：`permissionRules/decision` 在纯 `upstream/master` 上被拒，只加本补丁即全部读出。
- **提交信息订正**：本族提交信息写的「Two such types exist on this fork's disks」对 `attachment/materialized` 不成立——它在本机零命中，只会出现在触发过溢出附件的 rc.29／rc.30 用户机上。提交已推 origin、不改写历史，以本条为准。

## session-format-v0-legacy-shapes — 接住语料里仍在的三种遗留 v0 形状

- **改了什么**：`session-format-v0-to-v1` 增加两个归一化器——`permission/preset` 去掉旧构建写下的多余成员，`subagent/descriptor` 把版本 2 改写为 3——并在处置表里点名本 fork 产品线写过的六种内容事件类型。
- **为什么**：这三种形状由本 fork 发过的构建写下，v0 边拒绝它们，对应会话打不开，并连带让内容搜索全库不可用。
- **要达到的效果**：携带这三种形状的会话能打开、迁移、索引；接受面仍窄——其他多余成员、其他描述符版本、未点名的事件类型一律仍被拒绝。
- **退役条件**：上游把 `origin` 纳入 `permission/preset` 处置、为 descriptor 版本提供迁移、把这些内容事件类型纳入清单，或为迁移边提供自定义词汇扩展点，或语料里不再存在写下它们的构建的产物。
- **状态**：在役（`core-patches-v10`）。
- **Agent Note**：[`v0-migration-legacy-shapes`](../.agents/notes/implemented/bug-fix/2026-09-07-v0-migration-legacy-shapes.md)

## session-index-generation-identity — 派生索引身份带上 Session 世代

- **改了什么**：`session-query-sqlite` 的索引身份（`SESSION_QUERY_SQLITE_INDEX_IDENTITY`）纳入 Session 世代，世代变化时重建派生索引。
- **为什么**：重置判据只比对 schema 版本，会话格式换代后旧索引被当作仍然有效，搜索结果指向已不存在的行。
- **要达到的效果**：会话世代变化即重建索引，搜索结果与当前世代一致。
- **退役条件**：上游把世代纳入自己的索引重置判据。
- **状态**：在役（`core-patches-v10`）。核实依据：上游 `session-query-sqlite/src/schema.ts` 的 `PRAGMA user_version` 仍只比对 schema 版本。

## settings-trigger-action-seat — 设置触发行右端的同行贡献位

- **改了什么**：`ui-settings`／`ui-settings-general` 在设置触发行右端开一个同行贡献位（`settings.trigger.action`），并给它一个打开设置面板的 opener；触发行自己拥有该贡献位所在的 hover 面。
- **为什么**：仓外插件要在设置行右端放一个自己的动作，没有任何槽位可用。
- **要达到的效果**：插件在设置行右端占位，hover 表现与该行一致。
- **退役条件**：上游在设置触发行提供等价贡献位，或 fork 改用上游桌面外壳、不再需要那个更新按钮插件。
- **状态**：在役（`core-patches-v10`）。核实依据：`settings.trigger.action` 在 `upstream/master` 零命中。
- **滚动同步注意**：这是 client-UI 补丁，每轮都要重新移植并重新核实。两处会撞行：`SettingsRoot.tsx` 传给本位的 `openSection` 与 onboarding 位共用同一个 `useCallback`，上游改那段时两处一起看；宽行的悬停面落在 `SettingsRoot.module.css` 的触发行选择器上，上游改触发行悬停样式会与它撞。`slot-catalog.ts` 是生成物，冲突时取上游侧后重跑 `pnpm run gen-client-catalog`。
- **Agent Note**：[`settings-trigger-action-slot`](../.agents/notes/implemented/feature/2026-09-11-settings-trigger-action-slot.md)

## user-message-action-seat — 用户消息上的贡献位

- **改了什么**：`ui-conversation` 在用户消息上开一个贡献位（`conversation.chat.user-actions`）与对应的 `renderUserActions` 传参。
- **为什么**：仓外插件要在用户消息旁放自己的动作（例如引用该消息），没有槽位可用。
- **要达到的效果**：插件在用户消息上占位；无占用者时渲染不变。
- **退役条件**：上游在用户消息上提供等价贡献位。
- **状态**：在役（`core-patches-v10`）。核实依据：`conversation.chat.user-actions` 与 `renderUserActions` 在 `upstream/master` 零命中。
- **Agent Note**：[`user-message-action-slot`](../.agents/notes/implemented/feature/2026-08-24-user-message-action-slot.md)

## workspace-gate-private-apps — 工作区门禁看见不发布的 app

- **改了什么**：`scripts/check-workspace-constraints.ts` 与其 `.spec.ts` 给 `apps/*` 引入 private／发布成员两种类别（`isPrivateApp`、`checkPrivateAppManifest`），并让 `checkDshFamilyVersion` 对私有 app 跳过共享版本校验。
- **为什么**：本 fork 在 `apps/*` 下有只随客户端构建分发、从不发到 npm 的产品装配，却被当成发布成员校验，四条发布元数据规则同时落空；上游自己只按名字排除了它自有的两个目录，覆盖不到 fork 的目录。私有 app 带的是各自的产品发行版本（桌面更新源与已安装外壳据以比对的那一个），不能由 dsh 家族共享版本占有。
- **要达到的效果**：`apps/*` 下未发布的产品装配通过门禁，同时仍受工作区卫生规则约束；判别只靠 `private: true` 一个布尔字段。
- **退役条件**：上游的 `check-workspace-constraints.ts` 自己区分 `apps/*` 下未发布的私有产品装配与发布成员，或 fork 不再拥有此类目录。
- **状态**：在役（`core-patches-v10`）。核实依据：`isPrivateApp` 在 `upstream/master` 零命中。
- **Agent Note**：[`private-apps-are-not-release-members`](../.agents/notes/implemented/process/2026-08-20-private-apps-are-not-release-members.md)

## attachment-text-file-kind — 持久附件缝的文本文件种类

- **改了什么**：曾给 `packages/attachment` 增加与图片平行的文件类型族与 `AttachmentStore` 的文件准入／保存／读回方法。
- **为什么**：标准 harness 没有非图片附件通路，第三方插件把文件当原始文本拼进草稿，绕过已有的持久、内容寻址服务边界。
- **要达到的效果**：文本文件像图片一样经服务边界准入、按内容寻址持久化、可按引用重新读取校验。
- **退役条件**：上游为 `@deepseek-ai/dsh-attachment` 添加镜像图片的文件准入与存储服务边界。
- **状态**：退役（在 `core-patches-v7` 上退役，上游 PR #3109 通用文件上传）。与我方实现的差异：上游不做文本嗅探、不设限额、按 verbatim 存任意字节，文件对象落在两棵新树而不是与图片共用的对象树。
- **已知破坏性变化（rc.29／rc.30 发出的构建）**：我方实现把文件对象写在 `attachments/v1/objects/`，上游只读 `file-objects/` 与 `files/` 两棵树，因此那两个版本写下的文件附件在 `core-patches-v7` 及其后的基座上**一律读不回来**。2026-09-05 决定**不做读侧回退**：受影响的只有文件附件这一条通路，日志与图片照常，而回退要在上游的存储实现里再加一棵历史树。`session-export-unreadable-entries` 的通用文件半边正是为这批会话仍能整包导出而做。

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
- **退役依据**：上游在同一个 `bootstrapLegacyUnit` 里加了 `acceptedStamps` 判据（上游 PR #3438）——当前版本加包属主显式声明的 `compatibleVersions`——是我方「必须同版本」的**超集**（同版本照旧引导，异版本默认不引导，另允许属主把特定旧版本声明为可读）；测试等价覆盖逐条核过，无缺口。上游方案还更优：保留我方补丁会让旧版本用户升级后丢掉全部投影缓存标题。
- **为什么当初要做（真机故障链）**：rc.22 的家目录升到 rc.27 后，旧单文档里的记录被原样复制成当前版本的记录文档 → `storage-domain.open` 按新 schema 逐条校验抛错 → session-projection-cache 初始化失败 → 服务端拒启 → 桌面停在 startup failed。

## rescope-exact-edits — 重新锚定两处 rescope 精确编辑

- **改了什么**：曾把两处 rescope 脚本的精确编辑重新锚定到当时的上游树。
- **为什么**：锚点随上游文件变动而失配。
- **要达到的效果**：rescope 脚本在当时的基座上可跑。
- **退役条件**：上游改写该脚本或锚点不再存在。
- **状态**：退役（在 `core-patches-v2` 上退役，结论不变，自 `0.1.3-alpha.1` 起未再移植）。
- **退役依据**：在新基座上不重落本补丁、直接跑 `pnpm run rescope-vendor:check`，结果为 `post-state verified — no residue, every exact edit landed, idempotent`；上游 `scripts/rescope-vendor.ts` 的 `EXACT_EDITS` 表里旧的 `packages/util/home` 锚点已随上游自身的包图重排整体消失（上游 PR #2911），中文 vendoring cookbook 链接锚点也已由上游自己修正。

## file-part-bubble-card — 消息气泡里的文件分片卡

- **改了什么**：曾新增 `FileCard.tsx`，由用户气泡与 Assistant block 直接内联渲染 `{kind:'file'}` 分片；点击先派发 `referent/open`，落空后切换内联展开/收起，经新增的 `loadFile`／`ISession.readFile`（对偶于既有的 `loadImage`／`readAttachment`）惰性抓取文本；`event-projection` 增 file 分支，宿主侧增 `session.file` 回读 RPC 与 `loadFile` 的失败错误码。
- **为什么**：文件分片已经上了 wire、日志与请求物化，也进了 composer 草稿，但已发送的文件分片在消息气泡里完全不渲染。
- **要达到的效果**：文件分片与图片分片一样在消息流里可见、可展开读回原文。
- **退役条件**：上游自己的会话 UI 原生渲染文件内容分片。
- **状态**：退役（在 `core-patches-v7` 上退役，上游 PR #3109 的 `FileCard` 与混合附件呈现）。本条与 `referent-open-seam` 原是同一条补丁的两半：缝那一半在役、另立记录，文件气泡卡这一半连同 `session.file` 回读 RPC 与 `loadFile` 失败码两条随附提交一并不移植；`ReferentRef` 上那个只服务文件卡的 attachment 字段随其唯一生产者删除。

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
- **待重做（第二片）**：上游无对应物、产品价值仍在，但整个挂载点（composer 文件草稿）已随文件附件族在 `core-patches-v7` 上退役，需对着上游 PR #3109 的 `file-upload` 通路与 `ComposerAttachments` 重新设计挂载位置。同族的另两条改动（确认时机从发送时移到添加时；Config 断言不再架空自己的注解）一并押后。

## 历史轮次

本线由 `core-patches-v1` 起逐轮变基而来。每轮的提交清单随变基作废，不在此登记；下面只留**今天仍然有效**的事实——重复踩会付代价的那些。删掉它们曾让这些事实在全仓没有第二个归宿。

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
- **冷构建陷阱**：被上游删掉的包目录会残留只含 `node_modules/` 的孤儿目录，tsdown 的 workspace glob 命中后向上找到仓库根，`pnpm run build` 冷跑报 `Cannot find entry`。`pnpm run clean` 再 `pnpm install`。

### 旧会话可读性预审（每轮移植前必做）

在**纯 `upstream/master`** 树上，对 `~/.dsh/sessions` 与备份 home 的**只读副本**逐份冷读（`JsonlSessionPersistence.open(id, 'read').read()`，与派生索引观测走同一条路），记下拒读份数与每类拒读原因；移植后同法复测，逐条对应到是哪条补丁清掉了哪一类。`core-patches-v8` 那轮的读数是：纯上游 127/139 与 96/121，五类拒读原因；三条会话格式补丁逐条叠加后 139/139 与 121/121，零拒读；两库共 281 个 `.zstd` 文件在全部回放之后 sha256 逐一未变（读路径只在内存里迁移）。**副本永远放 scratch，绝不对真实 home 做写操作。**
