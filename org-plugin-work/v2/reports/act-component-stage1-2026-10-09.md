# act_component 第一阶段报告（2026-10-09）

工作树 `/Volumes/outside-ssd/CODE/learn/learning-project/dsh-component-act`，分支 `feat/component-act`，基线 `cb8b396c80`。
设计说明见 `org-plugin-work/v2/reports/act-component-design-2026-10-09.md`（已按实现偏差回写）。

## 1. 做了什么

**0. WIP 退场。** 上一版按错形状做的 11 个文件（含 `within` 穿透 collect/act/snapshot/markup/settle/dom 的旁路）用 `git checkout -- .` 干净回退，工作树回到基线；那份未跟踪的 `component-entry.ts` 容器定位逻辑留用，搬到组件域（见下）。

**1. 设计说明落地**（commit `0af5f263b0`）。

**2. 通道接缝**（commit `e4c4fddb2e`）——把「认领/待办/上报」从页面域里抽成两域共用的窄接缝：

- 宿主：`ContentChannel` 服务（`content-frame/src/access/channel.ts:169`）持有等待表与两条 route（`/content-claim`、`/content-report`），并接受 `ChannelMember` 登记（`channel.ts:73`：域的名字、报告体宽、以及「这份报告体是不是我的」解析器）。route 在**第一个 member 登记时**才注册，因此「没配 `pageAccess` 就 404」这条既有事实不变。
- 报告体派发按 callId 的归属走：`PendingCalls` 的等待项带上了登记的 member 名（`pending.ts`），报告体先读 `{callId, tabId}` 再交给该域解析（`channel.ts` 的 `readReport`）；已 settle 的 call 找不到属主时依次问每个 member，与单域时的行为逐字相同。
- 待办共享：`foldPending`（`channel.ts:105`）与 `checkedPending`（`channel.ts:146`）从 `requests-projection.ts` 参数化抽出，页面域继续用 `contentAccess` 键（行为、schema、日志句子都不变）。
- 浏览器侧：`ContentChannel`（`content-frame/src/client/access/channel.ts:219`）持有 TAB_ID、隐藏宽限、bid loop、上报与一次重试；一个域用 `join(domain)` 加入（`ChannelDomain`：name / ready / answer），座位每帧 `offer({calls, openCalls})`，`park()` 结束。页面域的 `pageDomain`（`executor.ts`）与组件域的 domain 各写自己的 answer。
- 页面域零回退：`content_act` 的遮罩/跨源/isTrusted/ref 表一行未动；页面那两份执行器回归测试（66 + 66 例）与路由用例（41 例）一字未改地全过。

**2b. 浏览器侧接缝改成 Cordis 服务**（commit `f4ec367561`，纯为过构建门）——客户端 bundle 的 purity 门（`packages/client/tsdown.client.ts` 的 `dsh-client-bundle-purity`）禁止跨插件 **value** import（type-only 会被擦除，允许）。于是：

- 页面行把它提供的 channel 注册为 `ctx.contentTabChannel`（`content-frame/src/client/index.ts:169`；名字是本半边自己的，因为宿主半边已占 `contentChannel`，两个面同属一个 typecheck 程序，一个 context 键不能是两个服务）。
- 另一个域只 `import type` 接缝的形状，运行时从 `ctx.inject(['contentTabChannel'])` 拿实例（`component-surface/src/client/index.ts:121`），完全不 import 对方的值。
- 域的 answer 变成带判别的联合：`{kind:'body', route?, body}`（自己称过重量的读）或 `{kind:'outcome', route?, outcome}`（由 channel 组文档、知道 callId 与 tab）。组件域用后者，因此连 route 常量都不必知道。

**3. `act_component` 最小可用**（commit `496b0d0ed9`）：

- 宿主：工具（`component-surface/src/act-component-tool.ts:143`）、待办投影 `componentAccess`（`act-component-projection.ts:124`，stateVersion 1）、以及接入 channel 的 member（`index.ts:440` 的 `installActComponent`，需要 `tools + contentChannel + sessionProjections` 才装，缺一不提供工具）。新增两个部署可配的死线：`actClaimTimeoutMs`（默认 5000）、`actTimeoutMs`（默认 15000），均在 `Config` 里校验。
- 浏览器：容器定位（`client/entry-container.ts:59`，沿用上一版逻辑：选中 tab 的 `<kind> <entryId>` × `[data-content-surface-seat="component"][data-content-surface-active] [data-component-surface]`），步骤执行器（`client/act-executor.ts:250`），域接线（`client/act-channel.ts:69`）。座位的注入面多了 `offerCalls`/`parkCalls`（`ComponentSurface.tsx:135-137`），每帧读本 session 的 `componentAccess.pending` 报价，卸载时 park。

**4. 一条 jsdom 单测**（commit `a6091aeedf`）：`component-surface/tests/act-component-executor.client.spec.ts`（10 例）——容器内点击落到组件自己的处理函数；容器外（控制台侧栏）的按钮与输入框一律够不着且不被触碰；失败的步骤停下并把它后面的记为未跑；`wait` 等后画的块；参数解析拒绝缺目标/超界的步骤。

## 2. 改动清单（相对 `cb8b396c80`，共 32 个文件，+2832/−366）

**content-frame（页面域接缝宿主）**

| 文件 | 内容 |
| --- | --- |
| `src/access/channel.ts`（新，350 行） | `ContentChannel` 服务 `:169`、`ChannelMember` `:73`、`foldPending` `:105`、`checkedPending` `:146`、两条 route 的注册与处理 |
| `src/access/pending.ts` | 等待项带上 member 名；`CallTable` / `ReportSink` 两个窄接口（工具只依赖这两个） |
| `src/access/requests-projection.ts` | 用自己的 schema 调共享的 fold/check，日志句 `contentAccess refused its own view` 不变 |
| `src/index.ts` | 无条件建 channel（`place` 由 `perMember` 决定）；`claimPageAccess` 只登记页面 member（`register` 处 `:593`）并把 `CallTable` 交给五个读与 `content_act`；图片 route 走 `ReportSink` |
| `src/access/{act-tool,read-tool,read-value,image-report}.ts` | 参数类型 `PendingCalls` → `CallTable` / `ReportSink`（纯类型，行为不变） |
| `src/client/access/channel.ts`（新，336 行） | `ContentChannel` `:219`、`ChannelDomain`/`ChannelSeat`/`ChannelAnswer`、claim/post/retry、`contentTabChannel` 声明 |
| `src/client/access/executor.ts` | `pageDomain` + `useContentRead(seat, channel = PAGE_CHANNEL)`；`prepare`/`readPage`/`readImage`/`actOnPage` 原样 |
| `src/client/index.ts` | 提供 `contentTabChannel`（重复 apply 幂等）并把 channel 挂进座位注入面 |
| `src/client/ContentFrame.tsx` | 面多一个 `channel`，透传给 `useContentRead` |
| `tests/browser-plugin.client.spec.ts` | 注入面多一个键的期望 |

**component-surface（组件域）**

| 文件 | 内容 |
| --- | --- |
| `src/act-component-call.ts`（新，381 行） | 工具名 `:36`、步骤与参数类型、`readActComponentStep` `:165`、`parseActComponentArgs` `:216`、`parseActComponentOutcome` `:255`、`parseActComponentReport`、`componentAccess` 投影声明 |
| `src/act-component-text.ts`（新，202 行） | 工具描述、参数描述、拒绝句、报告文案 |
| `src/act-component-tool.ts`（新，274 行） | `actComponentTool` `:143`（execute / 输出 schema / 卡片） |
| `src/act-component-projection.ts`（新，133 行） | `actComponentProjection` `:124`；本地的 fold 与自检（理由见 §5） |
| `src/index.ts` | `actClaimTimeoutMs`/`actTimeoutMs` 配置 `:205-241`、`installActComponent` `:440` |
| `src/client/entry-container.ts`（新，70 行） | `drawnEntry` `:59` |
| `src/client/act-executor.ts`（新，274 行） | `runActComponent` `:250`、`runStep`/解析阶梯/`writeValue`/`waitFor` |
| `src/client/act-channel.ts`（新，124 行） | `joinActComponentChannel` `:69`、两条拒绝（`empty` / `front-changed`） |
| `src/client/index.ts` | `ctx.inject(['contentTabChannel'])` 并接线 `offerCalls`/`parkCalls` |
| `src/client/ComponentSurface.tsx` | 注入面两项 + 报价 effect |
| `package.json` / `tsconfig.host.json` / `tsconfig.client.json` / `pnpm-lock.yaml` | 依赖 `@deepseek-ai/dsh-experimental-content-frame` 与项目引用 |
| `tests/act-component-executor.client.spec.ts`（新，185 行） | §1.4 的那条单测 |
| 三个既有座位测试 | props 多两个函数（座位注入面新增项） |

## 3. 跑过的命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm exec tsc -b packages/experimental/component-surface/tsconfig.json packages/experimental/content-frame/tsconfig.json` | 两包**零错误**；只剩本工作树既有的 `Property 'commands' does not exist on type 'ClientRemote'`（见 §5） |
| `pnpm exec vitest run --maxWorkers=2 packages/experimental/content-frame/tests packages/experimental/component-surface/tests` | **69 文件 / 1745 例全过** |
| 同上，加 `content-kit`、`content-column`、`content-surface` 三个邻居包 | 32 文件 / 345 过 / 2 skip |
| `pnpm --filter @deepseek-ai/dsh-experimental-component-surface run bundle` | host 与 client bundle 都成功（client 过 purity 门：无跨插件 value import） |
| `pnpm exec tsx scripts/run-oxlint.ts --config .oxlintrc.staged.json <改动文件>` | 0 warning / 0 error |
| `pnpm exec lefthook run pre-commit`（手动跑四个 hook） | whitespace / vendor manifest / lint / third-party notices 全过 |
| `pnpm run build:lib:host`（即 `pnpm run typecheck` 的第一步） | **本工作树既有地失败**：69 个 `error TS`，全部落在 `packages/api/*`、`packages/client/*` 的 `ClientRemote` 与服务 `src/client/*`（缺生成出来的 `@deepseek-ai/dsh-*/remote` 描述文件），我一个都没碰；我的两包在其中只有那 1 条既有 `navigated.ts` 错误 |

**提交列表**（每条都单独提交）：

```
0af5f263b0 docs(component-act): write the stage-1 design for the shared content channel and act_component
e4c4fddb2e refactor(content-frame): extract the claim/pending/report apparatus both content domains deliver calls through
f4ec367561 refactor(content-frame): reach the tab-side call channel through a client service
496b0d0ed9 feat(component-surface): offer act_component and run its steps inside the drawn entry
a6091aeedf test(component-surface): check the component action confine against a real document
```

注：本工作树 `git commit` 的 lefthook 钩子因 PATH 里没有 `node` 而失败（`node_modules/.bin/tsx: exec: node: not found`），所以提交用了 `LEFTHOOK=0`，并在提交前手动跑了同样的四个 hook（结果如上表）。

## 4. schema 与动作词汇表（已实现）

```
act_component(entry: string, steps: 1..8 Step)

Step =
  | { action: 'click', key: string,        node?: string }
  | { action: 'set',   name: string, value: string, node?: string }
  | { action: 'wait',  node?: string, key?: string, timeoutMs?: 1..10000 }
```

- `entry` = `show_component` 摆那条条目用的 id；必须是**现在在前**的那一条，否则拒绝。
- `node` = spec 里块节点的 id（座位写成 `data-component-node`）；省略就在整个条目里找。
- `key` = 组件为某个控件申明的动作键（渲染器写成 `data-component-action`，例如确认条的按钮 id、查询条的 submit）。
- `name` = 列名/属性名；解析阶梯先认 `data-component-field="<name>"`，再认块内可写控件自己的 `aria-label` / `name` / `placeholder`，最后认**条目内**的 `<label for>` 文案。
- `wait` 等到该 block 或该 key 出现，或超时。

结果（模型可见）：`{ status: 'done'|'failed'|'unverified', entry?: {id,title}, steps: [{index,status,message?}], text }`。
线形：本条目的 outcome 复用共享 channel 自己的「跑了步骤」词汇（与 `content_act` 同一个 `ActOutcome`），因此不需要给 channel 的 `ChannelOutcome` 加组件专属 arm，报告体也无需判别的第二次校验。

拒绝（只说原因）：`empty`（栏里没有组件条目）、`front-changed`（在前的是另一条）、以及每个步骤自己的句子（`control "x" is not part of the entry on display.` 等）。

## 5. 三件必须查清的事（现状）

- **A：下拉浮层挂 `body`、在容器外。** 本轮**不处理**：解析只在条目容器内做，挂到 `body` 的浮层够不着，于是「点开下拉再选一项」这种两步动作需要组件自己提供容器内的选项标记（或后续给 channel 加一条「本次调用自己打开、可追溯到容器内触发元素」的窄口径）。这是下一阶段最需要先在真组件上量化的一件事。
- **B：组件读返回什么。** 本轮**只报现状、不做决定**：`act_component` 只回答「哪些步骤跑了、成没成、为什么不成」，不回读组件内容。组件读（把条目当前的表格/筛选状态回读给模型）是独立的第二件工具，等主会话定形状。
- **C：与 content-point 拾取的互斥。** 本轮**不做**：`act_component` 会在容器内合成 click/input/change，拾取靠用户指针选元素，两者的互斥规则（拒绝、还是各自加锁）留待与拾取那条线对齐。

## 6. 没做的、留给主会话定的

1. **接缝的物理位置**。宿主接缝今天寄居 `content-frame`（`ctx.contentChannel`），浏览器接缝寄居它的 client 半边（`ctx.contentTabChannel`）。后果：一个只组合 `component-surface`、不组合 `content-frame` 的部署，宿主侧 `installActComponent` 的 `inject(['tools','contentChannel','sessionProjections'])` 不会触发 → 不提供 `act_component`（会明确地“没这个工具”，而不是每次调用超时）。真正的解法是把接缝移进独立包（或挂到两域共同的 `content-surface` 那层），那次搬迁应当是纯搬运。
2. **浏览器侧因为构建门而没能共享的两处**：客户端 bundle 的 purity 门禁止跨插件 value import，于是 (`foldPending`+`checkedPending`) 与 (`isActOutcome`) 在组件域各写了一份（`act-component-projection.ts` / `act-component-tool.ts`，各带注释说明原因）。要么把接缝搬进独立包，要么让 channel 服务把这些纯函数作为方法暴露出来。
3. **未覆盖的路径**：客户端 claim/report 循环本身（组件域那半）没有单测——它的回归网目前是页面域那两份执行器测试加上手工的 bundle 构建；组件域的 `offer → claim → report` 全链路（含两条拒绝的线上形态）值得补一条带 fetch mock 的用例。
4. **一个 session 内两域交替的代价**：两域各自的 channel 实例会各铸一个 TAB_ID（页面域用自己的模块单例，组件域用服务实例），宿主的 session→tab 钉选每次交替多付 250ms。要让两域共用一个身份，需要让页面座位也用那个服务实例（本轮为了不动页面回归测试而没做）。
5. **coverage 门**：`pnpm run test:coverage` 要求 `packages/*/*/src` 逐文件 100%，本轮新增文件远未覆盖（只跑了行为测试），要进 CI 前需要补齐或走豁免路径。
6. **未跑**：`pnpm run typecheck` / `build:lib:host` 在本工作树既有地失败（见 §3），`doc-sync`、`duplication`、快照类门未跑；`README` 与 i18n 文件没跟改（新工具是模型可见面，按仓库规矩应补 `packages/experimental/component-surface/README.md` 的 `act_component` 一节）。
7. **没有合并、没有推送**：只在本地 `feat/component-act` 上提交了这 5 条。
