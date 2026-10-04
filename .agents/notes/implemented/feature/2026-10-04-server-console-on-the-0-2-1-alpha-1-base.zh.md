# Agent Note: The product-console line on the 0.2.1-alpha.1 base — invariant companions removed, Schedule off, Developer Tools within a visitor's reach

Status: implemented

[English](2026-10-04-server-console-on-the-0-2-1-alpha-1-base.md) | 中文

## Problem

把 0.2.1-alpha.1 基座合并进控制台这条线时遇到四处情况。上游删除了 `@deepseek-ai/dsh-invariants` 与全部 `./invariant` 子路径（[升级指南](../../../../docs/upgrade-guide/v0.2.0-rc.2/remove-runtime-invariants/guide.zh.md)）；`component-surface`、`content-frame`、`content-surface` 各自发布一个导入它的伴生插件，这三个包与 `auth-gate` 都把它列为依赖，所以 `pnpm install` 以 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 拒绝合并后的树，`tsc` 以 `TS2307` 拒绝每个伴生插件。Web 组合自己挂载定时：Host 行 `schedule` 与 `ui-schedule`，以及出厂 `standard`、`ptc`、`cordis` 预设里的 `time-context` 与四个 `schedule_*` 工具（[升级指南](../../../../docs/upgrade-guide/v0.2.0-rc.2/schedule-bundle-retired/guide.zh.md)）。出厂 `web-runtime` 行新增 `publicUrl`，即它对外宣告的应用根地址；控制台的 `web-runtime` 行照抄那一行的整份 config，漏掉了它。安装包新提供一个可选组合包 `@deepseek-ai/dsh-experimental-inspector-profile`（开发者工具），它挂载实验性 Inspector，开启未脱敏的 Host fetch 采集，并提供一个 DevTools 前端，其 CDP 目标在 Host 里执行代码；扣下它的机制由桌面线在设计，所以本轮只记录控制台访客今天能拿它做什么。

## Decision

**控制台的包不发布 invariant 伴生插件。** 按上游的迁移步骤，`component-surface`、`content-frame`、`content-surface` 删掉 `src/invariant.ts`、`./invariant` 导出及其 `files` 条目、tsdown 入口、`tsconfig.base.json` 别名与伴生插件的测试，四份 manifest 删掉 `@deepseek-ai/dsh-invariants`。`component-surface` 只构建一个 Node 入口，工具与伴生插件共用的带哈希 chunk `lib/projection-*.js`、`lib/validate-*.js` 因此从它的 `files` 列表和 `scripts/check-workspace-constraints.ts` 的 `packageFileExtras` 里消失。各包 README 删掉「不发布伴生入口」的说明，与上游删掉要求这句说明的规则时对自家 README 的处理一致。

**控制台关闭定时。** bundle 层按 id 禁用 `schedule` 与 `ui-schedule`。所有已登录的访客共用控制台的同一个 Host：`schedule.catalog` 返回每个会话的任务，四个 `schedule_*` 工具新建、修改、删除任务时都没有审批这一步。两个控制台预设都不声明 `tool-schedule` 或 `time-context`，声明它们的三个出厂预设都是禁用行。`packages/experimental/console-profile/tests/profile.spec.ts` 钉住这两行在出厂 Web bundle 仍然组合它们的情况下被禁用，并钉住只有那三个被禁用的预设声明这两个包之一；`apps/web/tests/server-sidebar.e2e.ts` 经脚手架的启动审计启动这份组合。

**`web-runtime` 照抄 `publicUrl`。** 控制台的这一行在其余照抄字段之外带上 `publicUrl: !!js ctx.webStartup.publicUrl`，所以部署在剥前缀反向代理之后时，宣告的是启动器拿到的根地址，而不是回环 URL。

**持久化链不变。** 合并后的树上 `verify-persistence-changes` 退出 0。上游在 0.2.0-rc.2 与 0.2.1-alpha.1 之间没有新增记录，所以 `2026-09-26-console-content-events` 仍把 `2026-09-21-user-question-reply` 记为四个共有根的前驱，这正是 [0.2.0-rc.2 基座 Note](../architecture/2026-10-01-server-console-on-the-0-2-0-rc-2-base.zh.md) 的改接规则给它的位置。

## Developer Tools in the console

控制台按上游的出厂方式组合开发者工具：提供，但关着。控制台没有任何界面能打开开启它的那个页面。`ui-sidebar` 被禁用，所以 `ui-plugin-manager` 的 `sidebar.panellist` 入口永远落不了地；`server-sidebar` 从不选中 `plugins` 面板；「设置 → 插件」被禁用。Host 侧却够得着。只要加载了 profile，base bundle 就挂载 `plugin-manager` 与 `hmr`（`packages/bundle/base/cordis.patch.yml`），控制台对这两行都没有处理。`dsh-client-connection` 把每个通过 Host 与 Origin 围栏、带着浏览器会话 cookie 的 `/api` 请求都当作唯一的操作者 Peer 放行，不按方法区分（`packages/client/connection/src/rpc-host.ts`）。于是已登录的访客可以从页面自己的源调用 `pluginManager.setBundleEnabled('@deepseek-ai/dsh-experimental-inspector-profile', true)`：安装包提供这个组合包（`packages/boot/app-boot/src/profile.ts` 的 `OPTIONAL_BUNDLES`），挂着 `hmr` 时改动立即生效。随后 Inspector 在主 webserver 上、以同一套登录提供它的 DevTools 前端与 `/inspector/devtools/cdp` 升级（`packages/experimental/inspector/src/host/plugin.ts`），CDP 目标与未脱敏的 fetch 采集因此经部署的反向代理就能够到。`pluginManager.installBundle` 与 `pluginManager.setPluginEnabled` 在同一个面上。`server-base` 的 `ownsHost` 让 `ctx.connection.isLoopback` 对每个被放进来的访客都为真，所以这些前面也没有任何浏览器侧的检查。

## The second merge of this base

补丁线在 2026-10-10 之后还会给这个基座追加提交，本线在第二轮合并它们。其中有 `settings-navigation-groups`，它挪动「数据与存储」设置分区。`server-sidebar` 在 `packages/experimental/server-sidebar/src/client/settings-entries.ts` 里按 slot 与 id 扣下设置条目（`settings.general.item` 里的 `busy-compaction` 与 `auto-compact`，`settings.action` 里的 `open-document`），而所属包把条目挪到别的 slot 或 id 后，就没有任何东西再遮住它，所以那一轮要对照挪动后的分区逐条重核被扣下的行。

## Alternatives considered

**在本线自有的注册表副本上保留伴生插件。** 那要携带一个上游已删除的包和一条任何基座都没有的核心路径，换来的是没有任何门禁在跑的检查。

**只禁用 `ui-schedule`。** 「自动化任务」页面会消失，但 Host 的 `schedule.*` Remote 方法仍会回答每个被放进来的浏览器。

**保留 Host 行，依靠预设。** 两个控制台预设都不声明这些工具，但 `schedule` 仍会保有任务存储，以及列出每个会话任务的 Remote 方法。

**本轮就用一条控制台禁用行扣下开发者工具。** 在这里禁用 `plugin-manager` 或这个组合包，等于在桌面线的机制出现之前先给出答案，而第二个只属于控制台的答案之后还得与它调和。

**照抄 `web-runtime` 时不带 `publicUrl`。** 这一行会让该字段保持未设置，反向代理之后的控制台就会宣告回环 URL。

## Consequences

这三个控制台包记录下的事件，只由各包写入时自己做的校验把关；没有伴生插件的测试，它们自己的测试套件仍让每个源文件保持 100% 覆盖。控制台对话没有提醒，也没有时钟读数；想要定时的部署在自己的层里重新启用这两行，并接受同一个 Host 的任务列表就是每个访客的任务列表。在扣下机制落地之前，部署登录放进来的任何访客都能打开开发者工具，进而在 Host 里执行代码；`installBundle` 与 `setPluginEnabled` 在这个基座之前就已经能做到这一步。Web 金样随基座变动：tool-fs 的 `edit` 与 `write` 描述现在要求先给 `file_path`，由出厂 `standard` 预设而不是控制台 bundle 组合的场景多记一次时钟读数，并列出 `schedule_*` 工具。
