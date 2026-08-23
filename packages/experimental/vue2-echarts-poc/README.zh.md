# @deepseek-ai/dsh-experimental-vue2-echarts-poc

[English](README.md) | 中文

一个组件库行：一张真实的 ECharts 柱状图，以 **Vue 2.7** 组件写成，并被包装到 React 里随处可渲染。本包不认识任何布局，也不注册任何 slot——它的浏览器半边只注册字典并导出组件。渲染在哪里由 placement 插件决定，[`vue2-echarts-content-poc`](../vue2-echarts-content-poc/README.zh.md) 就是本分支上的那一个。

它是 [`vue-ui-poc`](../vue-ui-poc/README.zh.md) 的 Vue 2 对应物，后者对 Vue 3 验证同一个问题。

## 这座桥

slot 系统只接受 React 函数组件，因此 Vue 树通过 `Vue2Bridge`——一个持有 Vue 根实例的 React 组件——抵达 React。Vue 2 没有独立的 `render(vnode, container)`，而那正是 Vue 3 桥的全部机制，所以这座桥由三条 Vue 2 事实塑形：

- **`$mount(el)` 会替换掉传给它的那个元素。** 因此桥往自己的宿主里追加一个占位 `div` 并挂载到它上面；宿主本身仍属于 React，宿主的子节点则属于 Vue。
- **`$destroy()` 拆掉实例但不碰 DOM。** 因此拆卸之后还要移除 `vm.$el`。它需要的一切都在挂载时捕获，因为 React 会在被动清理运行前清空 ref。
- **Vue 2 根实例按自己的响应式数据重渲染，而不是听父组件的招呼。** 因此整份 prop 记录存放在唯一一个响应式根属性里，每次 React commit 都重新赋值，从而就地 patch 活着的树。这正是「Vue 组件自身状态跨 React 重渲染存活」的原因——图表的点击计数就是肉眼可见的证据。

这份记录在进入时被复制并冻结。Vue 2 的 observer 会遍历交给它的每个对象，并替换沿途每个数组的原型，因此不冻结就会反过来改到 React 拥有的数据。

`props` 就是两个框架之间的全部约定。React 半边先解析完所有 slot 份额，再把一份扁平记录交给 Vue：字符串、纯数据数组、一个布尔和一个回调。回调以**函数类型的 prop** 跨界，而不是 `on:` 监听器：props 对象就是全部表面，与 Vue 3 桥一致。桥以下不 import React，桥以上不 import Vue，任何 hook、store handle、Cordis context 或 React node 都不跨界。

## 这一行的对外面

`./client` 导出两个 React 组件，分层安排，好让 placement 各取所需：

- **`EChartsBar`** —— 纯粹、由数据驱动。props 是 `title`、`categories`、`values`，以及可选的 `dark`、`selectedLabel`、`onSelect`。它不解析任何文案、不指名任何 slot，因此同一个导出既服务常驻栏，也服务渲染工具调用数据的会话卡片。
- **`ChartPanel`** —— 建在 `EChartsBar` 之上的演示外壳，也是 placement 实际注册的组件。它从本包的 locale 座位解析文案，铺一组固定的七柱周数据，用「换一组数据」按钮替换它，并把最后点中的柱子作为 `selectedLabel` 递回去。每一次交互两个方向都在跨界：Vue 数点击，React 在它周围重渲染。

`Vue2Bridge`、`EChartsBarChart`（Vue 组件）与 `NS`（字典命名空间）同样导出，并附带 Vue 2.7 的 API 表面：`Vue` 加上 `defineComponent`、`h`、`ref`、`computed`、`watch`、`onMounted`、`onBeforeUnmount`、`nextTick`。

### 一张模块图里只能有一份 Vue 运行时

Vue 2 的响应式不跨运行时副本。observer、`Dep` 与渲染 watcher 都属于创建它们的那一份副本，因此建立在第二份 Vue 上的组件会静默地不再更新——不报错、不告警，只是一棵永远不 patch 的树。

这个 bundle 携带唯一的那一份。第二个 Vue 2 包必须通过模块表请求这一行，而不是自己 import Vue：

```jsonc
"dsh": { "client": { "external": ["@deepseek-ai/dsh-experimental-vue2-echarts-poc/client"] } }
```

并从上面那些再导出里取 `Vue` 与组合式 API。这条规则就是那些再导出存在的理由。

## 组合方式

该插件不属于任何已发布 bundle，单独装上也画不出任何东西：它是一个库行加它的字典。要和渲染它组件的 placement 一起组合——[`overlay/vue2-echarts-content.patch.yml`](../vue2-echarts-content-poc/overlay/vue2-echarts-content.patch.yml) 会装上这两行，以及开出它们落脚那一栏的外壳。

该包必须能从 profile 目录解析到，对树外插件而言意味着 `dsh plugin --profile web add <路径>` 或等价的链接——release bundle 不得声明实验包。

## 产物体积

Vue 与 ECharts 都不在外壳的共享模块表里，因此本包的 `lib/client.js` 把两者都带上：原始 1.30 MB，gzip 后 290 kB。React 与 Cordis/slot 层保持 external，通过 loader 注入的 `require` 解析。

有两项构建决定让它停在这个体积而不是更大。`vue` 被钉到 `vue/dist/vue.runtime.esm.js`，即 runtime-only 的 ESM 构建，因为完整构建会把模板编译器拖进一个只用 `h()` 渲染、运行期从不编译模板的 bundle。`process.env.NODE_ENV` 被 define 成 `"production"`，这既剔除了 Vue 2 的开发分支，也是这个 bundle 能跑起来的前提：Vue 2 的 ESM 构建在每条响应式路径上都把这个名字当裸全局读，缺了 define 浏览器会在第一次挂载时抛 `process is not defined`。ECharts 走 `echarts/core`，只注册柱状图、grid、tooltip 与 canvas 渲染器。

## Model Experience

无，因为本包渲染的是纯浏览器侧的图表组件，不触及任何 prompt、消息、schema、流或工具结果。

#### KV Cache effect

无；本包从不组装也不发送模型请求。

## Known Limitations and Deferred Work

- **只有演示数据** —— `ChartPanel` 铺的是固定的七柱周数据，并在浏览器里随机替换。没有任何东西抵达宿主、session log 或模型；携带真实数据的 placement 应当用 `EChartsBar` 这个导出。
- **没有接主题** —— `ChartPanel` 永远传 `dark: false`。canvas 解析不了 CSS 自定义属性，因此图表的两套配色是 `echarts-chart.ts` 里的字面值，而不是它周围 DOM 读的那些 `--dsw-*` token，并且没有任何东西在两者之间切换。要接上实时主题，需要在 placement 的 register 处放一个注册方私有的 observable，那是 placement 的决定，不是这一行的。
- **Vue 2.7 已终止维护** —— 2.7 是 Vue 2 的最后一条线，不再有新版本。本包的意义是证明既有的 Vue 2 组件树可以被托管，而不是推荐新写。
- **单文件组件不在支持路径上** —— 仓库的 Vitest 配置没有 Vue 插件，任何触到 SFC 的 spec 都会解析失败，而 `.vue` 也落在覆盖率闸的 `packages/*/*/src/**/*.{ts,tsx}` 之外。本包使用 `defineComponent` + `h()`；完整分析记在 [`vue-ui-poc`](../vue-ui-poc/README.zh.md)。
- **一座桥只挂一个组件** —— 桥只挂载单个 Vue 组件并传一份 prop 记录。slot 子内容、跨桥的 Vue `provide`/`inject`、`<Teleport>`、Vue Router 与 Vuex 都未探索。
- **未被组装态快照覆盖** —— 浏览器证据是跑在真实组合上的 Playwright 场景，而不是录制的 transcript；快照通道投影的是模型可见与会话输出，而本包两者皆无。
