# @deepseek-ai/dsh-experimental-server-sidebar

[English](README.md) | 中文

一个固定宽度的产品外壳侧边栏：对出厂的 [`dsh-client-ui-sidebar`](../../client/ui-sidebar/README.zh.md) 的直接替换，彻底移除会话/工作区浏览，代之以三段结构——工作台（一个持久的默认对话）、导航（`@deepseek-ai/dsh-experimental-content-frame` 配置的页面）、我的工作流（用户自己命名的、返回「教过 agent 一些事」的对话的快捷方式）。它在组合里替换 ui-sidebar，而不是与之并存，因为 `sidebar` 是单一槽，其子槽只能被声明一次。

本包面向「客户表单」组合：终端客户在使用产品时，完全不需要知道一个对话是一个背后挂着工作区的、持久可续的对象。每一处会话/工作区管理动作（创建一个、重新连接一个、决定「当前是哪个」）都发生在本包自己的动作内部；这套词汇本身——会话/session、工作区/workspace——被本包所有字典里的每一条字符串禁止出现，组合层也禁用了本会泄漏这些词汇的出厂控件（见下文「去术语化」）。

## 替换出厂侧边栏

- **四个子槽保留**——`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.settings`、`sidebar.footer.action` 保留 `dsh-client-ui-sidebar` 声明的 kind 与 scope，按类型导入复用而非重新写一遍，因此 ui-settings 既有的注册无需改动即可继续工作（填充这两个身份槽的品牌包在客户组合里被禁用——见下文「品牌与英雄区门面」）。`sidebar.workspaces` 被彻底移除：本外壳没有会话浏览区可供它落座。`ui-workspace` 的 `sidebar.workspaces` 注册走的是 `ctx.slots.inject`，这是声明门控的（它等一个声明出现，没有声明就永远不会触发——`SlotRegistry.inject` 自己的约定），而不是一个硬性要求，因此原样组合 `ui-workspace` 不会在启动时抛错，只会让这一半永久失效。客户组合依然从不组合 `ui-workspace`（见下文「组合方式」），因为它另一个注册的目标是 `conversation.hero.workspace`——一个 `dsh-client-ui-conversation` 始终会声明的槽——组合它会在那里复活英雄区的工作区选择菜单。
- **新会话按钮已移除。** 本外壳没有「开一个临时对话」的入口；每一个入口（工作台、一个导航页面、一条我的工作流记录）都在内部自行解析或创建自己的会话。
- **56px 折叠窄栏已移除。** 本外壳从不调用折叠动作，也始终渲染完整内容，无视 `collapsed` 这个 owner prop——这与外层外壳自身轨道几何之间遗留的耦合，见下文「已知限制」。
- **随指针显隐的滚动条行为保持不变**——指针停留在这一栏内时滚动条常驻，离开后再保留两秒，指针在此期间回到栏内会取消挂起的隐藏，按几何坐标而非 DOM 包含关系判断（因此一个作为该栏 DOM 后代渲染的浮层，如 ui-settings 的面板，不会被误判为「指针已离开」）。

## 工作台

工作台是本外壳始终落位的那一个持久默认对话——但落到它上面意味着什么，取决于你是怎么到达这里的。

- **加载**侧边栏且当前没有选中会话时（`openWorkbenchOnLoad`）：解析已记录的 `workbenchSessionId`，只要它仍然存活就重新打开它，无论它已经携带了什么内容——连续性语义：页面精确恢复到离开时的状态。
- **点击**它（`openWorkbenchOnClick`）：则始终落到一张干净的纸上——干净稿语义：只有当已记录的会话既存活、又仍然*干净*时才重新打开它，而干净是两个条件同时成立（`isCleanWorkbenchDraft`）：它没有跑过任何一轮对话（`SessionSummary.blank`），并且它的内容列除了本部署自己配置的首页之外什么都没有携带。未记录、已记录的那个已经不在、已记录的那个跑过一轮、以及已记录的那个内容列上摆着任何别的页面，这几种情况都改走创建路径：针对最近使用的工作区起一个会话，并把 `workbenchSessionId` 重新指向它。这条路径经由 `connectWorkspace` 解析，而它的复用扫描会按会话列表自身的顺序交回工作区里第一个空白会话——通常就是这份草稿本身，若该工作区里另有一个空白会话排在它前面，交回的就是那一个，`workbenchSessionId` 也随之改指（见「已知限制」）；访客在那里得到的是配置好的首页被再次展示，而不是一段新对话。

**单靠 `SessionSummary.blank` 回答不了一次点击。** 这一位只跟踪对话轮次，别的一概不管——独立事件从不把它降下来（见 `dsh-host-apiproxy` 里的 `sessionBlank`）——所以一份访客已经导航过的草稿读出来仍然是空白的：只要点一下「导航」，内容列上就摆着一份已发布的报表，而下一次工作台点击会心安理得地复用这个会话，落到那份报表上，而不是落到一张干净的纸上。因此，这个会话已经在展示什么，构成了这项判断的另一半，它读自会话列表自己的 `projectionValues.contentSurface.entries`——与 `dsh-experimental-server-layout` 的 `ShellFrame` 为内容列自己的空判断所用的，是同一条数据源、同一种防御式无类型读法。配置好的首页是唯一一个不会让草稿失去资格的条目，因为正是点击路径自己把它放上去的（见下文）；若把它算作内容，每一次干净的点击都将无法复用它自己上一次点击刚刚填充好的那份草稿。

两者共用同一套开或建机制（`client/workflow-actions.ts` 的私有函数 `openOrCreateWorkbench`），只在「已记录的会话要满足什么条件才算可复用」这一点上不同。`workbenchSessionId` 是弱引用，理由与下文一条工作流的 `homeSessionId`完全相同：这里没有任何东西拥有会话删除的所有权，一个失效的指针会降级为一个全新对话，而不会污染指名它的那份文档。

加载路径这一侧，挂载时的自动落位会保留它的一次性尝试机会，而不是把它花在一个尚未就绪的工作区基线上：重新打开一个存活的已记录会话完全不需要工作区，但创建一个新会话需要，而 `recentWorkspaceId` 无法区分「工作区基线还没加载完」与「这个部署确实一个工作区都没有」——因此这个 effect 会一直等到出现一个存活的已记录会话、或者一个已解析的工作区，才会去尝试；一旦会话通过任何其他途径变为当前会话，它就永久放弃这次机会。

**配置好的首页只在一次干净的点击上自动展示，绝不出现在加载路径上。** 当 content-frame 的 `homePage` 配置项指名了一个页面时（见下文「导航」），`onOpenWorkbench` 会在 `openWorkbenchOnClick` 刚解析出的那个会话——创建结果得到的新会话，或复用结果得到的那份已存在的干净稿——上，紧接着这次解析一落定就执行 `/show-content-page <homePage>`，让一段新的或干净稿状态的对话打开时内容列已经有内容，而不是空的。一份已经在展示首页的复用草稿会跳过这次调用（`hasShownHomePage`）：那个页面是一份干净稿唯一被允许携带的内容，重复执行这条命令只会为已经摆在眼前的那个页面再追加一条 `content/shown` 记录。这只从点击处理函数里触发：加载路径自己的连续性语义（精确恢复到一个存活会话离开时的状态）会被「把一个页面强加到一个已经携带不同内容的会话上」破坏，因此 `openWorkbenchOnLoad` 从不调用它。这次自动展示是一次普通的 `show-content-page` 调用——它追加的是同一个 `content/shown` 事件，留下的是与用户亲自点击完全相同的持久日志记录。

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

浏览器无法直接调用 `settings.*` RPC——这是一组 loopback 特权方法，经反向代理进来的请求会被外壳自身的信任栅栏答以 403，而不是被反代配置里的某条规则拦下——因此本包的 node 半边是一个可选子节点，只在 `ctx.settings` 与 `ctx.webServer` 同时被组合时才注册这条路由；两者都不存在时侧边栏本身依然可用（导航不受影响），只是我的工作流下面没有东西可展示或持久化。

## 选中高亮

只有一行会标记当前会话，且优先精确匹配：一条工作流若其 `homeSessionId` 等于 `useSessions(state => state.current)`，就会画出高亮；工作台只在「当前会话就是自己的 `workbenchSessionId`」且「没有任何工作流已经绑定这个会话」两个条件同时成立时才画出高亮——工作流的绑定始终优先于工作台，因此一个同时被两者指名的会话，绝不会同时点亮两行。每一行都携带一个布尔型 `data-active` 属性；`ServerSidebarRoot.module.css` 用一圈内嵌的品牌色描边来呈现工作台的高亮态（`.workbench[data-active='true']`），`SidebarGroups.module.css` 则用 `dsh-client-ui-trajectory` 自己给选中行用的同一个 `--dsw-alias-interactive-bg-active` 底色来呈现工作流行的高亮态，把本包的配色继续限定在产品里已经确立过的这套变量之内。

## 身份显示与退出

侧栏底部写明部署方为谁登录了这台工作台，并给出撤销它的那一个控件。两半都不进模型：没有任何会话事件携带这个名字，这里也没有任何东西能到达一次模型请求。

**名字只是用于显示的副本，不是权威。** `client/identity.ts` 从 `localStorage.accessToken` 里读出部署方的访问令牌，剥掉登录页写入的 `Bearer` 前缀，不做任何验证地解码 payload，展示 `Config.displayNameClaim` 指名的那个 claim（本部署所用登录体系里是 `login_uname`）。令牌解不开、claim 不存在或不是字符串、以及页面上压根没有令牌，这三种情况都退回匿名占位（「用户」/「User」）。没有任何东西以这个值为准——有能力验证令牌的是这套进程前面的反向代理，页面加载时它早已判定过对面是谁。名字跟随 `storage` 事件变化，因此另一个标签页换人登录后，这里无需刷新即可跟上。

**退出按固定顺序跑五步，且无论前一步结果如何，每一步都会执行**（`client/sign-out.ts`）。

1. **停掉正在进行的工作**——当前打开的那个对话，以及会话列表中每一个 `running` 为真的对话，都走出厂停止按钮所用的同一条按会话作用域取到的 `conversation.cancel()`。当前打开的那个不看这一位也照停；对空闲会话的停止是宿主直接应答的空操作。这一步最多等三秒：宿主始终不应答的一次取消，只能花掉访客这三秒，而不能把真正丢掉令牌的后四步一并拖住。
2. **`POST /auth-gate/logout`**，让进程不再花用它持有的那枚令牌。请求带 `keepalive`，否则第 5 步的跳转会把这个由文档持有的请求取消掉——这也正是这条请求只发出、不等待的原因：一条被代理挂到自己读超时才断的路由，否则就会把访客扣在一个工作已经停下、令牌下一步就要被丢弃的页面上。
3. **按名字逐个删除登录页自己的存储键**——绝不用 `localStorage.clear()`，那会把外壳自己的私有键、以及同源上其它应用的键一并带走。
4. **清掉镜像 cookie**，用 auth-gate 写入它时逐字一致的 `Path`、`Secure` 与 `SameSite`——其中 `Path` 就是本外壳被服务在其下的部署前缀，两个包用同一种方式解析它（`resolveClientBase`）。
5. **跳转到登录页**，带上 `?redirect=` 与回跳地址：就是当前地址，只把登录页自己的凭证参数（`token`、`token4a`）从查询串与 hash 两处一并剔掉，其余参数逐字节保留它们到达时的样子，hash 里的路由也原样带回——这些页面是 hash 路由的，hash 就是地址。

任何一步失败都只记一条 `console.warn`：访客反正要离开，一步跑不通不构成把其余几步一起放弃的理由。

**逐字复制，而非导入。** `Bearer` 剥离、JWT 解码、`/auth-gate/settings`、`/auth-gate/logout`、那行 cookie 与回跳地址的剔参规则，都是 [`dsh-experimental-auth-gate`](../auth-gate/README.zh.md) 自己那份的复制品，理由与 `client/pages.ts` 复制 content-frame 路由的理由相同：跨包直接导入符号并非本仓库为两个客户端相邻插件设计的耦合方式，而且本侧栏还必须能在压根不组合 auth-gate 的组合里工作。两个包在本 fork 里一同维护，这六项约定必须同步，连同它们各自的寻址方式：两条路由都经 `clientUrl` 请求，那枚 cookie 也在 auth-gate 写入它时所用的同一个部署前缀下清除。

## 配置

| 字段 | 用途 |
| --- | --- |
| `displayNameClaim` | 部署方访问令牌里携带登录者显示名的那个 claim（本部署所用的 toy-core 登录体系里是 `login_uname`）。必填，且在加载期拒绝空白值：无人指名的 claim 会让每一个登录者都显示为匿名，而现场没有任何线索说明原因。 |

它通过又一条同源路由送到 browser 半边，因为 browser 半边收不到任何 cordis 配置——启动清单携带的是插件名，不是它们的 `config` 块：

- `GET /server-menu/identity`——`{ displayNameClaim }`，`cache-control: no-store`。没有任何东西写它；其它方法一律 405 并列出它确实提供的方法集。与 server-menu 路由不同，这一条只需要 `ctx.webServer`：没有组合 settings 能力的部署照样能写明登录者是谁。

## 去术语化

决策②在上述整体重构之上,进一步禁止会话/新会话/session/workspace 出现在本组合渲染的任何用户可见字符串里。还有四处出厂界面携带这套词汇，移除方式与 ui-sidebar/ui-workspace 相同——禁用组合层里的那一行，而不是修改该行自己的文案：

| 界面 | 禁用的行 | 说明 |
| --- | --- | --- |
| Chat/Trajectory 标签页 | `ui-trajectory` | Trajectory 标签页就是 `ui-trajectory` 自己的注册；移除它后只剩一个选项的标签切换器会直接渲染成没有标签控件。 |
| 会话日志下载按钮 | `session-log-download`（`@deepseek-ai/dsh-session-log-export`） | 下载弹窗本身也携带「Session」文案；禁用这一行会同时移除触发按钮与弹窗。 |
| 模型选择器 | `ui-model-selection` | 也是输入框自己「未选模型」阻断态的来源（`ConversationRoot.tsx` 的 `useComposerBlock`）——这一行不在了，就没有任何插件会激活这个阻断态，输入框在完全没有模型选择器的情况下依然可用。 |
| 轮次/步骤状态行 | *（不存在可禁用的行）* | `StatsLine` 是出厂 `ui-conversation` 的一个组件，既没有 Config 开关，自己也没有可禁用的席位——见下文。 |

轮次/步骤状态行没有官方通路可以移除，本包因此退回到一个作用域受限的 CSS 注入：一个仅在客户端运行的 effect（`terminology-guard.ts`）向文档头部插入 `[data-composer-card] + * { display: none !important; }`。`data-composer-card` 是输入框自己的卡片外层（`InputBar.tsx`）；它的下一个兄弟节点是输入框的footer/dock 区域，在出厂组合里这个区域只承载 `StatsLine`（`conversation.composer.dock`，序号 0）——因此今天这条规则恰好只会隐藏轮次/步骤这一行，但它是一个与 DOM 顺序耦合的选择器,不是一个 Config 开关：未来任何插件注册进 `conversation.composer.dock`，或者输入框自身标记结构的一次重排，都会在两边任何测试都察觉不到的情况下，悄悄改变这条规则实际隐藏的内容。本包自己的 e2e 场景（`apps/web/tests/server-sidebar.e2e.ts`）钉住了这一点，一旦这一行重新可见就会让这条门禁失败。

## 品牌与英雄区门面

还有两处界面携带的是 DeepSeek 自己的产品身份或内部状态文案，而不是被禁词汇，出于与上文「去术语化」相同的客户形态理由被替换或移除：

- **侧边栏品牌行。** `sidebar.brand.mark` 完全不渲染 fallback（此前是一个鱼图标）；`sidebar.brand.name` 的 fallback 是一段纯文本——locale key 为 `brand.name.fallback`（「工作台小助手」/「Workbench Assistant」）——不再带构建版本徽标。`@deepseek-ai/dsh-client-ui-brand-official`（仅在官方构建下才占据这两个槽、以及 `conversation.hero.brand.mark`）在客户 overlay 里被彻底禁用；本包自己的 `client/index.ts` 还会在 `conversation.hero.brand.mark` 上以优先级 -1（该槽的遮蔽等级——升序，最低者渲染）注册一个空组件抢占，因此即使某次部署忘记禁用 `ui-brand-official`，英雄区拿到的依然是本包的无图标版本，而不是官方版本。
- **对话英雄区界面。** 空白稿态的英雄区标题（`dsh-client-ui-conversation` 的 `HeroShell`/`ConversationRoot`）携带一个鱼图标、一枚「PREVIEW」状态徽标、以及一行工作区选择器加 agent-preset 选择器——都没有 Config 开关，也没有自己的禁用席位，因此 `terminology-guard.ts` 把它的 CSS 注入扩展为同时：隐藏（此时已经槽位为空的）鱼图标外框和 preview 徽标；把标题文字压到 `font-size: 0`，改用 `::after` 伪元素画上本包自己的品牌文案（原始标题文本节点在 DOM 与无障碍树里原样保留——见「已知限制」）；以及把整行工作区选择器隐藏掉，因为 `ui-workspace` 被禁用（见下文「组合方式」）已经让它变成一个死控件（`WorkspaceChip` 仍然渲染，但打开的菜单没有任何东西去填充）。同一行的另一个席位 `conversation.hero.agentPreset` 则在组合层面清空：`ui-agent-preset` 在两份 overlay 里都被彻底禁用，这同时移除了它只读的会话头部 preset 标签与它的 Settings 行——这两处不是这一条 CSS 规则能够触达的。

## 组合方式

本插件不属于任何出厂 bundle。`overlay/customer.patch.yml` 就是完整的客户表单 overlay：它禁用 `ui-layout`、`ui-sidebar`、`ui-workspace`、`ui-agent-preset`、`ui-brand-official`、`ui-cordis`、`ui-trajectory`、`ui-model-selection`、`session-log-download`，并插入 `server-layout`、`content-surface`、`content-column` 与本包。它不插入 `content-frame`——部署自己的页面目录需要单独组合，与它并列。它同样不插入 [`auth-gate`](../auth-gate/README.zh.md)，而底部那个退出按钮正需要这一行：没有组合它时按钮照样渲染，但按下去只会向控制台报告登录页未知，然后停在原地。两份 overlay 都携带本包那一个必填的 `config` 字段（见上文「配置」）；缺了它的行会在加载期失败。用 `dsh --profile <name> --patch <path>` 应用；该包必须能从 profile 目录解析到——对树外插件而言即 `dsh plugin --profile <name> add <path>` 或等价的链接；发布 bundle 不得声明实验性包。

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
- **`ui-workspace` 被彻底禁用、而非仅仅被隐藏——原因是组合它会复活英雄区的工作区选择器，而不是因为组合它会失败。** 它的 `sidebar.workspaces` 注册在本外壳去掉那个槽之后已经失效（`ctx.slots.inject` 只是永远不会触发——见上文「替换出厂侧边栏」）；真正还会落地的是它的 `conversation.hero.workspace` 注册，因为 `dsh-client-ui-conversation` 始终会声明那个槽。一次零工作区的全新安装,依然会让页面或工作流点击成为一次被吸收的空操作（见上文「导航」）——这是从此前基于收藏的设计里延续下来的、已经被接受的既有边界情况，并非本次新引入。工作台自己的加载态自动落位比这更进一步：这种情况下它根本不会去尝试（见上文「工作台」），而是一直等待工作区出现，而不是先尝试一次再报一次警告。
- **英雄区标题原本的文本节点在 DOM 与无障碍树里原样保留。** `terminology-guard.ts` 的 `::after` 替换只改变了标题画出来的内容（把真实文本压到 `font-size: 0`，另用一个伪元素承载本包自己的文案）；屏幕阅读器或任何针对 DOM 文本的查询，找到的依然是 `dsh-client-ui-conversation` 自己的中/英文标题字符串，而不是本包的品牌文案。
- **退出不会通知部署方自己的登录体系。** 它把本浏览器和本进程持有的令牌就地全部丢弃，并把访客送回登录页；令牌本身在签发方那一侧仍然有效，直到它自己过期——本包不知道任何吊销接口。有这样一个接口的部署，在上面那套顺序的第 2 步调用它即可。
- **没有二次确认。** 一次点击就停掉正在进行的工作并退出登录。停止一个回合会保留该对话及其待处理的排队内容（这里的 `cancel` 就是这个含义），因此误点的代价是重新登录一次，而不是丢失工作。
- **展示的名字是一份非权威副本。** 它是在浏览器里从一枚未经验证的令牌解码得来的；任何能在同源上写 `localStorage` 的人都能改变底部显示的内容。没有任何东西以它为准，所以这买到的只是一个错误的名字。
- **镜像 cookie 的 `Path` 是解析出来的，不是约定出来的。** 两个包都把它收窄到部署前缀，靠的是各自读同一个页面事实、而不是共享某个值；因此如果反向代理把两半服务在不同前缀下，删除指令就只会再写一个空 cookie，把那枚被镜像的令牌原样留下。没有任何东西能察觉这种情况；这份配对由一条把本包的 cookie 行与 auth-gate 自己那行相比的单测证明。
- **停止扫描以 `SessionSummary.running` 为判据。** 一个 running 位尚未推到本浏览器、又不是当前打开的那个对话，不会被停止，宿主侧的回合会一直跑到它自己结束。
- **退出这套流程没有浏览器级证据。** Playwright 场景只断言这个控件渲染出来了、底部那一带装得下它，到此为止：本包的场景没有组合 `auth-gate` 行（那个包会以令牌为门槛拦住整个页面，于是场景里其余每一条断言都得先自带令牌），因此「点退出→cookie 消失→落到登录页」是由针对注入式 browser 的单测覆盖证明的，而不是端到端证明的。
- **settings 路由假定存在 HTTP 载体。** browser 半边请求 `/server-menu/workflows`——node 半边注册的那条路由，按页面的部署基址解析而来。如果某种传输提供了外壳却没有把 harness 暴露在 HTTP 上，该行会失败——与 content-frame 自己那条 settings 路由的处境相同。
- **仅因内容而不干净的草稿并没有真正被顶替。** `isCleanWorkbenchDraft` 会拒绝复用一份内容列上摆着首页以外任何东西的草稿，但它落下去的那条创建路径经由 `resolveOrCreateSession` → `connectWorkspace` 解析，而后者自己的复用扫描会交回工作区里已有的第一个空白会话——一份没有跑过任何一轮的草稿正是其中之一。通常交回的就是这份草稿本身；若该工作区里另有一个空白会话排在它前面，交回的就是那一个，`workbenchSessionId` 也随之改指。无论是哪一种，访客落到的都是一段本就存在的对话上的首页，而他先前导航到的那个页面仍然留在那份草稿的切换条里。要在这里真正起一段新对话，需要一条为这一个调用方绕开那次扫描的创建路径，而那同时也就决定了一次「导航再点工作台」的循环允许留下多少段被抛弃的空白对话——这是本片没有去拍的产品决定。
- **未被 assembled snapshot 覆盖。** 浏览器侧证据是针对真实组合运行的 Playwright 场景；snapshot 各条重放的是出厂组合，而出厂组合不会组合实验性行。
