# @deepseek-ai/dsh-experimental-content-column

[English](README.md) | 中文

content surface 的浏览器半边。它认领服务形态外壳的 `content` 栏，在一条由 Chrome 风格标签页组成的切换条里列出该会话的 entry，并把选中的那一条交给以 entry 的 kind 为 key 派发的 keyed 槽。它画的是 [`content-surface`](../content-surface/README.zh.md) 发布的 `contentSurface` projection；本包不读任何配置、不提供任何路由，也不认识任何具体的 kind。

node 半边是一个空插件。它存在的意义是让这一行出现在宿主 `cordis.yml` 里，从而使浏览器 bundle 能通过 `dsh.client` 被发现。

## 这一栏与它的 kind 槽

`content` 是外壳那个 `single`、`root` 的栏，因此本注册是它唯一的占用者。每个想要这一栏的 kind 都注册到子槽里，而不是去争夺这个座位：

`'content.surface.kind': { kind: 'keyed'; scope: 'root'; owner: { sessionId, entry } }`

key 域是开放的——它就是宿主 extractor 产生的那个 kind——因此贡献一个渲染器是纯增量的，而无人认领的 kind 会显示这一栏自己的「没有插件能画出它」提示。

**每个已注册 kind 的座位在页面存续期内一直挂着**，在别的 kind 上台时以 `visibility` 隐藏而非卸载。这正是该槽取 root 作用域的全部理由：渲染器可能持有这一栏不得销毁的 DOM——活的 iframe 就是本设计针对的场景——在图表被选中时卸载 page 座位会让每一个 iframe 重新加载。座位列表只追加，理由相同：React 会移动位置发生变化的 keyed 子节点，而移动一个 iframe 会让它重新加载。因此一个座位被渲染的次数远多于它被选中的次数，它靠 `entry`（只有当选中项属于自己时才存在）判断自己处于哪一种状态。

## 选择一条 entry

座位之上是一条切换条，按最新在前列出该会话的 entry，显示 `title` 加 kind key。选择是纯 UI 行为：选项存在按会话 id 索引的组件本地状态里，默认落在最新一条，所指 entry 被替换时回落到最新一条，且永不进入会话日志。什么都没产生过的会话得到空状态提示，没有当前会话的浏览器也一样。

## 关闭一条 entry 的标签页

每个标签页是一个 wrapper `<div>` 里的一对 Chrome 风格兄弟 `<button>`——一个选择按钮（`data-content-surface-entry`、`data-content-surface-selected`）和一个关闭按钮（`data-content-surface-dismiss`，两者携带同一个 `<kind> <entryId>` key）——绝不是按钮嵌按钮。点击关闭按钮会通过 `ctx.remote.commands.execute`（`dismiss.ts`）针对当前会话执行 `/dismiss-content-entry <kind> <entryId>`，走的是 `dsh-experimental-server-sidebar` 的导航菜单为 `show-content-page` 所用的同一条命令通路。命令本身与移除记录的那次 fold 归 `dsh-experimental-content-surface` 的 node 半边所有；本包只负责派发和渲染结果。

关闭一个标签页不会让这一栏变空：一旦被关闭的 entry 离开 `entries`，`selectedEntry` 既有的「所选 entry 已不存活」回落逻辑——此前只被一条被替换的 entry 触发过——会选中最新的那条存活 entry，与任何其他从流中掉出去的 entry 得到的处理完全一样。

本包还为 `dismiss-content-entry` 注册一个空的 `conversation.chat.commandview` 条目，外加折叠它留下的那个空行的样式表，机制与 `content-frame` 为 `show-content-page` 使用的一模一样，只是各自的 `STYLE_ID` 不同——持久的关闭记录才是关键，而不是一条复述用户刚关掉的标签页的聊天消息。这也是本包现在还依赖 `dsh-client-ui-conversation`、并要求 `remote`/`remote.commands` 的原因。

## 组合方式

本行与 [`content-surface`](../content-surface/README.zh.md) 是同一件事的两半：只组合其中一个，得到的要么是空栏，要么是没人画的流。有三个 overlay 同时组合两者——[`content-frame`](../content-frame/overlay/content-column.patch.yml) 的、[`vue2-echarts-tool-poc`](../vue2-echarts-tool-poc/overlay/show-chart-three-column.patch.yml) 的，以及 [content-surface 自己的](../content-surface/overlay/full-surface.patch.yml)「全都要」演示。两半都不属于任何出厂 bundle。

## Model Experience

None, as this row is a browser placement and registers no tool, prompt, or result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **不能钉住** —— 这一栏一次只展示一条 entry，选择也是每会话一个。无法把一条 entry 与另一条并排保留，也没有分屏。
- **选择按浏览器标签页计** —— 它存在组件状态里，因此刷新、第二个标签页、第二台设备都各自从最新一条开始。让它持久化就意味着一个新的被记录事实，而这一栏刻意不具备。
- **切换条上的角标是 kind 原始 key** —— `page`、`chart`。这一栏无法为它并不认识的 kind 本地化名称，目前也没有按 kind 提供标签的贡献点；周围的产品文案是中文，这个角标不是。
- **座位从不释放** —— 出现过一次的 kind 会在页面存续期内一直保有它挂着的座位，哪怕产生它的会话已经不在。这正是保活的保证，其代价是长期打开的标签页会为它见过的每一个 kind 各积攒一个挂着的渲染器。
- **隐藏命令行耦合着一个本包并不拥有的 DOM 形状** —— `hide-empty-command-row.ts` 的选择器要穿过 `ChatNodeSeat.tsx` 的 `data-chat-flow-kind` 属性和 `dsh-client-ui-renderer` 的 `data-slot` 锚点包装，两者都不是本包能指望保持稳定的约定；任一侧的形状变化都会悄悄让这一行不再折叠，而不是响亮地失败（`content-frame` 完全相同的机制承担着同样的脆弱性）。
- **一次关闭没有任何确认界面** —— 点击关闭按钮会立刻触发命令；除了重新导航到（或让 agent 重绘）同一个 `(kind, entryId)`（fold 会把它当作一次普通的新 entry 处理）之外，没有撤销手段。
- **未被 assembled snapshot 覆盖** —— 浏览器侧证据是针对真实组合运行的 Playwright 场景；snapshot 各条重放的是出厂组合，而出厂组合不会组合实验性行。
