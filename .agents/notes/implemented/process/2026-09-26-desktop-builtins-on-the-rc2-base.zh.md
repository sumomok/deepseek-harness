# Agent Note: Desktop built-ins on the 0.1.7-rc.2 base

Status: implemented

[English](2026-09-26-desktop-builtins-on-the-rc2-base.md) | 中文

## 问题

0.1.0-rc.34 把桌面端搬到 dsh 0.1.7-rc.2 上,安装包自带插件的三件事随之变了。

`dsh-at-file` 0.7.0 是载荷以 `dsh-at-file-0.7.0-da602d1.tgz` 携带的第三方 `@` 文件提及插件,它在这个基座上跑不起来。它的宿主半边在 `apply` 第一行调用 `ctx.settings.register`,而 rc.2 的 `settings` 服务已经没有 `register`:设置改成了 profile 条目上的 volatile `Config` 字段。宿主半边整个失败,于是把被提及文件放进请求的那次 `agent/pre-step` 注入没了,浏览器那一半却仍然提供 `@` 菜单。它在 `settings.yaml` 里的段叫 `at-file`,条目 id 却是 `dsh-at-file`,所以那个文件的一次性导入也安放不了这一段。上游自己的 web 应用从 0.1.5 基座起就带着 `@` 引用:输入框里的 `ui-reference` 菜单,文件候选由 `file-reference-local` 提供。

其余十三个内置插件 peer 依赖了旧 tarball 没用到的 workspace 包:settings、chat、conversation 与 slot 这几个客户端包,remotes 与 session-controller 两个 API,以及 `agent-preset-registry`。`apps/desktop-server/package.json` 没有声明它们,而 `pnpm-lock.yaml` 设了 `autoInstallPeers: true`,于是 pnpm 把每个没声明的 peer 从 npm 注册表装进来,放在同名 workspace 包旁边。

这十三个本来就都要对着 rc.2 重建,而它们替换掉的 tarball 里有两个无法从任何提交重建:rc.33 的 `@haoran/dsh-auto-compact` 归档是从未提交的工作区打出来的,它与网关的清单布局也和其余十一个不同。

## 决策

**撤下 `dsh-at-file`,由上游的 `@` 引用接替。**删掉它的 tarball、`file:` 标识符、notices 覆盖项与 README 那一行,名字从 [`apps/desktop-shell/src/profile-seed.ts`](../../../../apps/desktop-shell/src/profile-seed.ts) 的 `BUILTIN_WEB_BUNDLES` 挪进 `WITHDRAWN_WEB_BUNDLES`,是继 `@sumomok/dsh-edit-rerun` 与 `dsh-better-sidebar` 之后的第三条。rc.2 上,服务端跳过 `dsh.profile.bundles` 里解析不到的名字,并在每次启动时往 stderr 写一行 `skipping profile bundle`,所以正是这一条把名字从旧构建播种过的每个 profile 里取出去;`pruneWithdrawnBundles` 只在名字已解析不到时才删,也只删壳自己建的链接。`@` 提及文件与会话由 web 应用的 `ui-reference` 一行提供,profile 关掉它的办法和关掉一个内置插件那一行相同。

**内置插件 peer 依赖的每个 workspace 包,都是 `apps/desktop-server` 的一条 `workspace:*` 依赖。**新增十六条:`@deepseek-ai/dsh-agent-preset-registry`、`-api-remotes`、`-api-session-controller`,以及十三个 `@deepseek-ai/dsh-client-*` 包。声明之后,pnpm 把每个 peer 链接到服务端自己运行的那个 workspace 包,注册表副本随之离开 lockfile,旧 tarball 拉进来的 `dsh-typert-protocol` 0.1.2-rc.1 副本也在其中。写 `workspace:*` 而不是 `workspace:^`,是因为上游的 workspace 协议卫生检查对 `@deepseek-ai/dsh-*` 依赖拒绝其他任何区间,私有应用也不豁免。

**十三个内置插件全部从插件仓库的同一个提交重新打包,不论源码改没改。**它们在一套记录下来的工具链(Node 24.15.0、pnpm 10.15.0、Darwin arm64)下从那个提交构建并打包。同一提交在另一棵工作树里再打一次,得到的归档必须逐字节相同,才会有任何一个进 vendor。源提交、工具链与每个归档的 sha256 记在 vendor 那次提交的说明里,所以每个 vendor 的 tarball 都能从一个别人取得到的提交重建。版本是 gateway 0.5.0、auto-compact 0.3.0、desktop-update 0.2.0、plugin-updates 0.3.0、mcp-servers 0.2.0、balance 0.6.0、clickable-refs 0.5.0、screenshot 0.6.0、connection-banner 0.3.0、quote-message 0.4.0、vision-switch 0.3.0、btw 0.2.0 与 default-model 0.3.1。

## 备选方案

**留着 `dsh-at-file`,等作者改用 volatile `Config`。**否决:这个插件在第三方仓库里,有自己的发版节奏;在它改之前,分发的归档的宿主半边在 rc.2 构建的每次启动都会失败。一个提供 `@` 菜单、提及却永远到不了模型的输入框,比没有菜单更糟。

**不声明这些 peer,让 pnpm 自己装。**否决:载荷里每个这样的包都会有两份,一份是服务端运行的 workspace 构建,一份是注册表解析到的某个版本的 npm 构建。

**只重打源码改过的包。**否决:被替换的归档里有两个无法从任何提交重建,而在同一套工具链下一次打完十三个,才让可复现检查覆盖整个 vendor 集。

## 后果

这个基座上载荷里有十四个 vendor 的 tarball,其中十三个带浏览器那一半;`@haoran/dsh-default-model` 只有 patch 层,[0.1.0-rc.37 把它撤下了](../simplification/2026-10-01-desktop-model-catalog-follows-upstream.zh.md)。`@sumomok/dsh-balance` 0.6.1 与 `@sumomok/dsh-quote-message` 0.4.0 走在 npm 之前,npm 上分别止于 0.4.0 与 0.3.1。

只要还有 0.1.0-rc.33 或更早的安装可能升级到这一版,`WITHDRAWN_WEB_BUNDLES` 里这一条就必须留着。提前删掉,rc.33 播种过的每个 profile 都会留着这个名字,每次启动都多一行 `skipping profile bundle`。

这里没有任何东西导入 `settings.yaml` 的 `at-file` 段:它的条目 id 对不上任何一行,把它的键映射到 `ui-reference` 与 `file-reference-local` 是另一项工作。在那之前,关掉过 `dsh-at-file` 的用户会重新看到上游的 `@` 菜单。

今后加一个内置插件,或者某个内置插件新增一个 peer,都还要在 `apps/desktop-server/package.json` 里声明那个 peer;没声明的会以注册表副本的形式重新出现在 lockfile 里,而不会让任何东西失败。

重现一个归档需要插件仓库里记下的那个提交取得到,所以含有这个提交的分支要在 vendor 提交落地之前推到一个远端。

## 相关

[桌面安装包自带插件并把它们播种进自己的 profile](../feature/2026-08-21-desktop-builtin-plugins.zh.md) 负责说明内置插件为什么在载荷里、`WITHDRAWN_WEB_BUNDLES` 对 profile 做什么;[撤下 vendor 的右侧栏](../simplification/2026-09-14-desktop-withdraw-better-sidebar.zh.md) 是撤下第三方内置插件的先例;[vendor 插件引用门禁](2026-09-03-vendored-plugin-reference-gate.zh.md) 负责核对清单、notices 覆盖项与 README 表格指的是同一批归档。
