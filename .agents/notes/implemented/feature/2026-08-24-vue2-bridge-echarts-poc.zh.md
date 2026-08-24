# Agent Note: 一座 Vue 2.7 桥，以及让组件能走的「组件 / 摆放」拆分

Status: implemented

[English](2026-08-24-vue2-bridge-echarts-poc.md) | 中文

## Problem

[Vue 3 探针](../../../../packages/experimental/vue-ui-poc/README.zh.md)回答了「异框架能否住进 React slot」，用的是 Vue 3 独立的 `render(vnode, container)`。Vue 2 没有这个函数，而这条产品线要托管的代码库是 Vue 2，不是 Vue 3。对它什么都没被验证过：挂载机制没有，Vue 响应式在一次 React commit 之后会怎样没有，第二个 Vue 2 包要付多少代价也没有。

随之而来还有第二个问题。本分支的可见落点是服务形态外壳的 `content` 栏，而 `develop` 上没有这一栏——出厂外壳根本不声明 `content` 键。写死在那一栏上的组件永远合不回去；不认识它的组件可以。

## Decision

两种角色，其中组件那一侧自成一个包。`vue2-echarts-poc` 携带 Vue 2.7 运行时、桥、ECharts 组件、两个 React 组件与字典，不注册任何 slot。摆放是一次 `slots.inject(<key>, …)` 调用外加一个 overlay，跟着「拥有它所画数据」的那个功能走——今天各个摆放注册进去的是[content-surface 路由器](2026-08-24-content-surface-router.zh.md)。

### 桥持有的是 Vue 根实例，不是容器

三条 Vue 2 事实决定了 `Vue2Bridge` 的形状：

- `$mount(el)` 会**替换**传给它的那个元素，因此桥往自己的宿主里追加一个占位 `div` 并挂载到它上面。宿主仍属于 React，宿主的子节点属于 Vue。
- `$destroy()` 不碰 DOM，因此拆卸之后还要移除 `vm.$el`。根实例与元素都在挂载时捕获，因为 React 会在被动清理运行前清空 ref。
- Vue 2 根实例按自己的响应式数据重渲染。因此整份 prop 记录存放在唯一一个响应式根属性里，每次 React commit 都重新赋值——`vm.p = props` 就地 patch 活着的树，这正是它下面的 Vue 自身状态得以存活的原因。

这份记录在进入时被复制并冻结。Vue 2 的 observer 会遍历交给它的每个对象，并替换沿途每个数组的原型，因此不冻结就会改到 React 拥有的数据。

### 组件与摆放是两个包

`ChartPanel` 与 `EChartsBar` 都不指名任何 slot，也不从布局里解析任何东西；`EChartsBar` 连文案都不解析，因此在会话 transcript 里渲染工具调用数据的摆放可以传自己的字符串。留在本分支上的只是摆放本身，无论落在哪里都是十来行。把组件合并到别处，是一次包位置的搬迁加一个同样大小的新摆放，而不是重写。

### 仓库里第一次包行级模块请求

摆放跨包值 import 了 `ChartPanel`，而客户端 bundle 纯净性闸门在 manifest 没有声明请求时会直接拒绝它。`dsh.client.external: ['@deepseek-ai/dsh-experimental-vue2-echarts-poc/client']` 写在[客户端栈的模块图规则](../../../../packages/client/AGENTS.md#shared-modules-and-the-module-graph)里，此前没有任何使用者。三套机制按文档如实响应了它：构建预设让这个 specifier 保持为 import，因此摆放 bundle 只有 1 kB，既不带 Vue 也不带 ECharts；modules 的 node 半边在 boot 图里把组件行排到消费方之前；`verify-client-packages` 确认确有一个 dynamic 行提供该 specifier，且请求图无环。

共享这一份模块身份，也正是下面那条运行时规则背后的机制，这就是组件行要再导出 `Vue` 与组合式 API、而不是让消费方自己 `import 'vue'` 的原因。

## Alternatives considered

**每次 React commit 新建一个 `new Vue`。** 否决：Vue 2 根实例自带响应式图与生命周期，每次 commit 重建就恰好丢掉了这座桥存在的意义所在的那份状态，并连带重挂 ECharts canvas。重新赋值一个响应式属性只需一趟 patch。

**回调走 `on:` 监听器而非函数 prop。** 否决。Vue 2 接受 `Function` prop，而把 props 对象保持为全部约定，意味着调用点只有一份被类型检查的记录，没有第二条通道要推敲——这也是 Vue 3 桥定下的同一条规则。

**单文件组件。** 否决，因为这是仓库级的工具链决定而不是包级的：Vitest 配置没有 Vue 插件，触到 SFC 的 spec 会解析失败，而 `.vue` 也落在覆盖率闸的 glob 之外。`defineComponent` + `h()` 还保住了没有 `vue-tsc` 的 SFC 会擦除掉的编译期 prop 检查。

**一个包直接注册进 `content`。** 否决：那会把组件焊死在一个只存在于本分支的 slot 键上，任何东西不重写就合不出去。

**让每个 Vue 2 包各自内联一份 Vue。** 否决——它付出的不只是字节，而是静默损坏。Vue 2 的响应式不跨运行时副本：observer、`Dep` 与渲染 watcher 都属于创建它们的那一份副本，因此建立在第二份副本上的组件会不报错、不告警地停止更新。

## Consequences

**一张模块图里只有一份 Vue 运行时**现在是一条有机制兜底的规则。第二个 Vue 2 包通过 `dsh.client.external` 请求 `@deepseek-ai/dsh-experimental-vue2-echarts-poc/client`，并从那一行的再导出里取 `Vue`、`defineComponent`、`h`、`ref`、`computed`、`watch`、`onMounted`、`onBeforeUnmount` 与 `nextTick`。那些值导出正是为此存在，并写在包 README 里。

组件行的 bundle 原始 1.30 MB、gzip 后 290 kB，携带 Vue 2.7 与一份 tree-shaken 的 ECharts。有两项构建决定把它按在这里：`vue` 钉到 `vue/dist/vue.runtime.esm.js`，以及把 `process.env.NODE_ENV` define 成 `"production"`——后者不是优化而是前提，因为 Vue 2 的 ESM 构建把这个名字当裸全局读，否则浏览器会在第一次挂载时抛 `process is not defined`。

想要 `develop` 侧的摆放时，那是另一个小插件；组件不为它挪窝。图表不读主题：canvas 解析不了 CSS 自定义属性，因此它的两套配色是字面值，而 `ChartPanel` 永远选浅色那套。

## Testing

`vue2-bridge.client.spec.tsx` 用一个一次性 Vue 组件驱动这座桥：挂载后宿主里有什么、一次 React commit 后元素与 Vue 计数不变而标签改变、回调能跨界、卸载后宿主为空，以及 React 交出的那份记录从未被打上 Vue 的 `__ob__`。

`chart-panel.client.spec.tsx` 用记录器替换 ECharts 与 `ResizeObserver`，因为 jsdom 既没有 canvas 也没有布局。它覆盖 `EChartsBar` 的数据通路与每个可选输入的默认值、同时推动 Vue 计数与 React 状态的那次点击、施加到活实例上的数据变更、触发重建的配色变更、observer 驱动的 resize，以及卸载时成对的释放——随后是 `ChartPanel` 的种子周数据、选中回声与「换一组数据」。

`apps/web/tests/show-chart.e2e.ts` 与 `apps/web/tests/content-surface.e2e.ts` 启动真实 Web 组合，证明这座桥在会话记录里与 content 栏里都画出了有尺寸的 `<canvas>`。`ChartPanel` 自己的浏览器侧证据随渲染它的演示摆放一同离开；该组件保留它的 jsdom spec，不再有任何摆放。
