# @deepseek-ai/dsh-experimental-vue2-echarts-content-poc

[English](README.md) | 中文

一个 placement，仅此而已：把 [`vue2-echarts-poc`](../vue2-echarts-poc/README.zh.md) 的 `ChartPanel` 放进 [`server-layout`](../server-layout/README.zh.md) 开出的 `content` 栏。整个浏览器半边只有一次 `slots.inject` 调用；node 半边是空的。

## 为什么单独成包

`content` 属于这条产品线的外壳，而那个外壳只存在于 `product/server-console` 分支。图表组件不属于它：一棵托管在 React 里的 Vue 2.7 树无论渲染在哪里都有用，包括在一条根本没有 `content` 槽的分支上做会话卡片。把两者拆开，组件行就能走、placement 留下——之后合并组件是一次包位置的搬迁而不是重写，再加一个 placement 也只是这么大一个文件。

`content` 是 `single` 槽，因此本行与 [`content-frame`](../content-frame/README.zh.md) 是互斥的两种选择。一份组合装其中之一，两者不能同时占用这一栏。

## 模块请求

`ChartPanel` 是一次跨包的值 import，客户端 bundle 纯净性闸门通常会直接拒绝它。这里之所以放行，是因为 manifest 声明了这次请求：

```jsonc
"dsh": { "client": { "external": ["@deepseek-ai/dsh-experimental-vue2-echarts-poc/client"] } }
```

这一行随后驱动三套机制。构建预设让这个 specifier 保持为 import 而不内联，因此本 bundle 只有一千多字节，既不带 Vue 也不带 ECharts。modules 的 node 半边读到这次请求，在 boot 图里把组件行排到本行之前，因此本行 materialize 时对方的 factory 已经注册好。`verify-client-packages` 则校验确有一个 dynamic 行提供该 specifier，且请求图无环。

共享模块身份同时也是**一张模块图里只有一份 Vue 运行时**的保证——那正是组件行 README 写下的规则，也是本包绝不能自己 `import 'vue'` 的原因。

## 组合方式

该插件不属于任何已发布 bundle。用 overlay 叠在 Web 组合之上：

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
    - id: vue2-echarts-poc
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-poc'
    - id: vue2-echarts-content-poc
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-content-poc'
```

`overlay/vue2-echarts-content.patch.yml` 就是这个文件；`dsh --profile web --patch <路径>` 应用它。三行缺一不可：出厂外壳根本不声明 `content` 键，而组件行既是本 bundle 的模块供给方，也是面板所读文案的注册方。每个包都必须能从 profile 目录解析到，对树外插件而言意味着 `dsh plugin --profile web add <路径>` 或等价的链接——release bundle 不得声明实验包。

## Model Experience

无，因为本包摆放的是纯浏览器侧的图表面板，不触及任何 prompt、消息、schema、流或工具结果。

#### KV Cache effect

无；本包从不组装也不发送模型请求。

## Known Limitations and Deferred Work

- **绑定服务形态外壳** —— 本行注册进 `content`，而这个键只有 `server-layout` 声明。在装了出厂外壳的组合里，它会一直等一个永远不来的声明，什么也不贡献。
- **没有配置** —— 由哪个组件占用这一栏在源码里定死。想换别的面板的部署，应当写一个新的 placement 包。
- **未被组装态快照覆盖** —— 浏览器证据是跑在真实组合上的 Playwright 场景，而不是录制的 transcript；快照通道投影的是模型可见与会话输出，而本包两者皆无。
