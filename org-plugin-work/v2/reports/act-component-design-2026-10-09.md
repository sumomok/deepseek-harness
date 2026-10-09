# act_component 第一阶段设计说明（2026-10-09）

工作树：`/Volumes/outside-ssd/CODE/learn/learning-project/dsh-component-act`，分支 `feat/component-act`，基线 `cb8b396c80`。
本文只讲第一阶段要落地的形状；实现进度与偏差见 `act-component-stage1-2026-10-09.md`。

## 0. 已拍板的前提（不再改）

- 展示归 `show_component`；组件可操作做成独立工具 `act_component`，归 `component-surface`。
- 不动页面通道的工具面：`content_show`、五个读、`content_act` 保持只做页面；`content_read*` / `content_act` 不扩来服务组件。
- 分层是**通道共享 + 工具按域**：认领/待办/上报这套与页面无关，抽成窄接缝，两域都用它把调用送到标签页。
- `act_component` 用组件自己的语言寻址：条目 id + 块/节点 id + 申明的动作键；不用 DOM ref。
- 硬约束：一次调用只落在「这个条目自己的容器元素」内；容器外一律拒绝，理由只说原因。

## 1. 通道接缝切在哪

### 1.1 今天的现状（基线）

| 关切 | 今天在哪 |
| --- | --- |
| 宿主等待表（认领、tab 偏好、settle） | `packages/experimental/content-frame/src/access/pending.ts`（`PendingCalls`） |
| 两条 HTTP 路由 `/content-claim`、`/content-report` | `content-frame/src/index.ts` 的 `claimPageAccess()`，只有配置了 `pageAccess` 才注册 |
| 待办发布给浏览器 | `content-frame/src/access/requests-projection.ts`（`contentAccess` 投影，页面工具的参数 schema） |
| 标签页侧的 bid loop、隐藏宽限、上报重试、`TAB_ID` | `content-frame/src/client/access/executor.ts`（`useContentRead` / `claimRead` / `post` / `reportRead` / `answer`） |
| 谁在页面上认领 | 页面 kind 座位 `ContentFrame.tsx`；它同时持有 frame 与 ref 表 |

页面工具（五个读 + `content_act`）与这套的关系只是「拿一个 callId 去 `open()`，等浏览器回一个 outcome」。

### 1.2 切口

**宿主半边：新服务 `ctx.contentChannel`（由 `content-frame` 提供）。**

```
packages/experimental/content-frame/src/access/channel.ts   （新）
  ChannelMember      一个域的登记口：名字 + 「这份报告体是不是我的」解析器
  ContentChannel     服务：PendingCalls 表 + 两条 route + member 登记 + open()/sessionOf()
  pendingProjection  从 requests-projection.ts 参数化抽出的通用「待办」投影构造器
```

- `ContentChannel` 拥有 `PendingCalls`（原表原样搬进服务，语义不变：单次 settle、settled 记忆、按 session 钉 tab、hold 首投窗口）。
- 两条 route 由服务注册一次：`/content-claim` 与域无关；`/content-report` 先只读 `{callId, tabId}` 这对两域共有的字段，再用「这个 callId 是哪个 member 开的」派发到该 member 的 `parseReport`。这样每个域的报告体校验（页面的字符/步数上界、组件的自己的上界）留在各自域里，不会互相误判。
- route 的注册时机：**第一个 member 登记时**。没有 member 就没有路由（保持今天「没有 `pageAccess` 时这些路径 404」的既有事实），有组件域登记时路由才出现。
- 成员限权（`members.ts` 的 `admitCaller`/`placeByMember`）、同站 JSON 围栏（`http.ts`）、body 上界都跟着 route 一起搬进服务，页面域的这几条不变量一字不改。
- `pendingProjection({ key, stateSchema, viewSchema, readCall, logger })` 是「待办」共享的那一半：页面域继续用 `contentAccess`（`contentAccessProjection` 变成它的一层薄包装，schema 与行为不变），组件域用同一个构造器注册自己的键。**投影键仍按域分摊**，因为键里的参数词汇（工具名 + 参数 arm）是域自己的词汇；把两域塞进一个键就得让页面那套换成泛型 arm 并在标签页里重新窄化，那是把页面域的行为拿去冒险，本阶段不做。

**浏览器半边：新模块 `ContentChannel`（`content-frame/client`）。**

```
packages/experimental/content-frame/src/client/access/channel.ts （新）
  ContentChannel  一个域一份实例：TAB_ID、hidden 宽限、bid loop、上报 + 一次重试、prune
  ChannelDomain   一个域的登记口：name、ready()、answer(call, claimed) -> { route, body }
  ChannelDemand   一个域座位每一帧报上的「我现在能答哪些 call、哪些 call 还开着」
```

- 座位（`ContentFrame` 与组件座位）每一帧把 `ChannelDemand` 报给它 `join` 的那个 channel；channel 按 openCalls 剪枝、按 started 去重、对未开始的 call 起后台 `answer()`（隐藏宽限 → claim → `domain.answer()` → 按 body 报到域自己指定的 route，未落地再报一次）。这套逻辑与今天 `executor.ts` 的 `answer()`/`claimRead()`/`reportRead()` 逐条对应，只是把「谁来答」变成了域的回调。
- 页面域把 `prepare()`/`readPage()`/`readImage()`/`actOnPage()` 原样留在 `executor.ts`，外面包一层 `pageDomain(...)`；`useContentRead(seat, channel = 页面自己的 channel)` 的签名与语义不变，于是页面那两份执行器回归测试一行都不用改——这是把它做成**每域一个实例的共享类**而不是一个 Cordis 单例服务的原因。组件域在 `component-surface/client` 里 `new ContentChannel()` 并实现自己的 domain。
- **代价（写进缺口）**：两个域的 client bundle 各自内联这份模块，于是各有一个 `TAB_ID`；一个 session 的调用在页面域与组件域之间交替时，宿主会多付一次 `PREFERRED_TAB_WINDOW_MS`（250ms）的 tab 钉选窗口。第一阶段接受这个代价，换取页面半边零改动。

**谁注册、谁消费。**

- 提供者：`content-frame`（宿主 `index.ts` 与 `client/index.ts`）。页面域是本接缝的第一个消费者，不是它的所有者。
- 消费者：`component-surface` 宿主半边 `ctx.inject(['contentChannel'], …)` 登记 member（报告体解析）并注册 `act_component` 的待办投影；浏览器半边 `ctx.inject(['contentChannel'], …)` 登记 domain 并把 `offer` 挂到组件座位的注入面（`ComponentSurfaceInjected`）。
- 依赖方向：`component-surface → content-frame`（新增依赖 + tsconfig reference）。反向没有边，不成环。

### 1.3 这一刀的已知缺口（留给主会话定）

1. **接缝的物理位置仍寄居 `content-frame`。** 于是一个只组合 `component-surface`、不组合 `content-frame` 的部署拿不到通道，`act_component` 只能超时。真正的解法是把宿主与浏览器两半的接缝移进独立包（或挂到两域共同的 `content-surface` 那一层），本阶段只把它收成一个窄接口，好让那次搬迁是纯搬运。
2. **客户端是「共享类、每域一份实例」而不是单例服务**（见 1.2 末条）：两域各有一个 tab 身份，交替调用要付一次 250ms 的钉选窗口。想让两域共用一个实例，要么让 `content-frame/client` 的插件在页面里扮演提供者并把实例通过 DI 交给组件域（代价是组件域从此要求页面行已加载），要么等接缝搬进独立包。本阶段取零改动页面回归网的那条路。
3. 页面域的报告体解析仍按页面上界校验（`maxTextChars`、`maxSteps`），组件域用自己的上界；两域的 `parseReport` 互不代劳，这正是成员派发要解决的事。

## 2. `act_component` 的入参与动作词汇表（最小集）

工具名 `act_component`。一次调用一个条目。

```jsonc
{
  "entry": "draft-1",          // 必填：这条调用针对的组件条目 id（show_component 的 id）
  "steps": [                    // 必填：1..maxSteps，按序执行，第一个失败就停
    { "action": "click", "key": "add", "node": "toolbar" },
    { "action": "set",   "name": "zh_label", "value": "X", "node": "grid" },
    { "action": "wait",  "node": "grid", "timeoutMs": 2000 }
  ]
}
```

步骤词汇（最小集，三个）：

| action | 字段 | 含义 | 解析 |
| --- | --- | --- | --- |
| `click` | `key`（必填）、`node`（可选） | 按下块里申明的那个控件 | 在 `node`（缺省＝整个条目容器）内找 `[data-component-action="<key>"]` |
| `set` | `name`（必填）、`value`（必填）、`node`（可选） | 给「这一列/这个属性」填值 | 先找 `[data-component-field="<name>"]`；退一步在 `node` 内找可写控件（input/select/textarea），按 `aria-label` / 关联 `<label>` / `placeholder` / `name` 与 `<name>` 相等来认 |
| `wait` | `node` 或 `key`（至少一个）、`timeoutMs`（可选） | 等块/控件画出来 | 在条目容器内轮询 `[data-component-node="<node>"]` 或 `[data-component-action="<key>"]` 出现 |

- `node` 是 spec 里那个块节点的 id（座位把它写成 `data-component-node`）；`key` 是组件在块里申明的动作键（渲染器写成 `data-component-action`，例如组件工具条上的 `add`）。
- `set` 的 `name` 是「列名/属性名」，不是 DOM ref；解析阶梯先认申明标记，再认可访问名字，两者都没有就拒绝。
- `timeoutMs` 有协议上限（不配置化），缺省取一个内置值。

结果（模型可见）：

```jsonc
{
  "status": "done" | "failed" | "unverified",
  "entry": { "id": "draft-1", "title": "…" },   // unverified 时缺席
  "steps": [ { "index": 1, "status": "ok" | "failed" | "skipped", "message": "…" } ],
  "text": "…"                                    // 人/模型读的一段说明
}
```

拒绝（都是「只说原因」，不泄漏容器外有什么）：

- 没有浏览器座位认领：`未认领`（沿用通道既有句式，附上现在栏里是什么）。
- 认领了但容器不在前 / 条目 id 不是现在画的这条：`这个条目现在不在内容栏里。`
- 步骤里 `node`/`key`/`name` 解析不到：`步骤 N：…`（指名参数，不列容器外的东西）。
- 解析到的元素在条目容器之外：一律拒绝，理由只说它不属于这个条目（`… is not part of the entry on display.`）。

## 3. 客户端执行器怎么在容器内执行

1. **定位容器**：`[data-content-surface-entry][data-content-surface-selected]` 的键（`<kind> <entryId>`）必须是 `component`，且 `[data-content-surface-seat="component"][data-content-surface-active]` 里存在 `[data-component-surface]`；两者同时成立才是「现在在前的组件条目」。这条定位逻辑沿用上一版 WIP 的 `component-entry.ts`（它可留用），本阶段把它从 `content-frame` 搬到 `component-surface/client`——组件容器的 DOM 契约属于组件域。
2. **条目匹配**：定位到的 `entryId` 必须等于入参 `entry`；不等就拒绝（另一条条目在前、或已经翻页）。
3. **逐步骤执行**：全部解析都在 `container` 子树内做（`container.querySelector`），命中元素再问一次 `container.contains(el)`；对容器外的元素（输入框、侧栏、审批卡、切换器、别的条目）一律在动作之前拒绝。
4. **动作**：`click` 直接 `el.click()`（走页面自己的事件处理器，React/Vue 都能收到）；`set` 用原型上的原生 value setter 写值，再派发 `input` + `change`，让框架的受控组件看到变化；`wait` 轮询到出现或超时。
5. **隔离**：执行器不碰 `refs` 表、不碰页面域的 mask/跨源/isTrusted 不变量，也不经过页面读的任何路径；它只读组件座位画出来的 DOM。

## 4. 与 content-page 那套怎么隔离

- 工具面：`act_component` 只出现在 `component-surface` 的行里；页面的六个工具一个都不改签名、不改描述、不改行为。
- 通道面：两域在同一个 `ContentChannel` 上各登记各的 member/domain；claim 只看 callId，report 按 callId 的归属派发到一个 member；投影键分开（`contentAccess` / 组件的键），互不读对方的 arm。
- 语义面：页面的遮罩（dialog watch）、跨源、`isTrusted`/ref 表、frame 生命周期全部留在 `content-frame`，组件域一行都不借用。
- 容器面：组件域把「调用只能落在条目容器内」当作自己的不变量在客户端再查一次，不依赖宿主的任何假设。

## 5. 三件必须查清的事（现状）

- **A：下拉浮层挂 `body`、在容器外怎么办。** 组件的 `set`/`click` 有可能要开一个浮层（el-select 的下拉、日期面板），DOM 会挂到 `document.body`，即在条目容器之外。本阶段的做法是先不处理：解析阶梯只在容器内找，浮层里的元素够不着就拒绝。第二阶段的候选是「容器 + 由这次调用自己打开、且能追溯到容器内触发元素的浮层」这一窄口径，但需要先在真实组件上量出来有哪些形态。
- **B：组件读返回什么。** `act_component` 本轮只回答「哪些步骤跑了、成没成、为什么不成」，不回读组件内容；组件读（把条目当前的表格/筛选状态读回给模型）是另一件事，本轮不做决定。
- **C：与 content-point 拾取的互斥。** 拾取（content-point）靠用户的指针在页面上选元素，而 `act_component` 会在容器内合成事件。互斥规则（例如拾取进行中一律拒绝 `act_component`、或两者各自加锁）留待与拾取那条线对齐后再定；本阶段不做。
