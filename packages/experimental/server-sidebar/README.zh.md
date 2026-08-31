# @deepseek-ai/dsh-experimental-server-sidebar

[English](README.md) | 中文

一个固定宽度的产品外壳侧边栏：对出厂的 [`dsh-client-ui-sidebar`](../../client/ui-sidebar/README.zh.md) 的直接替换，彻底移除会话/工作区浏览，代之以三段结构——工作台（一个持久的默认对话）、导航（`@deepseek-ai/dsh-experimental-content-frame` 配置的页面）、我的工作流（用户自己命名的、返回「教过 agent 一些事」的对话的快捷方式）。它在组合里替换 ui-sidebar，而不是与之并存，因为 `sidebar` 是单一槽，其子槽只能被声明一次。

本包面向「客户表单」组合：终端客户在使用产品时，完全不需要知道一个对话是一个背后挂着工作区的、持久可续的对象。每一处会话/工作区管理动作（创建一个、重新连接一个、决定「当前是哪个」）都发生在本包自己的动作内部；这套词汇本身——会话/session、工作区/workspace——被本包所有字典里的每一条字符串禁止出现，组合层也禁用了本会泄漏这些词汇的出厂控件（见下文「去术语化」）。

## 替换出厂侧边栏

- **四个子槽保留**——`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.settings`、`sidebar.footer.action` 保留 `dsh-client-ui-sidebar` 声明的 kind 与 scope，按类型导入复用而非重新写一遍，因此 ui-settings 既有的注册、以及任何填充这两个身份槽的品牌包，都无需改动即可继续工作。`sidebar.workspaces` 被彻底移除：本外壳没有会话浏览区可供它落座，客户组合也从不组合 `ui-workspace`（见下文「组合方式」)——原样组合它会在启动时直接抛错，因为它自己的注册目标是本外壳已不再声明的槽。
- **新会话按钮已移除。** 本外壳没有「开一个临时对话」的入口；每一个入口（工作台、一个导航页面、一条我的工作流记录）都在内部自行解析或创建自己的会话。
- **56px 折叠窄栏已移除。** 本外壳从不调用折叠动作，也始终渲染完整内容，无视 `collapsed` 这个 owner prop——这与外层外壳自身轨道几何之间遗留的耦合，见下文「已知限制」。
- **随指针显隐的滚动条行为保持不变**——指针停留在这一栏内时滚动条常驻，离开后再保留两秒，指针在此期间回到栏内会取消挂起的隐藏，按几何坐标而非 DOM 包含关系判断（因此一个作为该栏 DOM 后代渲染的浮层，如 ui-settings 的面板，不会被误判为「指针已离开」）。

## 工作台

工作台是本外壳始终落位的那一个持久默认对话——但落到它上面意味着什么，取决于你是怎么到达这里的。

- **加载**侧边栏且当前没有选中会话时（`openWorkbenchOnLoad`）：解析已记录的 `workbenchSessionId`，只要它仍然存活就重新打开它，无论它已经携带了什么内容——连续性语义：页面精确恢复到离开时的状态。
- **点击**它（`openWorkbenchOnClick`）：则始终落到一张干净的纸上——空稿语义：只有当已记录的会话既存活、又仍然空白（`SessionSummary.blank`）时才重新打开它；未记录、已记录的那个已经不在、或已记录的那个已经携带了内容，这三种情况都会针对最近使用的工作区创建一个新会话，并把 `workbenchSessionId` 重新指向它。

两者共用同一套开或建机制（`client/workflow-actions.ts` 的私有函数 `openOrCreateWorkbench`），只在「已记录的会话要满足什么条件才算可复用」这一点上不同。`workbenchSessionId` 是弱引用，理由与下文一条工作流的 `homeSessionId`完全相同：这里没有任何东西拥有会话删除的所有权，一个失效的指针会降级为一个全新对话，而不会污染指名它的那份文档。

加载路径这一侧，挂载时的自动落位会保留它的一次性尝试机会，而不是把它花在一个尚未就绪的工作区基线上：重新打开一个存活的已记录会话完全不需要工作区，但创建一个新会话需要，而 `recentWorkspaceId` 无法区分「工作区基线还没加载完」与「这个部署确实一个工作区都没有」——因此这个 effect 会一直等到出现一个存活的已记录会话、或者一个已解析的工作区，才会去尝试；一旦会话通过任何其他途径变为当前会话，它就永久放弃这次机会。

**配置好的首页只在一次干净的点击上自动展示，绝不出现在加载路径上。** 当 content-frame 的 `homePage` 配置项指名了一个页面时（见下文「导航」），`onOpenWorkbench` 会在 `openWorkbenchOnClick` 刚解析出的那个会话——创建结果得到的新会话，或复用结果得到的那个已存在的空稿——上，紧接着这次解析一落定就执行 `/show-content-page <homePage>`，让一段新的或空稿状态的对话打开时列内容列已经有内容，而不是空的。这只从点击处理函数里触发：加载路径自己的连续性语义（精确恢复到一个存活会话离开时的状态）会被「把一个页面强加到一个已经携带不同内容的会话上」破坏，因此 `openWorkbenchOnLoad` 从不调用它。这次自动展示是一次普通的 `show-content-page` 调用——它追加的是同一个 `content/shown` 事件，留下的是与用户亲自点击完全相同的持久日志记录，它本身也不计入 `SessionSummary.blank`（见 `dsh-host-apiproxy` 里的 `sessionBlank`），所以一个只收到过自己首页的空稿会话读出来仍然是空白的。

## 导航

导航列出 `@deepseek-ai/dsh-experimental-content-frame` 配置的页面，在本条目注册之前一次性从它的 `/content-frame/settings` 路由读取（写死的路由路径与本地校验的 JSON 形状，不是导入的值或类型——跨包直接导入符号并非本仓库为两个客户端相邻插件设计的耦合方式）。点击一个页面会针对当前会话执行 content-frame 的 `show-content-page` 命令（没有会话打开时先创建一个，走工作台与每一条工作流动作共用的同一套解析——见 `client/session-resolution.ts`），通过 `ctx.remote.commands.execute`——这是会话日志能够重放的命令通路，而非直接的服务调用。该命令的处理函数追加 `by: 'user'` 的 `content/shown`。导航顺序跟随部署配置顺序，绝不由用户重新排序（决策⑤）。

同一份响应还携带 content-frame 可选的 `homePage` 字段（`pages.ts` 的 `readContentPages`），与页面列表一起一次性读取，供上文工作台的点击处理函数使用。这里的坏值是被兜住的，而不是抛出：与节点侧会让整次加载失败的 `Config` 校验不同，浏览器侧这次读取只用 `console.warn` 报告一个非字符串或指名了未配置页面的值，并把 `homePage` 当作缺失处理——一个承载着关键功能的外壳表面，不应该因为一个配置错误的字段就让原本正常工作的部署整体倒下。

## 我的工作流

我的工作流是用户自己命名的快捷方式，按账号持久化（对应这一部署形态「一个用户一个进程」的形状——这里的「按账号」即「按 `$DSH_HOME`」）。v1 中一条工作流恰好绑定一个对话（v1 边界，见「已知限制」）：`{id, name, order, homeSessionId, navSnapshot, savedAt}`。

- **存**——「存为工作流」动作坐落在对话自己的会话头部（`conversation.session.header.actions`，序号 30，排在子代理目录与后台任务之后），而不是侧边栏上的一个「+」按钮：一个面向会话级、偶发动作的常规席位已经存在，为同一类动作再引入一种新的交互模式没有正当理由。它只在当前对话至少携带一条用户自己写下的消息时才可见（决策③，通过 `chat.legacy.nodes` 判断——这一 v1 近似的边界见「已知限制」），这符合直觉：工作流是回到一个用户真正开始过的对话的快捷方式,而不是一个空对话的快捷方式。保存时会把当前会话 id 记为 `homeSessionId`，把 content 栏当下展示的页面 id（从旧到新）记为 `navSnapshot`。
- **开**——点击一条工作流,在其 `homeSessionId` 仍然存活时直接重新打开它。**恢复只补齐缺失的部分**（决策⑦）：重新打开一个存活会话从不触碰它的内容，因为没有任何缺失需要补齐。
- **降级**（决策⑧）——当 `homeSessionId` 已经不在时，打开这条工作流会针对最近使用的工作区创建一个新会话，按顺序（从旧到新，因此最后重放的那一个会停留在展示位，与保存这条工作流时展示的内容一致）把 `navSnapshot` 重放到新会话上，并把 `homeSessionId` 重新指向这个新会话。一个全新会话从空白开始，因此「补齐缺失的部分」在此就是重放整份快照。
- **改名／移除**——用悬停显现的图标按钮（沿用原收藏菜单自己的交互习惯），而非原生右键菜单；见「已知限制」。
- **重新排序**——原生 HTML5 拖拽：每一行都是 `draggable`，把一行拖到另一行的上半或下半时，会在那里预览一条插入线（纯 CSS）；放开后经由 `reordered()`（`client/workflow-actions.ts`）提交，它会把每一条工作流的 `order` 字段整体重写为拖放后的显示位置（0..n-1）——是一次整体重写，而非成对交换，因此无论此前的取值是什么，任何一次放置都会产生一份干净、连续的顺序。这跟随用户的拖拽顺序（决策⑤）。
- **未读提示**（决策④）——一条工作流所绑定的 `homeSessionId` 若有尚未查看的产出，会显示绿点，原样复用会话列表自己的 `completed` 位（「运行结束时未被选中、且尚未被打开过」），而不是原始任务提议作为备选方案的第二套「最后查看时间」记账机制：`completed` 本身的语义与此完全吻合,并且 `sessions.open` 一旦选中该会话就会立即清除它。为什么这一机制只有单测覆盖、没有端到端覆盖，见「已知限制」。
- **被顶掉的对话不会被删除。** 一次工作台点击若落到一个全新会话上（见上文「工作台」），并不会删除被它顶掉的那一个：若某条工作流已经绑定它，那条工作流会继续原样管着它；若没有任何东西绑定它，它就只是不再被任何东西指着而已。本组合没有会话概念可供用户查看或清理（决策②），因此一个未被绑定的、被顶掉的对话只会自然淡出，不需要任何处置。

持久文档（`{workflows, workbenchSessionId}`）存在本包自己的 settings 命名空间里，并在一条同源路由上对外提供：

- `GET /server-menu/workflows`——当前文档，`cache-control: no-store`。
- `POST /server-menu/workflows`——把提交的补丁（`{workflows?, workbenchSessionId?}`）**合并**进当前文档，而不是整体替换，因此只改 `workbenchSessionId` 的调用方从不需要重新提交当前的工作流列表,反之亦然。合并结果中出现重复的工作流 id,会在提交前被拒绝,路由的 `validate` 钩子与本包的 invariant 各自把关一次。

浏览器无法直接调用 `settings.*` RPC——这是一组反向代理会以 403 拒绝的 loopback 特权方法——因此本包的 node 半边是一个可选子节点，只在 `ctx.settings` 与 `ctx.webServer` 同时被组合时才注册这条路由；两者都不存在时侧边栏本身依然可用（导航不受影响），只是我的工作流下面没有东西可展示或持久化。

## 选中高亮

只有一行会标记当前会话，且优先精确匹配：一条工作流若其 `homeSessionId` 等于 `useSessions(state => state.current)`，就会画出高亮；工作台只在「当前会话就是自己的 `workbenchSessionId`」且「没有任何工作流已经绑定这个会话」两个条件同时成立时才画出高亮——工作流的绑定始终优先于工作台，因此一个同时被两者指名的会话，绝不会同时点亮两行。每一行都携带一个布尔型 `data-active` 属性；`ServerSidebarRoot.module.css` 用一圈内嵌的品牌色描边来呈现工作台的高亮态（`.workbench[data-active='true']`），`SidebarGroups.module.css` 则用 `dsh-client-ui-trajectory` 自己给选中行用的同一个 `--dsw-alias-interactive-bg-active` 底色来呈现工作流行的高亮态，把本包的配色继续限定在产品里已经确立过的这套变量之内。

## 去术语化

决策②在上述整体重构之上,进一步禁止会话/新会话/session/workspace 出现在本组合渲染的任何用户可见字符串里。还有四处出厂界面携带这套词汇，移除方式与 ui-sidebar/ui-workspace 相同——禁用组合层里的那一行，而不是修改该行自己的文案：

| 界面 | 禁用的行 | 说明 |
| --- | --- | --- |
| Chat/Trajectory 标签页 | `ui-trajectory` | Trajectory 标签页就是 `ui-trajectory` 自己的注册；移除它后只剩一个选项的标签切换器会直接渲染成没有标签控件。 |
| 会话日志下载按钮 | `session-log-download`（`@deepseek-ai/dsh-session-log-export`） | 下载弹窗本身也携带「Session」文案；禁用这一行会同时移除触发按钮与弹窗。 |
| 模型选择器 | `ui-model-selection` | 也是输入框自己「未选模型」阻断态的来源（`ConversationRoot.tsx` 的 `useComposerBlock`）——这一行不在了，就没有任何插件会激活这个阻断态，输入框在完全没有模型选择器的情况下依然可用。 |
| 轮次/步骤状态行 | *（不存在可禁用的行）* | `StatsLine` 是出厂 `ui-conversation` 的一个组件，既没有 Config 开关，自己也没有可禁用的席位——见下文。 |

轮次/步骤状态行没有官方通路可以移除，本包因此退回到一个作用域受限的 CSS 注入：一个仅在客户端运行的 effect（`terminology-guard.ts`）向文档头部插入 `[data-composer-card] + * { display: none !important; }`。`data-composer-card` 是输入框自己的卡片外层（`InputBar.tsx`）；它的下一个兄弟节点是输入框的footer/dock 区域，在出厂组合里这个区域只承载 `StatsLine`（`conversation.composer.dock`，序号 0）——因此今天这条规则恰好只会隐藏轮次/步骤这一行，但它是一个与 DOM 顺序耦合的选择器,不是一个 Config 开关：未来任何插件注册进 `conversation.composer.dock`，或者输入框自身标记结构的一次重排，都会在两边任何测试都察觉不到的情况下，悄悄改变这条规则实际隐藏的内容。本包自己的 e2e 场景（`apps/web/tests/server-sidebar.e2e.ts`）钉住了这一点，一旦这一行重新可见就会让这条门禁失败。

## 组合方式

本插件不属于任何出厂 bundle。`overlay/customer.patch.yml` 就是完整的客户表单 overlay：它禁用 `ui-layout`、`ui-sidebar`、`ui-workspace`、`ui-cordis`、`ui-trajectory`、`ui-model-selection`、`session-log-download`，并插入 `server-layout`、`content-surface`、`content-column` 与本包。它不插入 `content-frame`——部署自己的页面目录需要单独组合，与它并列。用 `dsh --profile <name> --patch <path>` 应用；该包必须能从 profile 目录解析到——对树外插件而言即 `dsh plugin --profile <name> add <path>` 或等价的链接；发布 bundle 不得声明实验性包。

## Model Experience

无，本包管理的是浏览器侧的查看状态与用户驱动的工作流文档；它执行的命令本身运行在任何模型轮次之外，不会进入模型请求。

#### KV Cache effect

无；本包既不装配也不发送任何 provider 请求。

## Known Limitations and Deferred Work

- **字面上的 240px 并非独立强制的。** 本外壳从不固定一个内联像素宽度；它按其 owner（`dsh-experimental-server-layout`）交给它的 `width` 渲染，也从不触发折叠。`server-layout` 冻结的 3:16:5 轨道比例恰好在其自身 1920px 参考帧宽下等于 240px（`1920 * 3/24 = 240`），但在任何其他帧宽下这一栏是等比例的，而非固定的。要让它真正固定，需要改动 `server-layout` 自己那份冻结、刻意不可配置的几何设定，这超出了本次改动的范围。
- **决策③的用户消息判断是一个分页窗口内的近似值。** 「存为工作流」的可见性读取 `useSession(s => s.chat.legacy.nodes)`，与 `StatsLine.tsx` 读取的是同一个分页会话快照窗口——一条足够早、已经分页出这个窗口的用户消息不会被发现。要做到整份日志级别的判断，需要新增一个本 v1 没有引入的持久投影。
- **轮次/步骤状态行由一个与 DOM 顺序耦合的 CSS 选择器隐藏，而非一个 Config 开关。** 具体的脆弱之处与钉住它的手段见上文「去术语化」。
- **`navSnapshot` 从不捕获图表（chart）类型的条目。** `captureNavSnapshot` 只筛选 content-surface 投影里 `kind === 'page'` 的条目；在图表占据 content 栏时保存的工作流,重放降级时只会重放页面条目，图表不会出现在降级重建后的对话里。
- **绿点机制复用了 `completed`，而非新记账，且只有单测覆盖。** 它与「运行结束时未被选中、且尚未被打开过」的语义完全吻合，但要做到端到端验证，需要一次真实的、agent 循环从运行到空闲、且未被选中期间发生的状态切换——`SessionManager` 的 `running` 位是绑定真实执行的 host frame 推送，纯日志追加无法伪造它。本场景自己的 e2e 套件不发起任何模型调用（沿用其既有设计），因此这一机制改由 `packages/experimental/server-sidebar` 自己的单元测试钉住。
- **改名/移除用悬停显现的图标按钮，而非原生右键菜单。** 这是任务本身明确允许的 v1 降级（「若实现体量失控，降级为右键菜单「上移/下移」」）——这条降级条款曾经也覆盖重新排序，直到重新排序改为原生 HTML5 拖拽为止；改名/移除这一半的降级依然保留，因为为这两个偶发动作再引入第二种交互模式依然没有正当理由。
- **`ui-workspace` 是不被组合，而非仅仅被隐藏。** 一次零工作区的全新安装,依然会让页面或工作流点击成为一次被吸收的空操作（见上文「导航」）——这是从此前基于收藏的设计里延续下来的、已经被接受的既有边界情况，并非本次新引入。工作台自己的加载态自动落位比这更进一步：这种情况下它根本不会去尝试（见上文「工作台」），而是一直等待工作区出现，而不是先尝试一次再报一次警告。
- **settings 路由假定存在 HTTP 载体。** browser 半边以页面 origin 为基准请求 `/server-menu/workflows`。如果某种传输提供了外壳却没有把 harness 暴露在 HTTP 上，该行会失败——与 content-frame 自己那条 settings 路由的处境相同。
- **未被 assembled snapshot 覆盖。** 浏览器侧证据是针对真实组合运行的 Playwright 场景；snapshot 各条重放的是出厂组合，而出厂组合不会组合实验性行。
