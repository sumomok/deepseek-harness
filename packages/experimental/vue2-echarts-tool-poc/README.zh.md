# @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc

[English](README.md) | 中文

`show_chart`：agent 交出一份完整的 ECharts option，会话记录就在这次调用所在的位置把它画成一张活的 **Vue 2.7** 图表，浏览器究竟画出了什么再回到工具结果里。

组件来自 [`vue2-echarts-poc`](../vue2-echarts-poc/README.zh.md)，那个包不认识任何布局。本包同样不认识：它认领的是会话记录 `tool.call.toolview` 槽位上的 `show_chart` 这个 key，而那个槽位属于已发布的会话区，因此同一行在已发布外壳和服务线外壳下都渲染。

## 组合方式

两份 overlay，都叠在已发布的 Web 表面之上：

- [`overlay/show-chart.patch.yml`](overlay/show-chart.patch.yml) 装上组件行和本行，并保留官方的 `ui-layout`。这就是 `develop` 形状的那份组合。
- [`overlay/show-chart-three-column.patch.yml`](overlay/show-chart-three-column.patch.yml) 用服务线外壳换掉 `ui-layout`，并加上 [`vue2-echarts-content-poc`](../vue2-echarts-content-poc/README.zh.md)：会话里有图表，content 栏里有演示面板，共用一份 Vue 运行时。

`dsh --profile web --patch <路径>` 应用其中任意一份；启动器自己的参数在前，应用参数跟在后面：

```sh
pnpm dsh web --patch packages/experimental/vue2-echarts-tool-poc/overlay/show-chart.patch.yml --no-open
```

两个包都必须能从 profile 目录解析到，对树外插件而言意味着 `dsh plugin --profile web add <路径>` 或等价的链接——release bundle 不得声明实验包。

## 配置

| 字段 | 默认值 | 约束什么 |
| --- | --- | --- |
| `maxOptionBytes` | `65536` | 一次调用能携带的最大 `option`，按其 JSON 形式的 UTF-8 字节计。 |
| `maxPoints` | `2000` | `series[i].data` 条目总数的上限。工具描述里写的就是这个配置值。 |
| `verdictTimeoutMs` | `8000` | 调用等待浏览器汇报绘制结果的时长。 |
| `screenshot` | `false` | 是否把画好的图表截成 PNG，作为图像块返回给模型。 |

## 三层反馈

一次调用按顺序穿过三道闸，每一道都可能就此结束它。

**上限与支持的类型。** 在任何浏览器介入之前：调用声明的图表 `id`（若有）、option 的字节大小、非空的 `series`、每个 `series[i].type` 落在支持集合内、以及数据点总数。一次拒绝只花一个来回，什么都不改变，并同时说清违规的值和该怎么改。

**渲染判定。** 接着工具阻塞等待浏览器画出**这个 call id**——`exec.callId`，也正是会话记录通过 `ToolCallOwnerProps.callId` 交给那一行的同一个字符串。ECharts 在两条不同的通道上报告两种结果，所以那一行也是：`setOption` 当场抛出的文档同步变成 `{ ok: false, error }`，被接受的文档则在其后第一个 `finished` 事件上变成 `{ ok: true, seriesCount, pointCount }`。结算是一次性的：同一个 id 的第二次汇报、已经超时的调用的汇报、以及本宿主从未跑过的调用的汇报，一律回答 `{ accepted: false }` 且什么都不改变。

**截图。** 当 `screenshot: true` 时，那一行还会取 `chart.getDataURL({ pixelRatio: 2 })` 并随判定一起发出；宿主经由 attachment 服务把它持久化，再追加一个图像块——与 `read_image` 完全相同的生命周期。字节从不内联进 session log。存储拒收的截图被丢弃，判定照旧成立。结果里在图旁还多一句话，要模型检查排版有没有出问题——附上一张图却什么都不要求，模型会把它读成一次确认，根本不去看。

判定到来之前图表已完成布局但不可见（`visibility: hidden`，因为 ECharts 按已布局元素来定 canvas 尺寸）。失败判定则用一行本地化的错误替换它，并带上引擎自己的消息。

两个半边在本包自有的两条路由上会合：`/show-chart/settings`（截图开关，每次启动读一次）与 `/show-chart/report`（判定）。

## 同一张图，多次调用

一次调用可以声明一个稳定的图表 `id`（去掉首尾空白后非空，至多 64 个字符）。复用先前那张图的 id 意味着**这次调用取代那张图**：两次调用都留在会话记录里，因为日志就是发生过的事；但较早那一行会收缩成一行提示，背后没有 canvas、没有引擎、也没有判定。没有声明 id 的调用是它自己那张图，取代不了任何东西。

哪一行是当前那张，不是一行自己能看见的——它得读到自己之后的调用。改由宿主半边投影出来，键名 `showCharts`：把 session log 纯函数式地折成每一次记录在案的图表调用（`chartId`、`callId`、`title`、`seq`），外加每个图表 id 当前归属的那次调用。浏览器那一行经框架的 `useProjection` 座位读它，自己不解析任何东西。

这个折叠认得图表调用在日志里的两种形态：顶层 `tool/call`，其 `arguments` 是原始 JSON；以及 Code Mode 的 `tool/code-dispatch-start`，其 `arguments` 已经解码、call id 是 `subCallId`。模型经 `run_code` 调到这个工具时，日志里只有后一种。

投影单元只在组合了投影注册表时才激活。没有它时工具和各行照常工作，每张图就是画出它的那次调用。

## 信任

`option` 是模型输出，由一个真实引擎在外壳自己的源里渲染。它既不是标记也不是代码——宿主只接受 JSON——但有三个 ECharts 特性会把纯 JSON 变成浏览器要解释的文档，所以浏览器半边在绘制前只改写这三处（[`src/client/sanitize.ts`](src/client/sanitize.ts)）：

- **`tooltip.renderMode` 被强制为 `richText`。** ECharts 的默认 tooltip 是 HTML，而 `tooltip.formatter` 接受模板字符串，因此模型提供的 formatter 会是一次同源 HTML 注入。在富文本模式下引擎把 tooltip 画在 canvas 上，标签只是一串字符。
- **`graphic` 被整块丢弃。** 它渲染任意元素，包括指向任意 URL 的 `image` 元素。图表用不到它。
- **每一个以 `image://` 开头的 `symbol`/`image` 字符串都被丢弃**，那正是 ECharts 为标记或图例图标加载远程资源的方式。引擎内置的符号名不受影响。

其余一切原样通过：模型写普通 ECharts 正是本包的意义，一个会重写文档的 sanitizer 会毁掉它。

report 路由只接同站点、只收 JSON：被浏览器标为 `sec-fetch-site: cross-site` 的请求以 403 拒绝，未声明 `application/json` 的以 415 拒绝，两者都发生在读取正文之前，于是跨源页面无法把一次判定作为免预检的简单请求发出来。越过这道闸之后，它接受任何能抵达 dsh 源的一方发来的判定，与 HTTP API 的其余部分一致；一次汇报只能结算一个已经在等它的调用，最坏的后果是用户正看着的某一张图上多出一行错误的判定文字。

## Model Experience

### `show_chart` 的对外面

#### 模型看到什么

一个工具 `show_chart`，带一个可选的 `id` 字符串、一个可选的 `title` 字符串和一个必需的 `option` 对象，后者的 `series` 数组是必需的。描述里写明支持的 series 类型、只能是 JSON 的规则、配置的数据点上限、tooltip 以富文本渲染、主题由 UI 决定、以及图表被画进的那条对话栏有多大——大约 500×340 CSS 像素，这正是把图例放在底部、把排版交给 ECharts 之所以是正确默认的原因。本包不贡献任何系统提示词段落。

#### Token effect

在工具可见的每次请求上，是一段固定描述加参数 schema。`option` 的 schema 刻意很浅——一个对象套一个数组——因为 ECharts 的 option 格式是模型本来就熟悉的；逐图类型的 schema 会贵得多，说清的事却更少。

#### KV Cache effect

描述在这一行装载时组装一次，且只随 `maxPoints` 变化，因此在一个部署内工具块跨请求逐字节相同，前缀得以保持。

### 工具调用结果

#### 模型看到什么

被确认的调用回答 `Rendered: <标题或 "chart"> — <n> series, <m> points`；在 `screenshot: true` 下还会带上那句检查提示和一个图像块，两者从下一次请求起进入模型上下文。没有浏览器及时回答的调用回答 `Shown; not verified (no client reported within <s>s).`，后面跟着那句拦住模型重发同一张图的话：图表就在会话记录里，用户看到它时就会画出来。这不是错误——可能根本没有浏览器开着。画不出该文档的浏览器回答 `Error: Render failed: <引擎自己的消息>`，好让下一次调用能对。每一次拒绝回答 `Error: show_chart: …`，说清违规的值、限制、以及该怎么改。

#### Token effect

每次调用一行短文本，带截图时两行。截图多加一张图，并在之后的每次请求上都按图像计价。

#### KV Cache effect

只追加；结果跟在可复用的请求前缀之后，不使任何已缓存内容失效。

## Known Limitations and Deferred Work

- **四种 series 类型** —— `bar`、`line`、`pie`、`radar`。这个集合是组件行里的 [`SUPPORTED_SERIES_TYPES`](../vue2-echarts-poc/src/chart-types.ts)，那一行注册的正是这几个 ECharts 模块；加一种是一个常量加一个模块条目，工具描述和它的拒绝文案会自动跟上。
- **只能是 JSON** —— option 要跨过工具调用边界，因此任何以函数表达的 ECharts 特性（`formatter` 回调、`symbolSize` 函数、自定义 series 渲染器）根本发不过来。
- **判定来自第一个汇报的客户端** —— 可能有多个浏览器在看同一个 session，谁先画完谁回答这次调用。它们画的是同一份文档，所以计数一致；但如果某个浏览器的引擎拒绝了另一个接受的文档，就不一致了。
- **截图需要有视觉能力的模型** —— 无论线路是否接受图像，图像块都会进入上下文，并在之后每次请求上按图像计价。默认关闭正是这两个原因。
- **图表只读一次配色** —— 那一行在挂载时读 `body[data-ds-dark-theme]`。切换主题会重绘图表周围的外壳，而图表保持它被构建时的那套配色，直到会话记录重新挂载这一行。
- **report 路由假定有 HTTP 载体** —— 浏览器半边相对页面源 POST 到 `/show-chart/report`。一种提供外壳却不通过 HTTP 暴露 harness 的传输会让每次调用都停在未确认。
- **模型不会被告知某张图被取代了** —— 取代是浏览器侧的渲染决定。较早那次调用的工具结果仍是它结算时的样子，没有任何东西会回头改它。
- **投影随本 session 的图表调用数增长** —— 每次调用一条很小的条目，存活到 session 结束，其 `title` 按模型写下的原样携带。两者都不做截断；画上几百张图的 session 推给浏览器的值也会相应变大。
- **没有任何交互抵达模型** —— 点击、图例切换、缩放都留在浏览器里。agent 能把一张图摆到用户面前，却学不到用户对它做了什么。
- **未被组装态快照覆盖** —— 浏览器证据是跑在真实组合上的 Playwright 场景，模型可见文本在单元测试里逐字锁定；快照通道回放的是已发布组合，而它不组合实验行。
