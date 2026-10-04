# Agent Note: The product-console line on the 0.2.1-alpha.1 base — invariant companions removed, Schedule off, the inspector bundle's path through plugin management

Status: implemented

[English](2026-10-04-server-console-on-the-0-2-1-alpha-1-base.md) | 中文

## Problem

把 0.2.1-alpha.1 基座合并进控制台这条线时遇到四处情况。上游删除了 `@deepseek-ai/dsh-invariants` 与全部 `./invariant` 子路径（[升级指南](../../../../docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.zh.md)）；`component-surface`、`content-frame`、`content-surface` 各自发布一个导入它的伴生插件，这三个包与 `auth-gate` 都把它列为依赖，所以 `pnpm install` 以 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 拒绝合并后的树，`tsc` 以 `TS2307` 拒绝每个伴生插件。Web 组合自己挂载定时：Host 行 `schedule` 与 `ui-schedule`，以及出厂 `standard`、`ptc`、`cordis` 预设里的 `time-context` 与四个 `schedule_*` 工具（[升级指南](../../../../docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.zh.md)）。出厂 `web-runtime` 行新增 `publicUrl`，即它对外宣告的应用根地址；控制台的 `web-runtime` 行照抄那一行的整份 config，漏掉了它。安装包新提供一个可选组合包 `@deepseek-ai/dsh-experimental-inspector-profile`，界面上显示为「开发者工具」，与「设置 → 通用」里显示代码工作视图的 `developer-tools` 那一行不是一回事；它挂载实验性 Inspector，开启未脱敏的 Host fetch 采集，并提供一个 DevTools 前端，其 CDP 目标在 Host 里执行代码；扣下它的机制由桌面线在设计，所以本轮只记录控制台访客今天能拿它做什么。

## Decision

**控制台的包不发布 invariant 伴生插件。** 按上游的迁移步骤，`component-surface`、`content-frame`、`content-surface` 删掉 `src/invariant.ts`、`./invariant` 导出及其 `files` 条目、tsdown 入口、`tsconfig.base.json` 别名与伴生插件的测试，四份 manifest 删掉 `@deepseek-ai/dsh-invariants`。`component-surface` 只构建一个 Node 入口，工具与伴生插件共用的带哈希 chunk `lib/projection-*.js`、`lib/validate-*.js` 因此从它的 `files` 列表和 `scripts/check-workspace-constraints.ts` 的 `packageFileExtras` 里消失。各包 README 删掉「不发布伴生入口」的说明，与上游删掉要求这句说明的规则时对自家 README 的处理一致。

**控制台关闭定时。** bundle 层按 id 禁用 `schedule` 与 `ui-schedule`。所有已登录的访客共用控制台的同一个 Host：`schedule.catalog` 返回每个会话的任务，四个 `schedule_*` 工具新建、修改、删除任务时都没有审批这一步。两个控制台预设都不声明 `tool-schedule` 或 `time-context`，声明它们的三个出厂预设都是禁用行。`packages/experimental/console-profile/tests/profile.spec.ts` 钉住这两行在出厂 Web bundle 仍然组合它们的情况下被禁用，并钉住只有那三个被禁用的预设声明这两个包之一；`apps/web/tests/server-sidebar.e2e.ts` 经脚手架的启动审计启动这份组合。

**`web-runtime` 照抄 `publicUrl`。** 控制台的这一行在其余照抄字段之外带上 `publicUrl: !!js ctx.webStartup.publicUrl`，所以部署在剥前缀反向代理之后时，宣告的是启动器拿到的根地址，而不是回环 URL。

**持久化链跟着补丁线走。** 上游在 0.2.0-rc.2 与 0.2.1-alpha.1 之间没有新增记录，但补丁线的 `rail-references` 新增了 `2026-09-25-prompt-references`，它与 `2026-09-26-console-content-events` 认领同样四个共有根，也把 `2026-09-21-user-question-reply` 记为它们的前驱。第二轮合并用 `persistence-changes --update` 重写了控制台记录，四个共有根改记 `2026-09-25-prompt-references` 为前驱，这正是 [0.2.0-rc.2 基座 Note](2026-10-01-server-console-on-the-0-2-0-rc-2-base.zh.md) 的改接规则给它的位置；六个内容根仍是本记录新增的根。合并后的树上 `verify-persistence-changes` 与 `verify-persistence-formats` 都退出 0。

## The inspector bundle in the console

控制台按上游的出厂方式组合 `@deepseek-ai/dsh-experimental-inspector-profile`：提供，但关着。控制台没有任何界面能打开开启它的那个页面：`ui-sidebar`、`ui-plugin-manager` 与「设置 → 插件」都被禁用，`server-sidebar` 也从不选中 `plugins` 面板。页面不在，并不能扣下它背后的 Host 方法。只要加载了 profile，base bundle 就挂载 `plugin-manager` 与 `hmr`（`packages/bundle/base/cordis.patch.yml`），而控制台 bundle 把 `plugin-manager` 与其他 Host 管理行一起禁用，见[Host 管理 Note](2026-10-04-console-drops-host-administration-surfaces.zh.md)的记录。组合着这一行时，`dsh-client-connection` 把每个通过 Host 与 Origin 围栏、带着浏览器会话 cookie 的 `/api` 请求都当作唯一的操作者 Peer 放行，不按方法区分（`packages/client/connection/src/rpc-host.ts`）。这时已登录的访客可以从页面自己的源调用 `pluginManager.setBundleEnabled('@deepseek-ai/dsh-experimental-inspector-profile', true)`：安装包提供这个组合包（`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES`），挂着 `hmr` 时改动立即生效。随后 Inspector 在主 webserver 上、以同一套登录提供它的 DevTools 前端与 `/inspector/devtools/cdp` 升级（`packages/experimental/inspector/src/host/plugin.ts`），经部署反向代理的请求因此能到达 CDP 目标与未脱敏的 fetch 采集。被放行的访客同样可以调用 `pluginManager.installBundle` 与 `pluginManager.setPluginEnabled`。`server-base` 的 `ownsHost` 让 `ctx.connection.isLoopback` 对每个被放进来的访客都为真，所以这些调用之前没有任何浏览器侧的检查。

## The second merge of this base

2026-10-04 本线合并了补丁线给这个基座追加的提交；上游在 `dsh-v0.2.1-alpha.1` 之后没有新提交。其中有 `settings-navigation-groups`，它把「数据与存储」设置分区（`data-location`）归入「通用」组。`server-sidebar` 在 `packages/experimental/server-sidebar/src/client/settings-entries.ts` 里按 slot 与 id 扣下设置条目（`settings.general.item` 里的 `busy-compaction` 与 `auto-compact`，`settings.action` 里的 `open-document`），而所属包把条目挪到别的 slot 或 id 后，就没有任何东西再遮住它。这次挪动只改了 `packages/client/ui-settings-general/src/client/nav-groups.ts` 里「通用」组的分区列表：被扣下的 slot 与 id 都没变，控制台组合的包也没有注册 `data-location`，所以控制台的「通用」组不变。补丁线之后再给这个基座追加的提交按同样方式合并、同样重核。

## Alternatives considered

**在本线自有的注册表副本上保留伴生插件。** 那要携带一个上游已删除的包和一条任何基座都没有的核心路径，换来的是没有任何门禁在跑的检查。

**只禁用 `ui-schedule`。** 「自动化任务」页面会消失，但 Host 的 `schedule.*` Remote 方法仍会回答每个被放进来的浏览器。

**保留 Host 行，依靠预设。** 两个控制台预设都不声明这些工具，但 `schedule` 仍会保有任务存储，以及列出每个会话任务的 Remote 方法。

**本轮就用一条控制台禁用行扣下这个 inspector 组合包。** 在这里禁用 `plugin-manager` 或这个组合包，等于在桌面线的机制出现之前先给出答案，而第二个只属于控制台的答案之后还得与它调和。[Host 管理 Note](2026-10-04-console-drops-host-administration-surfaces.zh.md)取代了这一选择：控制台 bundle 禁用 `plugin-manager`。

**照抄 `web-runtime` 时不带 `publicUrl`。** 这一行会让该字段保持未设置，反向代理之后的控制台就会宣告回环 URL。

## Consequences

这三个控制台包记录下的事件，只由各包写入时自己做的校验把关；没有伴生插件的测试，它们自己的测试套件仍让每个源文件保持 100% 覆盖。控制台对话没有提醒，也没有时钟读数。想恢复定时的部署要在自己的层里重新启用 `schedule` 与 `ui-schedule` 两行，并把两个控制台预设 `preset-console` 与 `preset-standard-as-console` 加上 `tool-schedule` 与 `time-context` 后整份重述：patch 替换一行的整份 config，而 `standard` 孪生预设声明的插件与 `console` 完全相同。控制台侧栏仍然没有「自动化任务」入口，因为 `ui-schedule` 把这个入口注册进 `sidebar.panellist`，而声明这个 slot 的只有被禁用的 `ui-sidebar`。这样的部署还要接受同一个 Host 的任务列表就是每个访客的任务列表。组合着 `plugin-manager` 时，部署登录放进来的任何访客都能开启这个 inspector 组合包，进而在 Host 里执行代码，`installBundle` 与 `setPluginEnabled` 也让同一批访客能改动 Host 运行哪些插件；控制台 bundle 禁用了这一行，见[Host 管理 Note](2026-10-04-console-drops-host-administration-surfaces.zh.md)的记录。Web 金样随基座变动：tool-fs 的 `edit` 与 `write` 描述现在要求先给 `file_path`，由出厂 `standard` 预设而不是控制台 bundle 组合的场景多记一次时钟读数，并列出 `schedule_*` 工具。
