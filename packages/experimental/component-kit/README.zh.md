# @deepseek-ai/dsh-experimental-component-kit

[English](README.md) | 中文

内容面板 `component` 类目背后的组件行。它只提供 React 渲染器和给它们命名的表：不声明插槽，不读配置，不提供路由，也不认识任何布局。一块内容画在哪里由落位包决定，画成什么样由这一行决定。

node 半边是空插件。它存在只是为了让这一行出现在宿主 `cordis.yml` 里，浏览器产物靠 `dsh.client` 由此被发现。

## 渲染器表

`COMPONENT_RENDERERS` 把目录 id 映射到画它的组件。键是字面量 id，因此落位包只要让自己那份目录**派生出** id 的联合类型，再写一句 `satisfies Record<CatalogId, ComponentRenderer>`，就把两张表钉在了一起：目录里有条目而这一行没有对应渲染器，会在那里变成编译错误，而不是运行时的一块空白。钉住的前提是那个联合类型确实从目录派生；在目录旁边手写一份同名联合，什么都钉不住。写好的那一句在 `component-surface` 的 `ComponentSurface.tsx` 里，对着它的 `COMPONENT_CATALOG` 派生出的 `CatalogId`。

取到这张表是一次跨包的值导入，因此消费方声明 `dsh.client.external: ['@deepseek-ai/dsh-experimental-component-kit/client']`，由加载器从这一行自己的产物里答复该 require。

## 渲染器收到什么

这一行里的每个组件都收同样五个 prop（`ComponentRendererProps`）：`nodeId`，该块在一次落位中的身份；`props`，落位包的 schema 已经接受的块属性；`onAction(actionId, payload)`，用户动作的去处，带上动作 id 与该动作声明的那些属性；`state`，这一块上次上报的手势走到了哪一步（`idle` / `sending` / `sent` / `queued` / `refused`）；以及 `t`，这一行自己的翻译函数。

契约到此为止。渲染器不持有 ctx，不订阅任何东西，不记自己的手势，不做跳转、不发请求、不写数据——它画拿到的东西，说出用户按了什么，再被告知那件事的下场。这件事有没有后续、`state` 从哪里折出来，都由落位包决定。

属性的类型是 `Record<string, unknown>`，因为一张表的类型要服务所有组件，所以每个渲染器自己收窄它声明过的属性。这个收窄不是对调用方的防御：这块内容早已按接纳它的目录 schema 校验过了。

## 文案

这一行拥有一个词典命名空间 `componentKit`，落位包的座位在自己的注册处声明它，而不是再开第二个命名空间——有哪些组件是这一行的事实，所以按钮行的无障碍名称，和「这一行没有这个组件」时显示的那句话，都归这里。块上显示的其余文字全是调用方的。

## 组件清单

- **`el.confirm-bar`** —— 一段简短提示加一行按钮，用来把一个决定摆到用户面前。属性：`title`、`message`、`buttons`（每项 `{ id, label, tone? }`，tone 取 `primary` / `default` / `danger` 之一）。按下按钮会报出 `press` 动作，其 payload 是被按下按钮的 `buttonId`。

条画的是它被交给的那个 `state`，除 `idle` 与 `refused` 外每种状态都不再接受按下，并写明它处在哪一种：手势正在路上、智能体已经拿到、正等着用户下次开口、或者谁也没收到。落位包拿一次按下做什么要隔一整轮才看得见，甚至可能什么都换不来，所以一条按完仍旧原封不动的条，会让「记下了」和「丢了」长得一模一样——而一条自己记着点击的条，落位第一次把它卸载就照样干干净净地回来。`refused` 仍然可按，因为再上报一次是唯一还能做的事。

## 组合

这一行由 [`component-surface`](../component-surface/README.zh.md) 画出来，它的覆盖层同时组合两者。两者都不属于任何发行包。

## Model Experience

None, as this row is a browser component library and registers no tool, prompt, or result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **状态由落位包去折，折错了这一行看不出来** —— 这一行只画 `state`，对它不作任何判断，所以某个落位若从不把一块推过 `sending`，或者把另一块的状态交给了这一块，画出来的条看着完全正常，说的却是错的。这一行没有任何东西能发现。
- **状态表是闭的，状态的含义不是** —— 条按交给它的每个状态各画一句，这张表少一句就编译不过。编译器管不了的是落位包新加的投递档并进了已有状态：某个落位悄悄吞掉、谁也没告诉的动作，折成 `sent` 之后，这里画的就是「已发送到对话」。加这种档的人，要连这句话一起定。
- **落位包自己那些句子不经这一行翻译** —— 这一行只本地化条自己关于手势画的那几句；同一次手势落位包在屏幕别处说的话，用的是那个包自己写下的语言。控制台那套落位是由宿主来答一次按下的，宿主拿不到浏览器的语言，于是 `这个动作没能记下来。` 与 `已记下，你下次发消息时对话会看到。` 会出现在聊天里，紧挨着一条写着 `Sent to the conversation` 的条。这一行够不着它们；解法归想要统一界面语言的那套落位，触发器是控制台开始提供中文以外的界面。
- **payload 里能放什么，这一行不做检查** —— 渲染器被信任只把落位包目录为该动作声明过的东西放进 `onAction` 的 payload；这一行不检查，落位包也不做裁剪，而是整条手势一起拒掉。渲染器多放一个该动作没声明的字段，这个控件的每一次按下就都到不了任何地方。
- **一份目录，两个家** —— 这张表里的 id 和校验块属性的目录是两个包里的两份声明，只靠消费方的 `satisfies` 检查系在一起。那句检查只管 id，别的都不管：渲染器读的属性一旦与接纳它的 schema 漂移，编译照样通过，画出来的却是错的。
- **组件之间不做拼装** —— 落位只是把块摞起来；这里没有任何东西会读兄弟块的状态，也没有布局或绑定词表。
- **没有装配快照覆盖** —— 浏览器侧的证据是针对真实组合的 Playwright 场景；快照泳道回放的是发行组合，其中不含任何 experimental 行。
