# Agent Note: The desktop payload carries placeholders for the bundles it withholds

Status: implemented

[English](2026-10-04-desktop-withheld-bundle-placeholders.md) | 中文

## 问题

`@deepseek-ai/dsh` 把 `@deepseek-ai/dsh-experimental-auto-review` 以及（从 0.2.1-alpha.1 起）`@deepseek-ai/dsh-experimental-inspector-profile` 列为运行时依赖，好让上游的插件页能提供它们。上游的 Auto 与 `@haoran/dsh-llm-permission-gateway` 读同一对旋钮，两者一起挂上时每次调用都会被审两遍。检查器组合包挂的是桌面不提供的开发者检查器。

0.1.0-rc.34 到 rc.37 的构建把 auto-review 从载荷里扣下，并在每次启动时往 profile 自己的 patch 层写一行 `auto-review` / `disabled: true`（[插件管理 note](2026-09-26-desktop-plugin-management-on-upstream.zh.md)）。扣下包并没有挡住安装：插件管理器解析组合包时先找安装目录、再找 profile，安装目录里的副本没了，`plugin_manager` 工具或 `dsh plugin add` 装进 profile 的副本就会被解析并加载。那一行让这个副本组合时保持关闭，但只在没人改它的时候有效，而插件页的启用恰好会在它上面写 `disabled: false`。没装这个副本时（也就是每台机器），这一行不指向任何条目，`--dump-config` 每次运行都打印 `patch: entry "auto-review" not found`。检查器组合包则完全没有防护：它作为官方组合包列出，可以被打开。

## 决策

**载荷为每个扣下的组合包放一个占位包。**`apps/desktop-shell/src/profile-seed.ts` 的 `PLACEHOLDER_BUNDLES` 点名 auto-review 与 inspector-profile。`scripts/package.ts` 把它们和其余 `WITHHELD_PACKAGES` 一起从暂存树删掉，再写入 `server/node_modules/<包名>/package.json`，里面只有包名和版本 `0.0.0-withheld`（`scripts/staged-boot-gate.ts` 的 `placeholderManifest`）。这个清单没有 `dsh` 字段、入口或依赖。安装目录优先的解析于是每次都落到占位包上：`listBundles` 跳过没被选中、也没有 `dsh.bundle` 的包，`setBundleEnabled(name, true)` 以 `not-bundle` 失败，经 `plugin_manager` 工具或远程 API 的安装以同一个代码回滚，从载荷自己的安装目录运行的 `dsh plugin add` 只把它装成普通依赖、不选中任何东西。profile 里的副本永远不会被解析到。别的安装目录里、与桌面共用 `DSH_HOME` 的 `dsh` CLI 会从它自己的安装目录解析到真包并选中它；下次桌面启动撤掉这个选中，桌面自始至终解析到的都是占位包。

**只有检查器组合包依赖的两个插件直接扣下，不放占位包。**`@deepseek-ai/dsh-experimental-inspector` 与 `@deepseek-ai/dsh-experimental-session-inspector` 是插件包而不是组合包，它们的组合包扣下以后，闭包里没有别的东西会加载它们。

**打包门禁要求占位包逐字节一致。**`findWithheldDirectories` 只放过位于树根 `node_modules/<包名>`、目录里只有 `package.json`、且字节与占位包一致的目录；嵌套的副本、多出的文件或不同的字节照样报出。`verifyStaging`（`--skip-deploy` 也一样）要求每个占位包都这样在位。暂存启动经浏览器用的 RPC 路由调用 `pluginManager/listBundles` 与 `pluginManager/setBundleEnabled`：列表必须有组合包且不含任何扣下的包，每个占位包都必须以 `not-bundle` 被拒且不改任何东西，启动输出与 `--dump-config` 的 stderr 都不得出现 `auto-review` 的 not found 那一行。

**壳在每次启动时退役守护行、删掉对占位包的选中。**在 `web` profile 同步之前，`retireAutoReviewGuard` 删掉早先构建写下的那段原文（含注释块，且它下面没有同一条目的后续行）和它上方的一个空行，删完不剩条目时在原处写回 `[]`，于是带守护行的模板变回空模板。其他任何 `auto-review` 行，包括在那段原文下面加了键的，原样保留并记日志。同步之后，`deselectPlaceholderBundles` 把两个包名从 `dsh.profile.bundles` 删掉，`migrationRefusal` 让 `web` 同步不再接纳它们。

## 备选方案

**保留守护行，接受那条告警。**否决：这一行留着 profile 副本那条路，用户的修改或插件页的启用会在没有任何提示的情况下把它重新打开，检查器组合包还得再加一行，缺口一样。

**保留真包，在 desktop-app 层把它们的行关掉。**否决：插件页把新选中的组合包追加在 `@deepseek-ai/dsh-desktop-app` 之后，那一层按 id 的行会先于组合包的 `insert` 生效，什么也匹配不到；组合包也仍然会被列出、可以选中。

**把占位包做成 `apps/desktop-server` 依赖的工作区包。**否决：工作区里已经有每个名字对应的真包，`@deepseek-ai/dsh` 以 `workspace:*` 依赖它，同名的第二个包进不了工作区。在部署之后写入占位包，也让它的字节只由门禁比对的那一个函数掌握。

**上游的 Auto 挂上时让网关让开。**没有采用：桌面上已经挂不上 Auto，网关不需要这项检查。

## 后果

上游的 Auto 和检查器在桌面上是装不上，而不是装上后保持关闭。把旧的那一行改成 `disabled: false` 已经打不开 Auto，界面上也没有任何提示。在插件页的添加插件对话框里输入这两个包名中的任何一个，都会因为 `@deepseek-ai/dsh` 把两者列为依赖而以「已安装」被拒绝，而页面列表里两个都不显示；在这个构建之前，检查器组合包在那里可以被打开。用户改过的 `auto-review` 行留在 profile 里，不指向任何条目，每次启动记一行日志。

占位包不豁免任何别的东西：暂存树任何位置出现真副本，`verifyStaging` 仍然失败。早先构建的用户装进 profile `node_modules` 的副本留在磁盘上，取消选中后插件页不再显示它，也永远不会被加载。

以后上游再出现桌面不运行的组合包，需要做同样的决定；把它的名字加进 `PLACEHOLDER_BUNDLES` 就同时覆盖载荷、门禁和 profile。

## 相关

[插件管理 note](2026-09-26-desktop-plugin-management-on-upstream.zh.md) 负责桌面上的上游插件管理器；本 note 取代其中的 auto-review 守护行。[0.1.7-rc.2 基座上的桌面载荷](../process/2026-09-26-desktop-payload-on-the-rc2-base.zh.md) 负责暂存时扣包与启动门禁。
