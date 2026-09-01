# 内容区快照引擎 — 交付报告

引擎已交付：纯浏览器代码，无 React、无 cordis、无网络；可见性与几何全部注入；工具与传输留给下一片。

## 改动的文件

新增（全部在 `packages/experimental/content-frame/` 下）：

- `src/client/access/refs.ts` — `RefTable`
- `src/client/access/model.ts` — 对外类型（`SnapshotOptions` / `SnapshotHeader` / `Snapshot`）与内部条目记录
- `src/client/access/dom.ts` — HTML/ARIA 常量与工具（角色、名字、可见性、文字、几何、帧文档）
- `src/client/access/collect.ts` — 一次文档序遍历，产出条目
- `src/client/access/render.ts` — 条目 → 文本：outline / map / find、预算、游标
- `src/client/access/snapshot.ts` — 对外入口 `snapshot(root, options)` 与 header 抽取
- `src/client/access/dom-accessibility-api.d.ts` — 依赖的类型声明补丁（见下）
- `tests/snapshot.client.spec.ts`、`tests/refs.client.spec.ts` — jsdom 用例
- `REPORT.md` — 本文件

已改：`package.json`（加 `dom-accessibility-api` 依赖）、根 `pnpm-lock.yaml`（3 行）。content-frame 既有源码一行未动，其他包一行未动。

## 需求书之外由我拍板的地方

### 1. 工作树基线不是 `product/server-console`（先看这条）

编排脚本把工作树建在了 `dd6322d604`（0.1.2-alpha.3 发版合并），那条线上根本没有 `packages/experimental/content-frame`。需求书写明分支从 `product/server-console` 当前提交建出，交付物路径也只在那条线上存在。工作树是干净的、分支上没有我之外的提交，所以我 `git reset --hard product/server-console`（`49a28c9f52`）之后才开工。如果这不是编排的本意，请重建工作树后重跑。

### 2. 依赖版本与类型声明补丁

`pnpm add dom-accessibility-api` 默认解析到 `^0.7.1`，会往 lockfile 里塞一个新版本。需求书说“lockfile 已有其版本”，所以我改成 `^0.5.16`（testing-library 已经在用的那个），lockfile 只多 3 行、装包全程离线。

0.5.16 的 `exports` 映射没有 `types` 条件，`moduleResolution: bundler` 找不到它自带的 `dist/index.d.ts`（实测 TS7016）。所以补了一个环境声明文件，只声明用到的 `getRole` / `computeAccessibleName`，形式照抄仓库已有的 `packages/fs/tool-fs-search/src/ripgrep.d.ts`。

### 3. `type=password` 的角色

`getRole` 对密码框返回 `null`（实测），照契约“无角色 + 不可点”就会被整个丢掉，`(hidden)` 和 signIn 都无从谈起。所以密码框固定按 `textbox` 输出，值固定 ` = (hidden)`，永不读 `.value`。

### 4. map 模式下的表格（与需求书字面有出入，重点看）

需求书说表格块“两种模式都这样”，但同一节又说 map“只输出容器行，每行后接计数”，而计数词表里有 `<r> rows` —— 只有表格能产出 `rows`。两句在 map 模式下互斥。

我的取舍：**outline 里表格是四行块（形状 + 表头 + 样本行 + 提示行 + 可选分页行），map 里表格是一行容器行 `e9 table "名字"  20 rows`**。理由：map 是“整页超预算时的骨架”，骨架要短；`rows` 计数因此也不是死代码。如果对面实现选了另一读法，这一处会不一致。

### 5. 文本段的合并边界

需求书只说“相邻纯文本节点合并为一段”。字面执行会把 `<p>共 <span>20</span> 个站点</p>` 拆成三段。我的规则：**文字跨“不产生条目的元素”继续累积，遇到条目行、容器边界、或离开一个非 inline 标签时断段**；inline 标签集是固定的 HTML 行内元素表。于是上例合成一段 `text "共 20 个站点"`，而 `<p>A</p><p>B</p>` 仍是两段。

### 6. 预算切断多了一种文案（重点看）

需求书假定“截断处最后一个输出条目”总有编号，但文本段按需求书的格式（`text "…"`）不带编号。一页纯文字被切断时就没有游标可给。

我的处理：切断永远在预算处发生（不会为了凑一个编号而无限超预算），两种收尾文案二选一：

- 有编号：`(cut after e42 — pass after: "e42" to continue; 17 items remain)`（需求书原文）
- 无编号：`(cut here; 17 items remain — narrow the read with find, or read a part with scope)`（我加的）

第二种是新增的模型可见文案，已逐字钉在测试里。

### 7. 骨架为空时退回被截断的 outline

整页超预算但页面一个容器都没有（纯文字页），骨架会是空字符串。空答案不如“被切断的前几行 + 收尾文案”有用，所以这种情况返回被截断的 outline。有容器时仍按需求书返回 map（`kind: 'map'`、`truncated: true`、无 cursor、末尾追加 `Read a part with scope, e.g. content_read({ scope: "e1" }).`）。

“最大容器”按后代条目数取最大，表格按数据行数参与比较。

### 8. `RefTable.reset()` 不复用编号

编号计数器跨 `reset()` 单调递增。理由：模型手里还攥着上一页的 `e5`，重置后若从 `e1` 重新发号，`resolve('e5')` 会指到一个毫不相干的新元素，模型会点错东西；单调发号则老编号一律解析为“不存在”。

### 9. 其余小决定（逐条）

- checkbox / radio / switch 不再输出 ` = "on"`：`[x]` / `[ ]` 已经说完了，只有承载文字的字段才报值。
- 名字为空时省略引号部分，条目行与容器行一视同仁（需求书只给容器行开了这个口子，按对称补齐）。
- 容器后缀：有名字 ` (in dialog "导入设置")`，无名字 ` (toolbar)`；只加在非容器行上（容器嵌套已经由缩进表达）。
- `section` / `dialog` 的名字：无障碍名为空时回退到内部第一个可见标题；未打开的 dialog 因为整棵子树不可见，回退时按“全部可见”计算，否则它永远没名字。
- `scope` 包含被指元素自身那一行；`scope` 指向表格时输出 `表格形状行 + header 行 + 逐行 row`（不再输出 sample 与提示行）。
- `total` = 本次列表（经 `after` 裁剪后）收集到的条目数，`shown` = 实际渲染的条目数；map 的 `total` 仍是 outline 口径的条目数，`shown` 是骨架行数。
- `after` 指向的元素还在、但不在本次列表里 → 从头输出（不报错）；元素已不在文档 → 抛需求书规定的错。
- 表格：`thead` / `tbody` 用 `:scope >` 限定，避免命中单元格里嵌套表格的表头；多个 `tbody` 的行都算数据行。
- 几何去重在“进入元素之前”判：容器/表格/条目重复时连同整棵子树一起丢，这正好干掉 element-ui 固定列克隆出来的整张表；表格内部另有一份单元格级去重。零面积矩形不去重。
- 分页条既作为表格的 `pagination:` 行出现，也照常作为正文条目出现（真实页面里它是一排可点按钮，压掉就没法翻页了）。
- header（breadcrumb / modal / signIn）跨同源帧读取，因为业务系统就住在 iframe 里；`url` / `title` 取根文档，`url` 用 `document.URL`（等价于 `location.href`，且对无浏览上下文的文档也成立）。
- 默认 `isClickable` 用全局 `getComputedStyle`（与 `computeAccessibleName` 的同源同 realm 假设一致），不做 `defaultView` 分支。
- 跨 realm 不用 `instanceof`（帧内元素的构造器不是本页的），一律按 `localName` 判定再取属性。
- `fields` 集合严格按需求书字面（含永不出现的 `textarea` / `select`），因此多选 `<select>`（角色 `listbox`）不计入 fields，只作为普通条目出现。
- 角色白名单改成黑名单：结构性角色（`row`/`cell`/`listitem`/`group`/`banner` 等，以及容器判定失败的 `list`/`region`/`form` 等）不出行，其余有角色的元素一律出行。这样 `tab` / `menuitem` / `treeitem` 这类真实导航控件不会被漏掉。
- 引擎没有接进包的 `exports` 或 README：需求书说工具与传输是另一片，包对外行为未变，README 现在的描述仍然准确。接线那一片应当同时更新 README。

## 已知缺口

- **element-ui 的表头/表体分表没处理**：`.el-table` 会渲染成两张 `<table>`（一张只有 `thead`、一张只有 `tbody`），两者矩形不重叠，去重不会合并它们，于是读出“0 行的表”和“没表头的表”各一张。需求书没规定合并规则，我没有自造启发式。这是接真实业务系统时最可能先炸的一处。
- 一个 `cursor: pointer` 的大卡片会被当成叶子，整棵子树不再展开。
- 未打开的 dialog 只能靠 `aria-label` 或内部标题命名。
- 关闭的 shadow root、跨源帧内容读不到（前者无解，后者按 `frame (not readable)` 报）。
- `find` 只匹配条目名字、文本段、表格行文字，不匹配字段当前值。
- map 的计数只统计直属条目，嵌套容器的内容不往上累加。
- 全部验证都在 jsdom 里：真实浏览器的 `checkVisibility()` / `getBoundingClientRect()` 行为、以及真实 element-ui 页面的读出效果，本片没有证据。

## 跑过的命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile --prefer-offline` | 通过（8.8s，全程离线） |
| `pnpm add dom-accessibility-api --filter @deepseek-ai/dsh-experimental-content-frame` | 通过，但解析到 `^0.7.1`；改钉 `^0.5.16` 后 `pnpm install --prefer-offline` 通过 |
| `pnpm exec vitest run packages/experimental/content-frame/tests` | 通过：12 个文件 / 124 个用例（新增 60 个） |
| `pnpm exec vitest run packages/experimental/content-frame/tests --coverage --coverage.include='packages/experimental/content-frame/src/client/access/**'` | 通过：新文件语句/分支/函数/行全部 100% |
| `pnpm exec tsc -b packages/experimental/content-frame/tsconfig.json` | **失败（exit 2），11 个错，全部不在 content-frame**：`packages/api/remotes`、`packages/client/runtime`、`packages/experimental/content-column` 找不到 `@deepseek-ai/dsh-*/remote`，那些模块由 Typert 生成器在 `build:lib:host` 阶段产出，干净工作树里还不存在 |
| `pnpm run typecheck`（= `build:lib:host` + `tsc -b tsconfig.client.json`） | 通过（exit 0，零错误）——这是仓库的权威类型检查 |
| `pnpm exec tsx scripts/run-oxlint.ts packages/experimental/content-frame` | 通过（exit 0，无告警；构建 `lib/` 之前之后各跑一次） |
| `pnpm run knip` | 失败（exit 1），6 条全部在 `apps/desktop`，与本次改动无关；新文件未被判为未用导出 |

未跑：`pnpm run test`（全仓）、`test:coverage`（全仓）、`doc-sync`、`hygiene`、快照与 e2e。理由：本片没有模型/用户可见的成品行为（引擎还没接上工具），CI 负责全量。

## 逐文件覆盖率（新文件）

| 文件 | 语句 | 分支 | 函数 | 行 |
| --- | --- | --- | --- | --- |
| `src/client/access/collect.ts` | 100% (157/157) | 100% (107/107) | 100% (33/33) | 100% (132/132) |
| `src/client/access/dom.ts` | 100% (74/74) | 100% (53/53) | 100% (22/22) | 100% (66/66) |
| `src/client/access/render.ts` | 100% (148/148) | 100% (126/126) | 100% (26/26) | 100% (121/121) |
| `src/client/access/snapshot.ts` | 100% (43/43) | 100% (28/28) | 100% (7/7) | 100% (34/34) |
| `src/client/access/refs.ts` | 100% (15/15) | 100% (6/6) | 100% (3/3) | 100% (14/14) |
| `src/client/access/model.ts` | 100% (0/0) | 100% (0/0) | 100% (0/0) | 100% (0/0) |
| `src/client/access/dom-accessibility-api.d.ts` | 100% (0/0) | 100% (0/0) | 100% (0/0) | 100% (0/0) |

取单包/单文件覆盖率的办法：`vitest.config.ts` 的 `coverage.include` 是 `packages/*/*/src/**/*.{ts,tsx}` 加 per-file 100% 阈值，命令行用 `--coverage.include=<glob>` 覆盖它即可只量新文件；`scripts/coverage-uncovered-locations.cjs` 是仓库自带的自定义 reporter，会把每一处未覆盖的语句/分支/函数打成 `path:line:col`，比阈值报错好用得多。

`render.ts` 里唯一的 `/* v8 ignore */` 是闭合联合的 `default` 分支，形式照抄 `packages/experimental/agent-team/src/fold.ts`。

## 提交

在工作树分支上提交一次，lefthook 的 pre-commit 全程跑（未用 `--no-verify`），未 push。`THIRD_PARTY_NOTICES.md` 由 pre-commit 的生成器随新依赖自动重算并入库，这是钩子的既定行为，不是我手改的。
