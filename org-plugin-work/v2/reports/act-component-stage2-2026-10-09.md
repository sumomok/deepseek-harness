# act_component 第二阶段报告（2026-10-09）

工作树 `/Volumes/outside-ssd/CODE/learn/learning-project/dsh-component-act`，分支 `feat/component-act`，stage 1 结束于 `d2eb206161`，本轮基线仍是 `cb8b396c80`。stage 1 的设计与报告见 `org-plugin-work/v2/reports/act-component-design-2026-10-09.md` 与 `act-component-stage1-2026-10-09.md`。**没有推送、没有合并**，只在本地分支提交。

本轮把 stage 1 交出来的东西补到可验收：修掉一处真的会出错的标签页身份不一致，把组件域的全链路和逐文件覆盖率补满，工具与通道写进中英 README（含 i18n 记录），并落下一条 Agent Note 记两条约束。

## 1. 做了什么

### 1.1 修掉一处真错：页面域的认领与上报曾经不是同一个标签页

stage 1 的接缝让页面座位**认领**走注入的 `ctx.contentTabChannel` 实例，**上报**却用模块级常量 `TAB_ID`（另一个 `ContentChannel` 实例的 id）。宿主把一次调用的认领钉在某个 tabId 上，上报必须由同一个 tabId 送达——两个 id 会让页面读/写在真实部署里一直走不通，而页面那两份执行器测试各自只用一个一致的身份，测不出来。

修法是把「每个页面加载一个通道」变成常量本身：`PAGE_CHANNEL` 由 `content-frame/src/client/access/executor.ts` 导出，行入口把它作为 `ctx.contentTabChannel` 提供（不再 `new` 第二个），`ContentFrame` 从交给它的实例上读 `tabId` 再交给座位。于是页面对组件域都是同一个实例、同一个标签页身份。断言两处：`browser-plugin.client.spec.ts` 里 `face.channel === ctx.contentTabChannel` 且它的 `tabId === TAB_ID`；链路测试里页面式的第二个域与组件域在同一次出价中报出同一个 tabId。

### 1.2 把组件域自己的两处「读」收紧到它自己声明的契约

- `parseActComponentOutcome` 曾经接受「失败的步骤没有话」和「成功的步骤带着话」，而 `act-component-call.ts` 的 JSDoc 与页面域的 `parseStepResult` 都写着失败的那一步才是唯一带话的一步、失败没有话是模型无法据以行动的答案。现在这一读与页面域一致（`isStepResult`），失败的步骤必须带不超过 512 字符的话，成功/未跑的一步不许带话。
- `act-component-text.ts` 里 `result.message ?? 'failed'` 的兜底是类型上不可能到达的（失败臂必带 message），删掉。
- `client/entry-container.ts` 的选中标记原本写成 `[data-content-surface-entry][data-content-surface-selected]`，这让 `key === null` 那条拒绝永远到不了；改为按内容栏真正写的标记选（`[data-content-surface-selected]`），再把键当作第二个事实读，那一支就成了可达的拒绝（并有测试）。
- `client/act-executor.ts` 删掉两处走不到的模板兜底：`block "…"` 的 `step.node ?? ''`（scope 缺失只可能是「点了名的块没画」）与 wait 超时句的 `?? ''`（解析器保证 wait 至少点名 block 或 key）。行为不变，只有不可达分支消失。
- `act-component-tool.ts` 的输出 schema 与 `content-frame` 的 `content-act` 输出 schema 被 jscpd 认作一份克隆（stage 1 就存在）。两者是两个域自己的步骤词汇，跨包值引入正是本行不能做的事，因此按仓库已有的 `jscpd:ignore-start/end` 机制标注并写明判断，使这次交付不再给 `duplication` 门加一份克隆（仓库基线的 4 份克隆不变）。

### 1.3 测试：组件域全链路 + 逐文件覆盖

- **全链路**（`tests/act-component-chain.client.spec.tsx`，8 例）：真实组合（webserver、tools、sessions、projections、content-surface、带 `pageAccess` 的 content-frame、本行），浏览器半边用真实的 `ContentChannel`，`fetch` 指向被服务出去的 origin，于是**认领与上报真的走宿主那两条路由**。用例覆盖：一次调用从 `tool/call` 事件 → `componentAccess` 投影 → 认领 → 在真实文档里点中条目内的控件 → 上报 → 模型可见的值与渲染文本，并断言投影里那次调用随 `tool/result` 消失；条目不在前（`front-changed` 拒绝句）；容器越界（容器外的按钮不被触碰，步骤失败）；步数上限（9 步，未发出任何认领投递）；超时两种（`actTimeoutMs` 内认领后不回报 → `unverified`；`actClaimTimeoutMs` 内无人认领 → 带时限的拒绝）；以及本域读不了的报告被宿主路由以 400 拒绝而调用仍在等待。
- **组件域自己的一份**（`tests/act-component-channel.client.spec.ts`）：`joinActComponentChannel` 的空栏、换条、跑步骤三种 answer，`offer` 的两种会话形态与 `park`。
- **宿主通道的服务侧**（`content-frame/tests/content-channel.client.spec.ts`）：一对路由上的两个 member（覆盖「第一个之后的登记不再认领路由」），以及两条路由都要读的 `sessionOf`。
- 其余新增单测文件：`act-component-call.client.spec.ts`（解析三动作与报告的双侧边界）、`act-component-projection.client.spec.ts`（折叠两条日志形状 + 视图自检成功/失败）、`act-component-tool.client.spec.ts`（提供面、卡片、六种结局与参数拒绝）、`act-component-text.client.spec.ts`（每句话与三条报告分支）、`act-component-gate.client.spec.ts`（只读名单的负向钉子）。`act-component-executor.client.spec.ts` 从 10 例扩到 24 例（字段的四种命名路径、select/textarea/无 value 访问器/控件拒收、非 HTMLElement 的按下、块未画、wait 的默认与超时）。
- 本轮 9 个文件共 85 例（其中 8 个是新增文件）；两个包加三个邻居包合计 **109 文件 / 2167 通过 / 2 skip**。

## 2. 提交列表（本轮 8 条，均在 `feat/component-act`）

```
7938ba9a9c chore(component-surface): mark the component answer's schema as a deliberate parallel of the page tool's
1170a4ceb1 docs(component-act): record the shared channel's seam, its composition prerequisite and its duplication constraint
1421851d04 docs(content-frame): state the channel service and the two domains that join it
390aab39a1 docs(component-surface): state what act_component does, where it is confined, and what it deferred
bb8bbaf30c test(component-surface): cover the component action from the log through the claim and report to the drawn entry
236153d78e refactor(component-surface): read the selected entry by its own marker, and name a target without a dead branch
5fa7eaf61e fix(component-surface): hold a posted step result to the reading the page domain uses
9ce041de56 fix(content-frame): settle a page call under the one channel the page provides
```

stage 2 的 diff 范围：`d2eb206161..HEAD`（30 文件，+2209/−47，含 3 份 README/记录与 1 条 Agent Note 三件套）。整轮交付的范围是 `cb8b396c80..HEAD`。

## 3. 覆盖率（逐文件 100%）

命令（限制 include 到两个包，逐文件阈值按仓库配置生效，未加任何豁免）：

```
vitest run --maxWorkers=2 --coverage \
  --coverage.include='packages/experimental/component-surface/src/**' \
  --coverage.include='packages/experimental/content-frame/src/**' \
  packages/experimental/component-surface/tests packages/experimental/content-frame/tests \
  packages/experimental/component-kit/tests packages/experimental/content-column/tests packages/experimental/content-surface/tests
```

结果：**Statements / Branches / Functions / Lines 全部 100%（5579/5579、3985/3985、1213/1213、4654/4654）**，两个包 `src` 下 **98 个文件全部 100%，0 个低于阈值**。本轮与 stage 1 新增/改动的文件逐个：

| 文件 | Lines | Branches | Functions | Statements |
| --- | --- | --- | --- | --- |
| `component-surface/src/act-component-call.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/act-component-text.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/act-component-tool.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/act-component-projection.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/index.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/client/act-executor.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/client/act-channel.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/client/entry-container.ts` | 100 | 100 | 100 | 100 |
| `component-surface/src/client/index.ts` | 100 | 100 | 100 | 100 |
| `content-frame/src/access/channel.ts` | 100 | 100 | 100 | 100 |
| `content-frame/src/client/access/channel.ts` | 100 | 100 | 100 | 100 |
| `content-frame/src/client/access/executor.ts` | 100 | 100 | 100 | 100 |
| `content-frame/src/client/ContentFrame.tsx` | 100 | 100 | 100 | 100 |
| `content-frame/src/client/index.ts` | 100 | 100 | 100 | 100 |

（`content-frame/src/index.ts`、`pending.ts`、`requests-projection.ts` 等 stage 1 碰过的文件同样在 100% 之列，包含在「98 个文件」里。）

## 4. 跑过的命令与结果（只列真跑过的）

| 命令 | 结果 |
| --- | --- |
| `tsc -b packages/experimental/component-surface/tsconfig.json packages/experimental/content-frame/tsconfig.json` | **rc=2**，73 条错误，全部是本工作树既有的 `ClientRemote` / 缺生成 `*/remote` 描述文件问题（`packages/api`、`packages/client`、`content-column` 等）。用 `git stash` 在 stage-1 状态重跑同为 73 条，`diff` **逐条位置与文本完全一致** → 本轮未新增任何类型错误 |
| `tsc -b tsconfig.client.json`（含全部测试的客户端聚合） | **rc=2**，788 条既有错误；与 stage-1 状态的 788 条逐条位置比对 **0 处差异** → 新增的 9 个测试文件与改过的测试文件类型干净 |
| `vitest run --maxWorkers=2 <两个包 + component-kit + content-column + content-surface>` | **109 文件 / 2167 通过 / 2 skip** |
| 上面的命令加 `--coverage`（include 限两个包） | 逐文件阈值全过，100/100/100/100 |
| `tsx scripts/run-oxlint.ts --config .oxlintrc.staged.json <20 个改动 ts/tsx>` | **0 warnings / 0 errors** |
| `tsdown`（component-surface 包目录内） | host 与 client 都成功；client 过 purity 门（205.94 kB，gzip 54.17 kB） |
| `tsdown`（content-frame 包目录内） | host 与 client 都成功（client 320.88 kB，gzip 90.10 kB） |
| `jscpd --config .jscpd.json packages scripts` | 4 份克隆（与本轮之前相同；本行输出 schema 的那份已标注，不再计入） |
| `verify-translation-pairing --write` + 复核两包 README 与 Agent Note | `consistent`（1+1+1 pair） |
| `verify-md-links` | 2034 文件，全部相对链接与片段可解析 |
| `verify-md-wrap` | 2062 文件，无硬换行段落 |
| `verify-doc-budgets` | 8 个受预算文件全在 ceiling 内 |
| `verify-agent-note-format` | 408 条 Note 全部合规（含本轮新增） |
| `verify-export-jsdoc` | 每个包的导出都有文档 |
| `verify-repository-references` | **rc=1**：13 处 commit 标识全在 `org-plugin-work/v2/reports/**`（stage 1 的设计/报告与 stage 2 报告都会带 commit 列表），仓库里其他文件无问题；见 §7 |
| `pnpm run build` 系列 | 未跑（按纪律不用它）；pre-push 的 typecheck 在本工作树因缺生成 `*/remote` 既有失败，未 `--no-verify`，未推送 |

## 5. 主会话五条决定的落实

1. **接缝留在 `content-frame`。** 两份 README 都写清前提：`component-surface` 的 Composition 段新增一段（只组合本行不组合 content-frame 时提供 `show_component` 而没有 `act_component`），Known Limitations 多一条「工具只在共享通道被组合时才存在，通道今天住在 content-frame」，`content-frame` README 的「通道」一节补了服务与两域（§5 细节在下面第 3 条处）。抽成中立包记成待办（Agent Note 记了两种搬法与被权衡的理由）。**已做。**
2. **浮层本轮不放出容器。** v1 规则 = 每一步的查找都以条目容器为界，浮层（挂 `body`）一律拒绝；`act-component-text.ts` 的 `missingTargetReason` 对「哪里都没有」和「在条目之外」是同一句话。README 新增的「Acting inside the entry on display」一节写明规则与后果（组件要把浮层画进条目，`component-kit` 的对话框已经这么做），Known Limitations 里写成已知限制并给出复查触发点（第一个无法把选择器搬进条目的组件插件）。**已做（本轮没有改执行器的搜索边界，只把它写清楚并补了相应单测）。**
3. **组件读不做；与 content-point 拾取的互斥做不到，留给 T05。** 互斥要在 act 侧成立，需要 content-point 的浏览器半边暴露出「正在拾取」这一事实（一个客户端服务，本行的浏览器半边注入它并据此拒绝），而这必须改 content-point 的代码；今天 `content-point` 不在本工作树的组合里，其拾取状态是该包自己的客户端状态，按 DOM 私有属性去猜会违反「包边界显式优于隐式」。因此**没有实现**，写进了 `component-surface` README 的新一节与 Known Limitations，并在 §7 给 T05 留了具体形状。**按主会话允许的退路处理。**
4. **纯函数重复先查共享纯模块。** 查了三个候选：`content-surface` 的 `types.ts`（只有类型、没有客户端面、`./types` 不是运行时入口）、`content-frame/src/access/wire.ts`（有运行时函数，但跨包值引入要么被客户端 purity 门直接拒绝，要么因 `content-frame` 是 peer 依赖而被 tsdown 的宿主规则（非生产依赖一律 `alwaysBundle`）内联进本包宿主产物）、`packages/util/*`（在允许改动的范围之外）。结论：**放不了**，保留两份（`act-component-projection.ts` 的 `foldPending`、`act-component-tool.ts` 的 `reportsSteps`，两处注释都写明约束），并**新增**了 `.agents/notes/implemented/architecture/2026-10-09-content-channel-seam-and-duplication.md`（+ `.zh.md` + `.i18n.yaml`）把这件约束与接缝位置一起记下。**已做。**
5. **TAB_ID 两域各铸一个 → 整标签页一个。** 见 §1.1：`PAGE_CHANNEL` 是唯一的页面加载实例，行入口提供它，页面座位与组件域共用；补了两条断言（browser-plugin 的实例同一性；链路测试里两个域同一次出价报同一个 tabId）。**已做。**

## 6. 文档三份对齐的证据

- `packages/experimental/component-surface`：`README.md`（新增「Acting inside the entry on display」整节、Composition 一段、Configuration 六→八个字段、Model Experience 两组共六个小节、Known Limitations 三条）与 `README.zh.md` 逐节对应；`README.i18n.yaml` 由
  `tsx scripts/verify-translation-pairing.ts --write packages/experimental/component-surface/README.md`
  重录（47 行变更），随后复核 `consistent`。
- `packages/experimental/content-frame`：「### The channel」一节新增两段（宿主 `ctx.contentChannel` / 浏览器 `ctx.contentTabChannel`、member 与 domain、报告按属主派发、每域一个投影键、一个页面加载一个实例与标签页身份），review-gate 一节加一句 `act_component` 同样留给闸逐次判；中文对应；`README.i18n.yaml` 重录（12 行变更）并复核 `consistent`；两份文件都补了 `<a id="the-channel"></a>` 使中英可用同一片段锚点。
- Agent Note 三件套的 `.i18n.yaml` 由同一工具重录（新增 22 行）并复核 `consistent`。
- `verify-md-links`（2034 文件）、`verify-md-wrap`（2062 文件）、`verify-doc-budgets`、`verify-agent-note-format`（408 条）全过。
- 工具描述与参数说明由 `verify-translation-pairing` 的「工具文案自包含」规则管的是代码侧文案（英文），README 的 Model Experience 按其原文逐句描述，不另立一份会漂移的目录。

## 7. 没做的、留给主会话/复核的

1. **互斥（T05 的活）**：建议的缝是 `content-point` 的客户端半边提供一个服务（例如 `ctx.contentPick`，方法 `active(): boolean`），本行浏览器半边**可选注入**它，并在 `joinActComponentChannel` 的 answer 里于 `drawnEntry` 之前先判：拾取进行中则回一条 `{status:'error', kind:'engine'…}` 之类的拒绝句（或新增一个共享通道的失败码）。不建议 act 侧读 DOM 私有属性。另需决定：拒绝是整次调用拒绝，还是只拒绝会合成事件的 `click`/`set`。
2. **快照**：本轮**没有**加 keyless recorded-session 快照。`act_component` 是模型可见的新工具，按仓库规矩值得一条；console 快照道走 ACP、没有命令方法，要覆盖它需要 web 场景 + 组合 `component-surface` 的 profile，属于另一条线。这是本轮明确留下的已知缺口。
3. **`verify-repository-references` 在本工作树是红的**：13 处全是 `org-plugin-work/v2/reports/**` 里的 commit 标识（stage 1 的设计/报告 + 本报告）。报告目录是本次任务的交付位置且要求写 commit 列表，所以**没有**为过门而删掉；如果主会话要 `doc-sync` 全绿，需要把报告目录加进该门的豁免或把报告挪出受维护的树。
4. **typecheck/pre-push 的既有失败**：`packages/api`、`packages/client` 等缺生成出来的 `*/remote` 描述文件，两个包 leaf 配置 73 条、客户端聚合 788 条，逐条与本轮之前一致。未 `--no-verify`，未推送。
5. **`build:lib:host`（即 `pnpm run typecheck` 第一步）** 在本工作树仍会因同一原因失败；本条与 stage 1 相同，未重跑（已用两包 leaf + 客户端聚合两次对照证明本轮零新增）。
6. **组件读（B 项）** 仍未做，保持 stage 1 的现状：`act_component` 只回答哪几步跑了、成没成、为什么不成。
7. **两个纯函数共享的两条出路**（Agent Note 里记了）：把接缝搬进独立包，或让通道服务把纯函数作为方法暴露。前者是纯搬运，后者会加宽通道公开面；本轮都不做。

### 独立复核要用的材料

- **diff 范围**：`d2eb206161..HEAD`（本轮 30 文件）；整轮 `cb8b396c80..HEAD`。重点文件：`content-frame/src/client/access/executor.ts`（身份）、`ContentFrame.tsx`、`client/index.ts`、`component-surface/src/act-component-call.ts`（`isStepResult`）、`client/entry-container.ts`、`client/act-executor.ts`。
- **建议的变异点（改一处应当由哪条测试抓住）**：
  1. `ContentFrame.tsx` 的 `tabId: channel.tabId` 改回一个自铸常量 → `browser-plugin.client.spec.ts` 的 `face.channel`/`tabId` 断言 + 链路测试的「两个域同一个 tabId」。
  2. `entry-container.ts` 的 `SELECTED_TAB` 改回带 `[data-content-surface-entry]` 的复合选择器 → `act-component-executor` 的「没有键的选中标签页」用例（会变成不可达而覆盖率下降）。
  3. `act-executor.ts` 的 `scopeOf` 把 `entry.container` 换成 `document.body` → 「容器越界」三条用例（console 的按钮会被点到）。
  4. `act-channel.ts` 去掉 `drawn.entryId !== call.request.args.entry` 的判断 → 链路测试的 `front-changed` 用例。
  5. `act-component-call.ts` 的 `isStepResult` 把失败步骤的消息判据改回 `message === undefined || …` → `act-component-call.client.spec.ts` 的两条拒绝用例。
  6. `content-frame/src/access/channel.ts` 的 `readReport` 把「按属主 member 派发」换成只问第一个 member → 链路测试里「本域读不了的报告被 400 拒绝」+ `content-channel.client.spec.ts` 的双 member。
  7. `client/access/channel.ts` 的 report 体里把 `tabId` 换成别的常量 → 链路测试的正文断言（claim 与 report 同一个 tabId）。
- **验收命令**（照抄即可）：
  ```
  # 覆盖率 + 两个包 + 邻居
  vitest run --maxWorkers=2 --coverage \
    --coverage.include='packages/experimental/component-surface/src/**' \
    --coverage.include='packages/experimental/content-frame/src/**' \
    packages/experimental/component-surface/tests packages/experimental/content-frame/tests \
    packages/experimental/component-kit/tests packages/experimental/content-column/tests packages/experimental/content-surface/tests
  # 单包类型
  tsc -b packages/experimental/component-surface/tsconfig.json packages/experimental/content-frame/tsconfig.json
  # 测试类型（含全部 client 测试；本工作树既有 788 条 remotes 错误，需比对位置而非 rc）
  tsc -b tsconfig.client.json
  # lint
  tsx scripts/run-oxlint.ts --config .oxlintrc.staged.json <改动文件>
  # 文档
  tsx scripts/verify-translation-pairing.ts packages/experimental/component-surface/README.md packages/experimental/content-frame/README.md .agents/notes/implemented/architecture/2026-10-09-content-channel-seam-and-duplication.md
  tsx scripts/verify-md-links.ts && tsx scripts/verify-md-wrap.ts && tsx scripts/verify-agent-note-format.ts
  # bundle（包目录内，勿用根 pnpm run build）
  (cd packages/experimental/component-surface && ../../../node_modules/.bin/tsdown)
  (cd packages/experimental/content-frame && ../../../node_modules/.bin/tsdown)
  ```

## 8. 环境备注

- 本 shell 里 `node`/`pnpm` 需要 `eval "$(/opt/homebrew/bin/fnm env)"`（fnm 管 Node 24.15.0，pnpm 11.7.0）；git 钩子在该环境下能正常跑完 lint/whitespace/translation-pairing/third-party notices，本轮 8 条提交都是钩子通过的正常提交（stage 1 当时因 PATH 无 node 用了 `LEFTHOOK=0`，本轮不需要）。
- 本轮所有重型命令都在 `/Volumes/outside-ssd/CODE/.claude-tmp/heavy-test.lock` 下跑，单次未超 9 分钟；两次遇到 `LOCK-WAIT-TIMEOUT`，按纪律换调用重试成功。
- `export TMPDIR=/Volumes/outside-ssd/CODE/.claude-tmp/cact2`；覆盖率报告与临时输出都落在这里，未污染工作树（`git status` 干净）。
