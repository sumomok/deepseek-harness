# Agent Note：server-sidebar 改造——从「页面路由+收藏」菜单到固定三段结构的产品外壳

Status: implemented

[English](2026-08-30-server-sidebar-product-console-retrofit.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-server-sidebar` 出厂时是一个坐落在出厂侧边栏契约内、其余部分保持不变的菜单（页面路由加收藏会话）——见 [`2026-08-29-server-sidebar-replaces-ui-sidebar.md`](2026-08-29-server-sidebar-replaces-ui-sidebar.zh.md)。此后一项产品决策为面向客户的部署批准了另一种形态：固定宽度、无折叠的一栏，三段结构（工作台/导航/我的工作流）取代整个会话浏览，一个有条件的「把当前对话存为工作流」动作，一个未读提示，导航按部署顺序而工作流按用户顺序排列，一条工作流恰好绑定一个对话，恢复只补齐缺失部分的语义，以及绑定对话丢失时降级为一个全新对话——一共八项决策，「菜单+收藏」的设计一项都不满足，其中几项（任何地方都不出现会话词汇、没有折叠交互）还与它正面冲突。

## Decision

**替换外壳的契约，而不只是替换内容。** `sidebar.workspaces`——`ServerSidebarRoot` 从 `dsh-client-ui-sidebar` 复用来给 ui-workspace 浏览区用的那个子槽——被彻底移除；已经没有会话浏览区可供它落座，客户组合现在会把 `ui-workspace` 和 `ui-sidebar` 一并禁用，而不是原样组合它（原样组合会在启动时直接抛错——为什么这是对 [replaces-ui-sidebar 笔记](2026-08-29-server-sidebar-replaces-ui-sidebar.zh.md) 的一次部分反转、而非一次全新设计，见该笔记的后续更新）。新会话按钮与 56px 折叠窄栏以同样方式移除：本外壳从不调用折叠动作，始终渲染完整内容，接受与 `server-layout` 冻结的等比例轨道之间遗留的几何耦合，把它记为一条已知限制，而不是去改动那个包自己冻结的比例。

**收藏 schema 升级为工作流 schema**，从 `{sessionId, label, order}` 升级为 `{id, name, order, homeSessionId, navSnapshot, savedAt}`。`sessionId` 那条「弱引用、在渲染或动作发生时才解析」的前提（[`2026-08-29-favorites-weak-session-reference.md`](2026-08-29-favorites-weak-session-reference.zh.md)）延续到 `homeSessionId` 与新增的 `workbenchSessionId` 字段——那套推理里没有任何一点是「收藏」这个概念特有的。没有延续下来的，是失效如何被呈现出来：收藏菜单把一个失效引用渲染成一行可见的、禁用的记录，留给用户自己注意并手工清理；决策⑧则要求打开一条失效的工作流或工作台时，同一次点击就把用户带进一个可用的对话，去降级并重新指向，而不是展示一个死状态（具体见姊妹笔记自己更新后的说法）。

**settings 路由从整体替换变成合并。** 收藏路由的 `POST` 会整体替换整份文档；工作流路由的 `POST` 把提交的补丁合并进去（`scope.update`，而非 `scope.replace`），因此工作台创建路径可以只持久化 `{workbenchSessionId}`，工作流保存也可以只持久化 `{workflows}`，双方都不需要提前知道另一个字段的当前值。

**八项决策与具体机制的对应如下：**

| 决策 | 机制 |
| --- | --- |
| ① 固定 240px、无折叠 | `ServerSidebarRoot` 从不触发折叠；宽度来自 owner prop，与 `server-layout` 自身几何的一致性未被独立强制（已知限制） |
| ② 去术语化 | 四条禁用行（`ui-workspace`、`ui-cordis`\*、`ui-trajectory`、`ui-model-selection`、`session-log-download`）加一条针对轮次/步骤行的 CSS 注入兜底（`terminology-guard.ts`），因为它没有 Config 开关 |
| ③ 有条件的存为工作流 | `SaveWorkflowAction` 在 `useSession(s => s.chat.legacy.nodes)` 里找不到 `kind === 'user'` 的节点时渲染 `null` |
| ④ 未读提示 | 原样复用 `SessionSummary.completed`——没有新记账 |
| ⑤ 导航按配置顺序、工作流按拖拽顺序 | `NavGroup` 按给定的 `pages` 顺序渲染；`WorkflowGroup` 按用户可改的 `order` 字段排序 |
| ⑥ 一条工作流绑一个对话（v1） | `ServerMenuWorkflow.homeSessionId` 是单个字段，不是一个列表 |
| ⑦ 恢复只补齐缺失部分 | 存活的 `homeSessionId` 重新打开时不触碰任何内容；只有降级（已失效）的那种才会重放任何东西，且重放进的是一个从空白开始的会话 |
| ⑧ 降级为一个全新对话 | `openWorkflow`/`openWorkbench` 在记录的 id 不再存活时，针对最近使用的工作区创建一个会话并重放 `navSnapshot` |

\* `ui-cordis` 是这次去术语化排查里一并识别出、与另外三行一起在客户 overlay 里被禁用的。

**「存为工作流」坐落在 `conversation.session.header.actions`，而不是侧边栏上的一个控件。** `dsh-client-ui-conversation` 已经为会话级、偶发动作声明了这个可叠加的列表槽（`ui-jobs` 的后台任务条目就是现成的先例）；一旦找到匹配的官方席位，再引入第二种交互模式（侧边栏「+」按钮，原始任务书把它作为备选方案提出）就没有正当理由了。这个注册与侧边栏自己的注册在同一个 `apply()` 里，通过一个普通变量（`sidebarActions`）闭包共享——侧边栏自己一旦挂载就会设置它：两个注册的 scope key 不同（root 对 session），store 框架永远不会在它们之间共享同一个实例，一个模块级的共享闭包是能让一条刚保存的工作流不刷新页面就进入侧边栏自己响应式列表的最小修法。

## Alternatives considered

**用 `SessionSummary.blank` 而非 `chat.legacy.nodes` 扫描来判断决策③的开关。** 放弃，改用更精确的判断：`blank` 回答的是「这个会话有没有记录过任何东西」，比「用户有没有打过字」更粗——一个只携带 agent 自己注入的指令、从未有用户消息的会话，仍然会读作「非空白」。按节点 kind 扫描的做法与 `StatsLine.tsx` 自己既有的、针对同一个会话快照窗口的读取方式一致，代价是 README「已知限制」里记录的那条分页窗口近似。

**为决策④单独引入一套「最后查看时间」记账（一个新 settings 字段，每次查看都更新）。** 一旦确认 `SessionSummary.completed` 的确切语义（「运行结束时未被选中、且尚未被打开过」，`sessions.open` 一旦选中该会话就会立即清除）已经原样回答了一套定制机制本要去回答的同一个问题，且不需要任何额外的持久化或事件接线，这条路径就被放弃了。代价是一处 e2e 缺口：`completed` 是绑定真实 agent 循环从运行到空闲切换的 host frame 推送，本场景零模型调用的 e2e 套件无法伪造它，因此这一机制只有单测覆盖（见包 README）。

**拖拽重新排序，以及原生右键菜单来做改名/移除/重新排序。** 两者都是任务书本身的字面要求，且各自都带有明确的降级条款（「若实现体量失控，降级为右键菜单「上移/下移」」）。考虑到本次改动本身的体量已经很大（一次完整的外壳重写、一次 schema 迁移、一次路由语义变更、加一次四行的去术语化排查，全部塞进一个 PR），两者都被降级：重新排序降级为上移/下移图标按钮，改名/移除/重新排序降级为原收藏菜单已经在用的悬停显现图标按钮习惯。两处降级都不改变底层数据模型（`order` 依然是一个普通的可排序字段；以后要加拖拽或右键菜单，没有任何结构性障碍）。

**直接改 `StatsLine.tsx` 本身（加一个 Config 开关，或者穿一个 prop 控制它的可见性），而不是退回 CSS 注入兜底。** 这一 v1 里放弃了这条路：`StatsLine` 是出厂 `dsh-client-ui-conversation` 的一个组件，没有现成的可见性缝隙，为了一个实验性组合的需要专门给它加一个,正是姊妹笔记 `2026-08-29-server-sidebar-replaces-ui-sidebar.md` 已经为另一个槽拒绝过的「为一次实验性部署扩张官方界面」模式。CSS 注入兜底被刻意记录为脆弱的（与 DOM 顺序耦合，隐藏的是整个 `conversation.composer.dock` 区域而非那一行本身），并且用 e2e 钉住，让未来一次 DOM 重排直接让门禁失败，而不是悄悄把被禁词汇重新泄漏回页面上。

## Consequences

想要这次改造的部署,组合的是 `overlay/customer.patch.yml`（在此前 `ui-layout`/`ui-sidebar` 替换之上,再加四条新的禁用行），而不再是已经不存在的 `overlay/sidebar-menu.patch.yml`——本包没有为一个还想加载收藏时代形态的组合提供任何兼容路径，这与本仓库的预发布立场一致（没有外部消费者，不设兼容垫片）。

`sidebar.workspaces` 的移除是对前一份笔记「复用出厂五个子槽」这一决策的部分反转；那份笔记已就地更新，记录了这一移除并向本笔记做正向交叉引用，而不是被重写——因为它自己的核心决策（通过 overlay 模式整体替换侧边栏）并未改变。`2026-08-29-favorites-weak-session-reference.md` 同样已就地更新：其「弱引用、在渲染时才解析」的前提未变，但它自己的「Decision」与「Alternatives considered」现在描述的是当前的术语（`workflow`/`homeSessionId`）与当前的失效处理方式（打开时降级并重新指向，而非一行可见的禁用记录）——已退役的灰显行处理方式被记录在那里作为一个被取代的备选方案，而不是被删掉，并带一条指向本笔记的正向交叉引用，说明这次产品层面的改名。

本次部署不再组合的五个包（`ui-workspace`、`ui-cordis`、`ui-trajectory`、`ui-model-selection`、`session-log-download`）在其他任何组合里依然完全可用；这次改动没有触碰这些包本身，只改动了这一个实验性 overlay 自己的行列表。
