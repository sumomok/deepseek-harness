# Agent Note：`show_chart` —— agent 在会话里画的图，以及浏览器回传的答案

Status: implemented

[English](2026-08-24-show-chart-tool-chat-view.md) | 中文

## Problem

[Vue 2.7 桥](2026-08-24-vue2-bridge-echarts-poc.zh.md)证明了外来框架能活在 React slot 里，并把一张图放进了服务线外壳的 `content` 栏。还差两件事。

那一栏只存在于这条产品分支上，因此任何建立在它之上的东西都并不回去。会话记录才是两种外壳共有的那块表面。

而且那张图是演示数据。agent 画的图是模型输出，由真实引擎在外壳自己的源里渲染，而模型什么都拿不到：没有任何东西确认画出来了，没有办法纠正引擎拒绝的文档，也没有图。一个只反馈「调用返回了」的工具，调用它的那一方无法迭代。

## Decision

一个包 `vue2-echarts-tool-poc`，提供 `show_chart`，并认领会话记录 `tool.call.toolview` 槽位上的 `show_chart` 这个 key。组件留在 `vue2-echarts-poc` 里，通过 `dsh.client.external` 请求。

### option 直通；支持集合只有一个家

`show_chart` 接受一份完整的 ECharts option（JSON）。模型本来就熟悉这个格式，逐图类型的 schema 会更贵、说清的事更少；参数 schema 就是一个对象套一个必需的 `series` 数组，模型还需要知道的其余一切都在描述里。

描述所承诺的是 `SUPPORTED_SERIES_TYPES`——`bar`、`line`、`pie`——声明在组件行的 `src/chart-types.ts` 里，一个什么都不 import 的模块。客户端通过一张按它加键的模块表推导出自己的 `echarts.use` 注册，因此第四种类型会让构建失败，直到把对应的 ECharts 模块写在旁边；宿主从包根 import 同一个常量，因此拒绝文案指名的正是浏览器画不出的那些。`countSeriesPoints` 也住在那里：宿主的数据点上限和浏览器的判定用同一种数法。

### 一个按 key 的工具视图，而不是一栏

`tool.call.toolview` 按线上工具名加键且开放，因此认领本包自己的工具是增量的——其他每一行都保持原样。这个 key 属于已发布的会话区，而两种外壳都装载它，所以同一个包在官方布局和服务线布局下都能用。两份 overlay 装的正是这件事：一份保留 `ui-layout`，一份换掉它并加上 content 栏的 placement，证明两处 placement 共用一份 Vue 运行时。

### 判定往返，以及「确认前不可见」

工具体阻塞等待浏览器画出**这个 call id**。`exec.callId` 是工具执行携带的身份，而 `ToolCallOwnerProps.callId` 是会话记录交给那一行的同一个字符串——一张按它加键的表结算这次等待。

ECharts 在两条不同的通道上报告两种结果，组件也是：`setOption` 对它拒绝的文档同步抛出，那就是失败判定；被接受的文档异步绘制，因此成功判定等其后第一个 `finished` 事件。结算是一次性的：条目在其等待者被 resolve 之前就被移除，所以第二次汇报、已超时调用的汇报、以及本宿主从未跑过的调用的汇报，是同一个答案——没有谁在等。

图表在判定说它画出来了之前已完成布局但不可见。用 `visibility` 而不是 `display`：ECharts 按已布局元素来定 canvas 尺寸，被 display 隐藏的宿主会交给它一个零尺寸的元素——那样判定说的就不是用户最终看到的那张图。

超时不是错误。无论如何图表都在会话记录里，而且可能根本没有浏览器开着，因此调用回答 `Shown; not verified`；只有被拒绝的文档才是工具错误，并带上引擎自己的消息，好让重试能对。

### 截图是可选开启的

`screenshot: true` 多加一次 `getDataURL`，经 `onCapture` 恰在判定之前送出，好让那一行把两者放在一条消息里发出；宿主经由 attachment 服务持久化它并追加一个图像块——与 `read_image` 完全相同的生命周期。默认关闭：它需要有视觉能力的模型，并在之后每次请求上按图像计价。

### sanitizer 只改写三处

option 是模型输出，与外壳同源绘制。它既不是标记也不是代码——宿主只接受 JSON——但有三个 ECharts 特性会把纯 JSON 变成浏览器要解释的文档：`formatter` 接受模板字符串的 HTML tooltip、指向任意 URL 的 `graphic` 元素、以及符号与图例图标上的 `image://` 资源引用。浏览器半边强制 `tooltip.renderMode: 'richText'`、丢掉 `graphic`、丢掉那些资源字符串。其余一切原样通过：模型写普通 ECharts 正是意义所在。

## Alternatives considered

**逐图类型的 schema**（`{ kind: 'bar', categories, series }` 之类）。否决：它花的 schema token 多得多，能描述的只是 ECharts 的一小部分，而且每加一种图形都要加一条 schema 分支和一个映射器。直通 option 是模型本来就在写的格式，而支持集合检查加渲染判定覆盖了 schema 本可以抓到的东西——只是晚一点，并且带着真实引擎自己的消息。

**由插件自有的 Typert remote 命名空间**承载判定，那是宿主能力抵达浏览器的常规做法。本包用不了：workspace Typert 生成器从 `tsconfig.host.json` 的 references 里发现 Host 面的贡献者（根 tsdown 配置里的 `typertPlugin({ mode: 'workspace', faces: ['host'] })`），而双入口的 client 插件注册在 `tsconfig.client.json`——只能在一个 aggregate 里，`api/remotes` 是唯一获准拆分的。于是两个半边在本包自有的两条 webserver 路由上会合，也就是 `content-frame` 已经在用的那套设置文档机制。settings 路由回答的正是 `settings()` remote 方法会回答的那个问题，每次启动一个 GET；report 路由是一个 body 有界的 POST。为同样这两条消息，remote 命名空间要多出一份生成产物和一次 BFF 装配改动。

**让模型来判断是否揭示** —— 立刻显示图表，让模型从结果里判断它成没成。否决：模型能反应之前用户已经看到一张坏掉或空白的图，而模型除了自己刚发出的参数之外没有任何可判断的依据。

**HTML tooltip 加转义。** 否决：`tooltip.formatter` 是引擎会展开的模板，转义要正确就得懂 ECharts 自己的占位符语法。富文本把 tooltip 挪到 canvas 上，那里根本没有「标记」这个范畴。

**在服务端渲染图表、只返回一张图。** 在这条线上否决：它放弃了用户能悬停、能缩放的活图表，需要在宿主进程里放一个无头渲染器，而且仍然无法告诉模型浏览器能不能画出来。截图是**挨着**活图表一起走的。

## Consequences

`show_chart` 可并回 `develop`：不依赖服务线外壳，组合它的那份 overlay 也不动已发布的布局。

组件行现在导出第二张图。`EChartsBar` 与 `EChartsOptionChart` 共用 `echarts-host.ts`——按支持集合推导的模块注册、两套配色、以及实例生命周期（`attachChart`：按当前配色构建、配色变化时重建，因为 ECharts 只在构造时解析主题、随元素 resize、卸载时 dispose）。`EChartsBar` 保留自己的组件：它那个由 Vue 拥有的点击计数器是桥的证据，把它重建在直通图表之上会为省十来行而删掉那份证据。

一个每次渲染都交给图表一份新 sanitize 对象的行，会让图表不停地重新应用、重新汇报、重新渲染；sanitize 后的 option 按原始参数字符串做了 memo，那是这一行除判定之外唯一的派生状态。

工具 bundle 原始 13 kB、gzip 后 5 kB，既不带 Vue 也不带 ECharts：manifest 的 `dsh.client.external` 让组件行仍是一次通过 loader 模块表解析的 import，这也正是模块图里只有一份 Vue 运行时的原因。

## Testing

`echarts-option.client.spec.tsx` 在假引擎上驱动直通图表：什么抵达 `setOption`、判定的两条边、什么都不报的游离 `finished`、React commit 上的重新应用、截图开关、以及配色重建。`chart-types.client.spec.ts` 锁定支持集合与点计数器。

`show-chart-tool.client.spec.ts` 用假汇报方把工具跑过真实的工具注册表：描述、参数 schema 与每一行结果文本逐字锁定、每一种触上限的拒绝、ok/error/超时判定、被忽略的重复汇报与未知 id、取消，以及挂载与未挂载存储两种情况下的截图——包括那条关联断言：用执行自身之外的任何 id 发出的判定都抵达不了任何调用。`show-chart-routes.client.spec.ts` 用真实 Loader 启动一份只供测试的 cordis.yml，读服务出来的 HTTP 表面：设置文档、结算活调用的一次判定投递、畸形或超大 body 得到的拒绝、方法门禁、以及 fiber 释放时的路由回收。

`sanitize.client.spec.ts` 锁定那三处改写，以及别的什么都不动。`show-chart-row.client.spec.tsx` 在一个会记录的图表上驱动那一行：running 与 settled 两种切片、sanitize 后 option 的稳定同一性、确认前不可见、错误行、每个 call id 一次汇报、以及截图开关。`browser-plugin.client.spec.ts` 证明按 key 的认领、注入的截图开关、设置文档不可用时的响亮失败、以及 fiber 拆卸时的移除。

`apps/web/tests/show-chart.e2e.ts` 用两份 overlay 在真实 Web 组合上启动，session log 里种了两次已结算的调用，断言每次调用自己的会话行里都有一块有尺寸的 canvas，并且在服务线外壳下 content 栏的面板与它们并存。活的等待路径——工具体阻塞在浏览器判定上——由宿主 spec 用假汇报方覆盖；无密钥的回放通道不跑模型，因此不会发出任何活的调用。
