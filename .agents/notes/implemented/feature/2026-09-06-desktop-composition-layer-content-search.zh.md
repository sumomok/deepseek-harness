# Agent Note: 桌面组合层，以及由它打开的会话全文搜索

Status: implemented

[English](2026-09-06-desktop-composition-layer-content-search.md) | 中文

## Problem

桌面应用的侧栏搜索只匹配会话标题与工作区名。它背后的 Host 路由（`session.search` → `SessionListState.search` → `ctx.sessionQuery.searchSessions`）已挂载、可达，但 `dsh-base` 与 `dsh-web-app` 都把 `session-query-sqlite` 配成 `openAt: never`，于是每一次搜索调用在触及请求之前就以 `SESSION_QUERY_SEARCH_DISABLED` 失败。浏览器那一半随即在每次查询上显示 `search.unavailable`——「内容搜索暂不可用，仅显示名称匹配。」两处组合包行的注释都写明正文搜索是 opt-in，启用它的部署应在更靠后的 patch 层覆盖 `openAt`，而 `apps/cli/tests/lazy-search-startup.compat.spec.ts` 把两处都钉死在 `never`，所以该改的不是这个取值。

桌面没有地方放这条覆盖。它的组合是 `dsh-base` + `dsh-web-app` + 十一个 vendor 来的插件 bundle——每一个要么是上游源码，要么是仓外 tarball——外加 `$DSH_HOME/profiles/desktop/cordis.patch.yml`，而那是壳只写一次、此后不再回头看的用户数据。一个交付浏览器表层、并要替它做部署选择的产品，没有一层属于自己的地方来做这些选择。

## Decision

`apps/desktop-app`（`@deepseek-ai/dsh-desktop-app`）就是这一层：一个只有 patch 的 bundle 包——一份 `cordis.patch.yml` 与指向它的 `dsh.bundle.patch` 清单字段，没有代码、没有 `main`、没有任何要 Loader 去导入的东西，因为 `loadProfile` 读 bundle 层时并不导入该包。`apps/desktop-server` 把它列为依赖，于是它进入 `pnpm deploy` materialize 成 Electron 应用 `resources/server` 的那棵树；`apps/desktop/src/profile-seed.ts` 里的 `BUILTIN_WEB_BUNDLES` 点了它的名，这正是把它放进桌面 profile 的 `dsh.profile.bundles`、并链接进扁平模块兜底目录的那一步。

它在那份名单里排**最后**。已存在的 profile 对缺失的名字采取追加，所以末位是全新 profile 与升级而来的 profile 都会给它的唯一位置——而这个位置本身也重要：该层于是盖过 `dsh-base`、`dsh-web-app` 与每一个内置插件层，包括[内置的出厂默认模型](2026-08-23-desktop-builtin-default-model.zh.md)，而后者的条目本层一个也不碰。

在那里排最后，只是播种那一刻的最后，不是永远的最后。同一次 `seedBuiltinBundles` 运行里，`syncWebBundles` 从 `web` profile 迁移过来的每一个名字都被追加到 `dsh.profile.bundles` 末尾，而插件管理服务重新启用一个插件时调用的 `addBundleName` 也追加在那里，所以本次构建之后才接纳的插件排在本层之后。每一个 bundle 层之上还坐着三个用户层，依次是：`$DSH_HOME/profiles/desktop/cordis.patch.yml`、home 级的 `$DSH_HOME/cordis.patch.yml`，以及任何 `--patch` overlay（`apps/cli/src/profile-boot.ts` 里的 `allPatches`）。所以这里的一行是用户可以替换的部署默认值，而不是无法摆脱的设定。

它携带的唯一一行把 `session-query-sqlite` 重述为 `openAt: first-search` 与 `path: dshHomePath('session-search/desktop.db')`。`first-search` 把 `node:sqlite` 的导入与索引的打开挡在启动之外，于是一次从不搜索的运行不付任何代价，Node 的 SQLite 实验特性警告也不会进入启动输出。路径取持久文件而非出厂的 `:memory:`，是因为这份索引是派生的而非权威的：留着它，意味着此后某次运行的首次搜索只对账新增与变更的日志，而不是重建整个语料库——这正是「只付一次构建」与「每次启动都付一次」的差别。它刻意落在 `dshHomePath('sessions')` 之外——派生索引与会话持久化存储是两个存储，后端也拒绝把权威数据库当作自己的来打开。

`apps/desktop/tests/desktop-composition-layer.spec.ts` 通过 `composeEntries` 组合 profile 的整个层栈——`dsh-base`、`dsh-web-app` 与十二个 bundle 层，每个内置层都按启动时的方式经 `resolveBundleDir` 解析——断言桌面 profile 最终得到的那一行、断言同一层栈去掉本层后仍组合出 `never`、并断言组合里没有别的东西被动过。此后某个内置插件开始 patch 同一行，就是一条挂掉的用例，而不是现场的意外。

## 第二行：等完一个限流窗口

本层存在的理由是部署选择需要一个落脚处，而内容搜索只是其中第一项。第二项是 `llm-deepseek` 的 `retryPolicy.backoff.maxDelayMs`，从出厂的十秒抬到五分钟。

等完限流再续跑这件事本身已经建好、也已经默认开着：`@deepseek-ai/dsh-llm-retry` 挂在 `dsh-base` 里，读取 DeepSeek 适配器从 429 上解析进 `LlmFailure.providerRetryAfterMs` 的 `Retry-After`，把 `llm/retry` 与 `llm/retry-started` 写成持久会话事件，浏览器侧还为它们渲染实时倒计时。出厂组合唯一不做的，是接受一段超过十秒的等待：`normal` 策略在 `providerRetryAfterMs` 超出 `maxDelayMs` 时会转交给下一个处理者，于是整回合带着限流错误失败。DeepSeek 的窗口常见是 30 到 120 秒，所以这套机制唯一为之存在的场景，恰恰被它拒绝了。

抬高上限只改变哪些供应商时长会被采信。本地指数退避是 `min(500 * 2 ** (retry - 1), maxDelayMs)` 叠上十分之一的抖动、最多五次重试，两种取值下最长都是 8.8 秒，上限根本约束不到它；把两份策略都过一遍 `resolveRetryPolicy`，得到的两个对象只在 `maxDelayMs` 上不同，`maxRetries`、`retryableCodes`、`initialDelayMs`、`jitterRatio` 全部保持默认。

**这个上限属于供应商那一行，不属于重试插件。**`llm-retry` 的 `Config` 是 `Readonly<Record<string, never>>`，它的 `validateConfig` 对任何键都抛错，遇到 `retryPolicy` 时答的是 `retryPolicy belongs under each provider configuration`。策略是适配器注册路由时捕获的、按路由持有的状态，所以配置它的地方就是 `llm-deepseek`。`llm-pi-ai` 不是第二个可设之处：它的 `retryPolicy` 是用户设置文档里每个 provider profile 的字段，不是插件配置键，而且它的错误分类是对被压平的 SDK 消息做正则，根本还原不出 `Retry-After`，这个值在那里无事可做。

**这一行重述了模型目录。**`@haoran/dsh-default-model` 是本层下方的一个内置插件层，它对同一个 `llm-deepseek` id 做了一次整表替换式的 `models` patch，其中带着桌面新会话所用的视觉模型那一行。patch 是把 `config` 整个赋过去的，所以这里若只写 `retryPolicy`，就会把那份目录连同模型选择器一起删掉。测试把两份目录逐项比对，于是那个包里的目录一旦变动，就是这里的一条挂掉的用例，而不是现场少了个模型。

浏览器侧画的倒计时是裸秒——`Math.max(1, Math.ceil(ms / 1000))` 填进 `{label}（{retry}/{maximum}） · {seconds}s`——所以五分钟的等待从 `300s` 起倒数，展开行里则以毫秒陈述该时长。看得懂，但这个量级上分秒格式会更好读；此处所取的值并不依赖于那件事。

## 首次搜索的代价

首次查询之前跑的那次对账会列出每一份持久化快照，读取每一份尚未索引的日志，抽取搜索文档，然后一次提交。在用于测量的这份语料上——128 份会话日志、12.2 MiB zstd 压缩后的 JSONL、解压后 30.9 MB——那就是对 30.9 MB JSON 的一遍扫描。同一次运行里之后的每次搜索都不再读已索引过的内容，此后每次运行也只读发生过变化的部分。

## 每一份会话日志都会被读，所以一份读不了的日志会让每次搜索都失败

`SessionEventMap` 成员默认是「读时必需」：一份日志若带有当前组合不认识、又没有标记 `ignorable: true` 的事件类型，读取方会以 `SessionFormatUnsupportedError` 拒绝整份日志。在 `openAt: never` 下从不发生批量读取，这样的日志一直休眠。开启正文搜索后，对账会把它们全读一遍，而一次拒绝就中止整次观察，使搜索以 `SESSION_QUERY_PERSISTENCE_FAILED` 失败——不只是那一个会话，而是这次查询。

这不是假设：上面那份语料里已经有三份日志带着 `permissionRules/decision`，而本仓库与桌面载荷里没有任何包声明过这个事件类型。这种失败退化成的正是今天的行为——浏览器那一半接住它并显示 `search.unavailable`，标题与工作区匹配照常列出——所以下限就是用户现在已有的，而不是一个坏掉的侧栏。它确实抬高了「第三方插件写入非 ignorable 会话事件」的代价：在这次改动之前，这样的插件只是让卸载后的会话回放坏掉，现在它还会在其日志留在语料库期间关掉正文搜索。

## Alternatives considered

**改 `dsh-base` 或 `dsh-web-app` 里的 `openAt` 取值。**两者都是与每个 `dsh web` 部署共用的上游包源码，两者的注释都写明该取值是有意为之、由部署方在更靠后的层覆盖，而 `apps/cli/tests/lazy-search-startup.compat.spec.ts` 把两处都钉住。改动任一处，都会让一个桌面决策顺带为 CLI 的 `web` profile 打开正文搜索。

**由 `profile-seed.ts` 把该行写进桌面 profile 的 `cordis.patch.yml`。**改动量最小，也是错的：那个文件是用户数据，只在缺失时写入，而 `apps/desktop/README.md` 写明壳从不向它做合并。凡是已经有桌面 profile 的安装——也就是每一次升级——都永远看不到这一行。

**随载荷发一份 `--patch` overlay 文件，并在拉起服务端时传入。**同样小，也确实能覆盖已有安装，但 overlay 是 `composeProfile` 应用的最后一层：它排在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 之上，于是这样送达的部署默认值，用户在文档指引他们去编辑的那个文件里根本关不掉。

**把这个包放到 `packages/bundle/` 与其他 bundle 并列。**按分组语义那才是 bundle 该待的地方，而那是上游的地盘：`packages/bundle/README.md`、`docs/module-graph.md` 及其中文对照件都逐个枚举那里的包，于是一个只属于 fork 的 bundle 会改到四份生成物或上游文档，并在每次同步时冲突。`apps/` 里本来就放着 fork 自己的产品装配件——`apps/desktop`、`apps/desktop-server`——而且没有任何文档目录去枚举它。

**把这一层加进某个 vendor 来的内置插件里。**这是 fork 现有的、添加桌面专属组合行的做法，但对这一行来说是错的归属：这行属于部署，而不属于某个插件，而且它随后会住在本仓库之外的工作区里，只能通过重新打包的 tarball 抵达。

## Consequences

桌面侧栏搜索返回带摘要片段的排序正文匹配，上限 20 条，覆盖 `current` 表面上的 `user/message` 与 `assistant/message` 事件。查询仍是字面短语，走 `unicode61` 分词器：FTS5 语法被当作数据，词边界就是词边界，所以 `AI` 依然匹配不到 `BRAID`。

应用在 harness home 下多出一族文件，`~/.dsh/session-search/desktop.db` 及其 WAL 附属文件，体量量级取决于抽取出的消息文本而非原始日志。没有任何东西会删除它；删掉它的代价是重建一次。启动不受影响——在有搜索来问之前什么都不打开——而每次运行的首次搜索只付自上次以来变化的那部分。

`BUILTIN_WEB_BUNDLES` 现在有十二个名字，其中十一个是插件，所以 `apps/desktop/README.md` 及其中文对照件在原先数「十一个」的地方区分了这两类；打包闸的 `seeded.length === BUILTIN_WEB_BUNDLES.length` 检查也把新名字与其余一并覆盖。
