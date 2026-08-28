# Agent Note：可点引用三层架构（提名 → 验证 → 打开）

状态：已实现

[English](2026-08-28-three-layer-clickable-references.md) | 中文

## 问题

此前的 `proseReferents` 缝隙（`ProseReferents.scan`）只凭语法就让正文里的一段文字变成可点——一个绝对路径、一个 `~/…` 简写、一个裸 URL——中间没有任何验证步骤。一次 36 发模型自标实验（`~/.claude/jobs/88ebf148/tmp/mark-exp/`）显示：markdown 链接这种提名方式在有据场景下近乎满分，在干扰场景下零误标；但它唯一的真实弱点——一个凭记忆写下、如今已不存在的路径——恰好落进"蓝=必开"这条不变量本来要防的那类失败：一条读者信到愿意点下去的死链。仅靠提名（正则/操作系统路径语法侦测）分不清一个真实存在的文件和一个"看起来像"的文件；只有真去查文件系统，或者查会话自己记下的真值，才分得清。

## 定案

**三层，严格分先后：提名 → 验证 → 打开。** 一个 span 只有经过验证才能到达渲染层——这是结构性的，不是某个 provider 可能一时疏忽绕过的策略，因为 `ProseReferents.scan` 自己的契约（`packages/client/ui-conversation/src/client/contract/slots.ts`）现在明确写明它只返回**已验证**的 span；渲染侧的镜像 `MarkdownProseReferents`（`packages/client/ui-primitives/src/markdown/render.tsx`）携带同样的契约，却对"验证"这件事一无所知——它本来就是 cordis-free 的，此后也保持这样。验证本身（先查会话真值索引，未命中再走宿主 `stat`）完全是插件层（`dsh-plugins` 里的 `@haoran/dsh-clickable-refs`）的事：core 只开通用缝，不做任何分类判断，这与最初 `proseReferents` 缝隙给检测逻辑定下的分工完全一致。

**A1——契约上新增 `resolveLink`/`subscribe`。** 两个新成员都是可选的，一个老版两件套 provider（`{ scan, open }`）原样编译、原样运行。`resolveLink(destination, displayText, ctx?)` 让 provider 能验证一个**markdown 链接**的目的地——这是 `scan` 从未覆盖过的提名通道，因为 `scan` 只看得到渲染出的文本/行内代码片段，看不到链接节点自己的 `url`。`subscribe(listener)` 补上了异步验证缺的那个通知钩子：在这之前，没有任何机制能告诉渲染层"一批验证刚跑完，之前显示为普通文本的某些 span 现在可能能点了"。

**A2——markdown 链接改走 `resolveLink`。** `render.tsx` 的 `case 'link'` 现在先解码目的地（`decodeURIComponent`，尽力而为），当它呈本地路径形（`/`、`~/`、盘符、或 UNC `\\` 共享）且不是 `http(s)`/`mailto` URL 时，交给 `context.referents.resolveLink` 而不是落到既有的协议白名单。验证通过的 span 渲染成 `css.fileMention` 按钮（与 `scan` 命中同款样式）；未验证的渲染成普通行内代码样式，目的地放在 `title` 上——刻意不用既有的 `text (destination)` 尾缀文本回落，因为那会把一段长长的绝对路径重新塞回正文，而这条 patch 正是想让正文保持干净。没有 provider，或 provider 没声明 `resolveLink` 时，这个分支根本不介入——目的地照旧落到未改动的白名单路径，字节不变。

**A3——落定重渲修复。** 这是一个真实的、已独立证实的 bug，不是顺手夹带的新范围：`MarkdownText` 的 `useMemo` 此前没有任何依赖项能在消息落定**之后**、异步验证批次才完成时发生变化——于是一条在路径验证完成前就已落定的消息，会一直保持死文本，直到整页刷新（重新挂载后针对彼时已经验证好的索引重新扫一遍）才能显形。`useReferentsRevision` 订阅 `referents.subscribe`，把一个递增的 tick 计数器并入 memo 的依赖数组——除此之外什么都没改；落定这一瞬间本身早就能正确重渲，靠的是既有的 `node.data.status` 响应式路径（`AssistantNodeView` → `AssistantMarkdown` → `MarkdownText`，节点数据真的更新时 `streaming` 属性从 `true` 翻到 `false`）——这条 patch 核实了这一点，而不是想当然认为它成立。

**A4——`probeTargets`，先确认无可复用才动手加。** 侦察覆盖了 `packages/api`、`packages/fs`、每一个面向目录的 `packages/client/*` 包、以及 `packages/host/*`：唯一与路径存在性沾边的 client↔host RPC 是 `host.listDirectory`，它列举整个目录内容（违反"只 stat 不列目录"），还挂在 `browse` 能力闸后面——多数桌面安装（走 native 选择器，压根没有这条 RPC）根本用不上它。新增的 `host.probeTargets(paths) → {results}` 原样照抄 `listDirectory` 的管线模式（schema → `RpcMethodMap` 行 → 分发器 → `IApiClient` → 每一份测试替身），只读 stat，内部 8 并发限流，单次调用上限 64 条路径（由 zod 请求 schema 强制——超批直接在处理器跑之前就以 `bad-request` 失败，绝不悄悄截断）。它不挂任何能力闸，这一点与 `listDirectory`/`pickDirectory` 不同：它不做任何一个部署可能想要保留的"要不要允许"的文件系统选择，就像 `openPath` 自己那条无条件的 `stat` 预检一样。

**A5——core 零改动，侦察确认复用既有缝。** `ctx.systemPrompt.section({ name, order, text })`（`packages/core/system-prompt/src/index.ts`）已经允许任何插件从自己的 `apply()` 里追加一段有序提示词，不需要任何新的注册 API——order 100-199 就是文档写明的"工具指引"区间，正是 B1 的用场。这套架构要求的"model-visible ⟺ logged"物证也已经天然成立：`request/header` 的 `EpochHeader.system` 字段在每一次 `'initial'`/`'resume'`/`'change'` 表头写入时都会原文记下完整渲染后的系统提示词（`packages/core/session/src/types.ts`），所以插件追加的那段文字无需任何新的 `SessionEventMap` 事件即可从会话日志重建出来。

## 考虑过的备选方案

**只靠 `scan` 承担验证，不单开 `resolveLink`。** 否决：`scan` 只看得到渲染出的文本片段——纯正文或行内代码——永远看不到链接节点自己的 `url`；渲染器在 `scan` 有机会把它当成子串之前，早就把这个目的地解码规范化过了。markdown 链接的目的地需要一条自己的提名通道。

**给系统提示词追加段落开一个会话级/轮次级 `SessionEventMap` 事件（A5）。** 在 `request/header` 的侦察结果落地后否决：这段文字本来就能从每次表头写入的既有 `system` 字段完整重建，新开一个事件只是复制日志里已经有的数据，相对"grep 日志核实"这个验收标准毫无增益。

**让 `probeTargets` 挂上 `browse` 能力闸，与 `listDirectory`/`pickDirectory` 看齐（A4）。** 否决：那两个方法在做一个部署主动要不要允许的**选择**（浏览任意目录，或唤起原生系统对话框）——一个只对模型/工具输出里已经点名的路径做 stat 探测的方法，做不出可比的选择；`openPath` 自己的预检早就无条件跑一次 `stat`，没有任何闸。

## 影响

没有 `proseReferents` provider、或 provider 还是老版 `{ scan, open }` 两件套时，每一处新增表面——`render.tsx` 里 `resolveLink` 的分支、`MarkdownText.tsx` 里 `subscribe` 的 tick——都是死代码：它们打开的任何代码路径都不会被执行，这一点由显式测试证实（`packages/client/ui-primitives/tests/markdown.client.spec.tsx` 的无 provider、无 `resolveLink` 用例），配合每一条既有测试原样通过。`SESSION_FORMAT_VERSION` 未动（一条纯客户端渲染缝隙加一个只读 stat RPC，不涉及会话日志）。这次改动碰过的每一个文件——`render.tsx`、`MarkdownText.tsx`、`apply.ts`、`api-proxy.ts`、`host.schema.ts`、`fetch/client.ts`、`fetch/handler.ts`、`workspaces/service.ts`、`fixture.ts`——每一条新增分支都拿到语句/分支/函数/行 100% 覆盖，且是针对**覆盖该文件的完整测试文件集合**核实的（不只是与某次提交同批加入的那一份）：对每个受影响的包跑 `pnpm exec vitest run`，配合按改动源文件精确圈定的 `--coverage.include`。仓库级 `tsc -b tsconfig.host.json` + `tsc -b tsconfig.client.json` 聚合门面（`pnpm run typecheck`）干净，包括本仓库里*每一个* `IApiClient`/`HostApi`/`IWorkspaces` 的实现方（两份 `fake-api.client.ts` 测试替身、`FixtureApiClient`、`TestWorkspaces`，以及两个 host 契约单测里手搭的 `ApiProxy`）——这是设计使然：接口新增一个必需成员，凡是还没实现它的地方编译期就炸。

## 退役条件

A1–A4 各自独立退役，各按自己的上游对等条件（逐条记在 `.claude/core-patches.md`）：A1/A2/A3 在上游自己的会话 UI 对 Assistant 正文长出等价的"提名/验证分层"可点引用能力时一并退役（与原 `proseReferents` 缝隙携带的退役条件相同）；A4 在上游提供 client 可达的等价只读批量路径存在性探针时退役。A5 本身没打补丁，也就无所谓退役。
