---
description: "内容面的浏览器半边：占据服务线外壳的内容列，用切换条列出会话的条目，并把选中的那条派发到按 kind 索引的槽；面向组合或扩展这一列的维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-content-column

[English](README.md) | 中文

## 概述

content surface 的浏览器半边。它认领服务形态外壳的 `content` 栏，在一条由 Chrome 风格标签页组成的切换条里列出该会话的 entry，并把选中的那一条交给以 entry 的 kind 为 key 派发的 keyed 槽。它画的是 [`content-surface`](../content-surface/README.zh.md) 发布的 `contentSurface` projection；本包不读任何配置、不提供任何路由，也不认识任何具体的 kind。

node 半边是一个空插件。它存在的意义是让这一行出现在宿主 `cordis.yml` 里，从而使浏览器 bundle 能通过 `dsh.client` 被发现。

## 目录

- [这一栏与它的 kind 槽](#the-column-and-its-kind-slot)
- [选择一条 entry](#choosing-an-entry)
- [关闭一条 entry 的标签页](#closing-an-entrys-tab)
- [组合方式](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="the-column-and-its-kind-slot"></a>
## 这一栏与它的 kind 槽

`content` 是外壳那个 `single`、`root` 的栏，因此本注册是它唯一的占用者。每个想要这一栏的 kind 都注册到子槽里，而不是去争夺这个座位：

`'content.surface.kind': { kind: 'keyed'; scope: 'root'; owner: { sessionId, entry } }`

key 域是开放的——它就是宿主 extractor 产生的那个 kind——因此贡献一个渲染器是纯增量的，而无人认领的 kind 会显示这一栏自己的「没有插件能画出它」提示。

**每个已注册 kind 的座位在页面存续期内一直挂着**，在别的 kind 上台时以 `visibility` 隐藏而非卸载。这正是该槽取 root 作用域的全部理由：渲染器可能持有这一栏不得销毁的 DOM——活的 iframe 就是本设计针对的场景——在图表被选中时卸载 page 座位会让每一个 iframe 重新加载。座位列表只追加，理由相同：React 会移动位置发生变化的 keyed 子节点，而移动一个 iframe 会让它重新加载。因此一个座位被渲染的次数远多于它被选中的次数，它靠 `entry`（只有当选中项属于自己时才存在）判断自己处于哪一种状态。

<a id="choosing-an-entry"></a>
## 选择一条 entry

座位之上是一条切换条，按最新在前列出该会话的 entry，每个标签页只显示该 entry 的 title——kind 是这一栏把 entry 派发到座位的依据，不是拿给用户看的词。选择是一次**被记录的决定**：点击立刻挪动这一栏，同时通过 `ctx.remote.commands.execute`（`select.ts`）针对当前会话派发 `/select-content-entry <kind> <entryId>`，它随后作为流自己的 `front` 回来。什么都没产生过的会话得到空状态提示，没有当前会话的浏览器也一样。

留在组件本地的只有每会话一次点击，而且只在按钮与「这次点击的记录抵达」之间持有——root 作用域的一栏意味着框架在会话切换时什么都不清，所以这次点击由这一栏自己拿着。它在此之前会让位给任何在点击之后被记录的 entry，好让 agent 展示的页面落在用户片刻前选中的标签之前；这与宿主对 `front` 采用的规则相同，两边都按 `seq` 比对的原因就在这里。刚加载出来的页面完全不持有点击，读的是 `front`，因此用户选中的那个标签能挺过刷新、第二个标签页和第二台设备。

本包同样为 `select-content-entry` 注册一个空的 `conversation.chat.commandview` 条目，理由与下文的 `dismiss-content-entry` 相同：持久记录才是关键，而不是一条复述用户刚点过的标签的聊天行。

<a id="closing-an-entrys-tab"></a>
## 关闭一条 entry 的标签页

每个标签页是一个 wrapper `<div>` 里的一对 Chrome 风格兄弟 `<button>`——一个选择按钮（`data-content-surface-entry`、`data-content-surface-selected`）和一个关闭按钮（`data-content-surface-dismiss`，两者携带同一个 `<kind> <entryId>` key）——绝不是按钮嵌按钮。点击关闭按钮会通过 `ctx.remote.commands.execute`（`dismiss.ts`）针对当前会话执行 `/dismiss-content-entry <kind> <entryId>`，走的是 `dsh-experimental-server-sidebar` 的导航菜单为 `show-content-page` 所用的同一条命令通路。命令本身与移除记录的那次 fold 归 `dsh-experimental-content-surface` 的 node 半边所有；本包只负责派发和渲染结果。

关闭一个标签页不会让这一栏变空：一旦被关闭的 entry 离开 `entries`，`selectedEntry` 既有的「所选 entry 已不存活」回落逻辑——此前只被一条被替换的 entry 触发过——会选中最新的那条存活 entry，与任何其他从流中掉出去的 entry 得到的处理完全一样。

本包也为 `dismiss-content-entry` 注册一个空的 `conversation.chat.commandview` 条目，外加折叠两者留下的那个空行的样式表，机制与 `content-frame` 为 `show-content-page` 使用的一模一样，只是各自的 `STYLE_ID` 不同——持久的关闭记录才是关键，而不是一条复述用户刚关掉的标签页的聊天消息。这也是本包现在还依赖 `dsh-client-ui-conversation`、并要求 `remote`/`remote.commands` 的原因。

<a id="composition"></a>
## 组合方式

本行与 [`content-surface`](../content-surface/README.zh.md) 是同一件事的两半：只组合其中一个，得到的要么是空栏，要么是没人画的流。有三个 overlay 同时组合两者——[`content-frame`](../content-frame/overlay/content-column.patch.yml) 的、[`vue2-echarts-tool-poc`](../vue2-echarts-tool-poc/overlay/show-chart-three-column.patch.yml) 的，以及 [content-surface 自己的](../content-surface/overlay/full-surface.patch.yml)「全都要」演示。两半都不属于任何出厂 bundle。

<a id="model-experience"></a>
## Model Experience

None, as this row is a browser placement and registers no tool, prompt, or result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


- **一次选择是发完就走** —— 这一栏在点击时就挪动，命令若始终没落地只在控制台告警，因此丢包会让浏览器展示着日志并不指名的那个标签；下一次刷新会回到 `front`。
- **不能钉住** —— 这一栏一次只展示一条 entry，选择也是每会话一个。无法把一条 entry 与另一条并排保留，也没有分屏。
- **一个标签页只说自己的 title** —— 标题读起来相近的两条 entry 只能靠选中来分辨，因为标签页上没有任何东西说明它是哪一种 kind。这一栏无法为它并不认识的 kind 起名，也没有让 kind 自报名称的按 kind 标签贡献点。
- **座位从不释放** —— 出现过一次的 kind 会在页面存续期内一直保有它挂着的座位，哪怕产生它的会话已经不在。这正是保活的保证，其代价是长期打开的标签页会为它见过的每一个 kind 各积攒一个挂着的渲染器。
- **隐藏命令行耦合着一个本包并不拥有的 DOM 形状** —— `hide-empty-command-row.ts` 的选择器要穿过 `ChatNodeSeat.tsx` 的 `data-chat-flow-kind` 属性和 `dsh-client-ui-renderer` 的 `data-slot` 锚点包装，两者都不是本包能指望保持稳定的约定；任一侧的形状变化都会悄悄让这一行不再折叠，而不是响亮地失败（`content-frame` 完全相同的机制承担着同样的脆弱性）。
- **一次关闭没有任何确认界面** —— 点击关闭按钮会立刻触发命令；除了重新导航到（或让 agent 重绘）同一个 `(kind, entryId)`（fold 会把它当作一次普通的新 entry 处理）之外，没有撤销手段。
- **未被 assembled snapshot 覆盖** —— 浏览器侧证据是针对真实组合运行的 Playwright 场景；snapshot 各条重放的是出厂组合，而出厂组合不会组合实验性行。

**运行时不变式：** 不发布伴生入口。本包是一个浏览器落位：它的宿主半边是空插件，不追加任何会话事件，而它画出来的 entry 流属于 `content-surface`，后者会用 projection unit 自己的 schema 校验每一个发布出去的值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
