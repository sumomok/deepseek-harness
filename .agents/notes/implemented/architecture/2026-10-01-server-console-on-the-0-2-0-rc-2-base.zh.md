# Agent Note: The product-console line on the 0.2.0-rc.2 base — compiler faces, rebased persistence records, the Session-log switch

Status: implemented

[English](2026-10-01-server-console-on-the-0-2-0-rc-2-base.md) | 中文

## Problem

把控制台这条线搬到 0.2.0-rc.2 基座时遇到四处情况。浏览器侧 `ClientRemote` 的增补只存在于 Host 那遍 tsdown 生成的 `lib/typert.remote-client.d.ts` 里，而 `pnpm run typecheck` 先跑 Host `tsc -b`、后跑那一遍；`tsconfig.host.json` → `skill-pack-components` → `component-surface`（单一 Client 配置）→ `ui-chat` 这条链够到读取生成的 `ctx.remote` 命名空间的 Client 代码，所以干净树上每处读取都报 `TS2339: Property '<namespace>' does not exist on type 'ClientRemote'`，例如 `ui-chat/src/client/apply.ts` 里的 `ctx.remote.session`。上游的持久化记录 `2026-09-21-user-question-reply` 从 `2026-09-16-session-format-v4` 出发改动 `agent/inbox/spliced`、`developer/message`、`session/title-llm-request` 与 `user/message`，本线的 `2026-09-26-console-content-events` 从同一份记录出发改动同样四个根；`verify-persistence-changes` 以 `forked persistence history for event:agent/inbox/spliced: 2026-09-21-user-question-reply and 2026-09-26-console-content-events` 拒绝合并后的树。Web bundle 新增 `ui-settings-session-log`，即「设置 → 通用」里的一个开关，通过编辑 volatile 的 `session-log-deepseek.enabled` 把 Session 日志上传到官方模型 API。台账记录 `client-library-config-export` 从 `packages/client/tsdown.client.ts` 导出 `clientLibraryConfig`，服务于 `server-sidebar` 的第二个 Node 入口 `lib/types/invariant.js`，而本包并不构建这个入口。

## Decision

**`component-surface` 有 Host 与 Client 两个编译面。** `component-surface` 有一个 `tsconfig.host.json`（`src/client/` 以外的源文件，只引 Host 工程）、一个 `tsconfig.client.json`（整份 `src` 与 Client 引用）和一个只做引用的根 `tsconfig.json`，与上游 `inspector` 的布局相同。Host 聚合够到的工程都不编译 Client 代码，所以 Host `tsc -b` 永远不会读到只有之后那遍 tsdown 才声明的 `ClientRemote` 命名空间。`skill-pack-components` 继承 Host 基础配置并引用 Host 叶子；`tsconfig.host.json` 引用 Host 叶子，Typert 的 Host 面因此登记 `ctx.componentCatalog` 与 `ctx.componentViews`；`tsconfig.client.json`、`tsconfig.vue2-tests.json` 与 `component-kit` 引用 Client 叶子。

**本线的持久化记录在产品发行把它们定稿之前都不算已接受，每轮基座同步把它们改接到上游历史之后。** 这是本线的规则。历史校验拒绝一个根上同一前驱的两个后继，新增记录改不了已有记录的 `previous`，本线也不改上游随发布带来的记录，所以两份原始记录不能同时保留：改的是本线的记录。按[记录规则](../../../../docs/persistence-changes/README.zh.md)，两份记录都不算已接受：V4 检查点 `docs/persistence-changes/finalized/v4.json` 锁定到 `2026-09-16-session-format-v4` 为止的记录，两份都不在其中，本线也没有自己的定稿检查点。在本基座上，以 `persistence-changes --update` 重算的 `2026-09-26-console-content-events` 把 `2026-09-21-user-question-reply` 写成四个根的前驱，并按当前树确认本线在 Host 侧声明的两种来源种类（`content-surface`、`content-component`）与六个内容事件；`content-frame` 的 `MessageSourceMap` 条目声明在提取器所读的 Host 聚合之外的一个 Client 包里。重算命令拒绝带后继的记录，所以本线在这些根上只保留一份记录，而不是一份前驱加一份后继。

**Session 日志上传开关被禁用，设置值被钉在关闭。** 控制台 bundle 层把 `ui-settings-session-log` 与其他官方品牌界面一起禁用。锁 overlay `permission-lock.patch.yml` 以 `enabled: false` 重述 `session-log-deepseek` 行，理由与它携带 `permission` 和 `agent-preset-registry` 相同：这个开关写的是部署共用的 profile 补丁，放在锁之下时，任何被放行的浏览器经 `remote.settings` 写一次，就会让主机服务的每个会话都开始上传。放在 profile 补丁之上时，config-editor 拒绝这次写入。

**`clientLibraryConfig` 保持模块私有。** `server-sidebar/tsdown.config.ts` 用 `clientBundle` 构建它唯一的 Node 入口 `lib/types/index.js`，`git grep clientLibraryConfig -- packages apps scripts` 只命中 `packages/client/tsdown.client.ts` 里的定义与两处调用。该文件是 `dsh-v0.2.0-rc.2` 的文本，台账记录 `client-library-config-export` 已退役。

## Alternatives considered

**`component-surface` 只留一个 Client 配置，放在 Host 聚合之外。** Host `tsc -b` 就不会够到 Client 代码，但 Typert 的 Host 面不会登记这个包，`gen-cordis-catalog` 会报 `ctx.componentCatalog` 与 `ctx.componentViews` 失踪。

**在 Host `tsc -b` 之前生成 `ClientRemote` 增补。** 这要改上游 `typecheck` 脚本的顺序，是拆分编译面用不着的核心补丁。

**两份原始持久化记录都保留。** 校验拒绝这个分叉，而在上游一侧解决它就要改上游随 `dsh-v0.2.0-rc.2` 发布的记录，以后每轮同步都会与之冲突。

**新增一份后继记录，而不是重算本线记录。** 后继改不了前驱的 `previous`，`2026-09-16-session-format-v4` 仍会有两个后继。

**把 `origin/product/server-console` 上的每份记录都当作已接受。** 已接受的记录不能重算，于是下一份与本线记录从同一前驱出发改动同一个根的上游记录会留下一个分叉，只有改上游记录才能解决。

**开关留在页面上，只靠主机行的 `enabled: false`。** base bundle 的 `enabled: false` 位于 profile 补丁之下；开关保存一次，值就落进那份补丁并压过它。

**只禁用开关，不加锁行。** 页面上没有控件了，但 `remote.settings` 仍然接受任何被放行的浏览器发来的写入。

**保留 `clientLibraryConfig` 的导出。** 它没有消费方，一条没有消费方的在役台账记录只是让一条核心路径白白与基座不同。

## Consequences

`pnpm run typecheck` 通过，`component-surface` 符合 `docs/development.md` 的 Host／Client 编译面规则。这条持久化规则让上游的记录历史保持原样，每轮同步并入上游记录时不需要核心补丁；代价是本线的机器声明与 schema 快照在同步时改变，本线的一份记录描述的是相对当前基座的变迁，而不是它最初写下时的那个基座。Session 日志不受影响：这些记录是仓库门禁的输入，没有任何 Session 写入方或读取方查阅它们。产品发行为本线记录加上定稿检查点时，这条规则对那些记录结束，此后它们按已接受记录的规则处理。控制台不提供 Session 日志上传控件，要上传的部署改锁 overlay。`packages/client/tsdown.client.ts` 与基座相同，上游对它的改动合并时没有冲突。
