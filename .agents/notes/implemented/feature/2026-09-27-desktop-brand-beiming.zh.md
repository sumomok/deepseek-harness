# Agent Note：桌面端改名北冥并显示自己的发行版本

Status: implemented

[English](2026-09-27-desktop-brand-beiming.md) | 中文

## 问题

桌面客户端显示的是上游本地构建的身份。侧栏品牌行渲染 ui-sidebar 的回退：`brand.localBuild`（「DSH 本地构建」/「DSH Local Build」），下面一行是构建版本；窗口标题是 `DSH_CLIENT_TITLE ?? t('brand.localBuild')`；设置 → 通用的最后一行写着 `当前版本：0.1.7-rc.2`，这是仓库版本，而用户装的应用是 `0.1.0-rc.34`。产品要叫北冥（英文 Beiming），并显示自己的发行版本。应用名、安装包名 `DSH Desktop` 与 `appId` 保持不变，因为 userData 和更新通道都以它们为键。

改动必须留在 fork 自有路径里。有三条上游事实决定了做法：

- `scripts/build.ts` 通过 `repositoryClientBuildEnvironment` 解析客户端环境，它会删掉继承来的 `DSH_CLIENT_VERSION`，写入根 `package.json` 的版本。在 `pnpm run build` 外面设这个变量不起作用。
- 窗口标题是构建期的单一字符串。`common` 命名空间里的 `brand.localBuild` 无法被覆盖，因为 `LocaleRegistry.register` 遇到重复的命名空间与语言会抛错；slot 注册表也没有替换或屏蔽别的包注册项的办法，所以设置 → 通用的 `current-version` 行只能显示 `DSH_CLIENT_VERSION` 的值。
- 客户端半边拿不到组合行的 `config`（启动清单只带 id、url、rev、inject、external、immediately），而根客户端构建的 workspace 是 `vendor/*`、`packages/*/*`、`apps/cli`。vendored tarball 在别处构建，看不到本次构建对 `DSH_CLIENT_VERSION` 的替换。

## 决定

侧栏名称是 `@deepseek-ai/dsh-desktop-app`（桌面自己的组合层）里的一个 slot 占位者。该包新增一个空的 Host apply（`src/index.ts`）和一个浏览器半边（`src/client/index.ts`）：后者注册 `desktop-brand` locale 命名空间（`name`：北冥 / Beiming），并以名称加下方的 `DSH_CLIENT_VERSION` 占住 `sidebar.brand.name`。该层的 `cordis.patch.yml` 插入指向本包的 `desktop-brand` 行。`ui-brand-official` 保持挂载；它只在 `official` 客户端 profile 下注册，而本应用从不以该 profile 构建，所以这个 single slot 只有一个占位者。`sidebar.brand.mark` 仍用鱼形回退。

本包的 `build.ts` 用 esbuild 打出两个半边，浏览器半边采用模块加载器消费的闭包工厂形式，向外壳模块表请求 `PLATFORM_MODULES`，并通过 `clientBuildEnvironmentDefines` 替换 `DSH_CLIENT_*`——仓库自己的 bundle 用的也是这个辅助函数。它沿用 vendored 插件的构建方式，而不是 `packages/client/tsdown.client.ts`，因为那个预设只在 `packages/*/*` 下解析清单。

桌面打包不再运行 `pnpm run build`。`apps/desktop-shell/scripts/client-build.ts` 依次运行同样的三个脚本（`build:native-system`、`build:lib`、`build:web`），再运行 desktop-app 打包，所用环境是 `clientBuildProcessEnvironment` 作用于仓库取值加上 `DSH_CLIENT_TITLE=北冥` 与 `DSH_CLIENT_VERSION=<apps/desktop-shell 版本>`，并以该环境写客户端构建记录。随后 `verifyDesktopClientBuild` 要求记录与产物一致且写明这两个值，`apps/web/dist/index.html` 带 `<title>北冥</title>`，设置 → 通用与 desktop-app 的 bundle 嵌入该版本；`--skip-repo-build` 同样要过这道检查。有一条测试读取 `scripts/build.ts`，要求其中 `runScript` 的顺序与这里的列表一致，所以上游改动构建步骤时会在 fork 里失败。

## 备选方案

- **在 `pnpm run build` 外面设 `DSH_CLIENT_TITLE` 与 `DSH_CLIENT_VERSION`。** 标题能传进去，但 `scripts/build.ts` 会把版本换成仓库版本，设置 → 通用仍显示 `0.1.7-rc.2`。让它采用继承来的版本属于核心改动。
- **vendored 的 `@haoran/dsh-desktop-brand` tarball。** 这是 fork 放浏览器代码的常用路子，但预先构建的 bundle 看不到本次构建的 `DSH_CLIENT_VERSION`，组合行的 `config` 也到不了浏览器，所以版本那一行还得另配一个 Host 半边和一个 Remote 方法。
- **`official` 客户端 profile。** 它注册 DeepSeek Harness 字标并设 `DSH_CLIENT_TITLE=DeepSeek Harness`，这是本产品不能显示的身份。
- **在 `common` 字典里覆盖 `brand.localBuild`。** 这样不需要 slot 占位者就能得到按语言切换的标题与侧栏名称，但 locale 注册表拒绝同一命名空间与语言的第二次注册。

## 后果

- 窗口标题在两种语言下都是北冥。按语言切换标题需要改 `AppFrame` 或 `common` 字典，属于核心。
- 设置 → 通用显示 `当前版本：0.1.0-rc.34`。`0.1.0-rc.34（基于 DSH 0.1.7-rc.2）` 这种写法需要改这一行的核心文案，所以不显示。
- `ui-settings-account` 在 DeepSeek Platform 账号调用里以 `x-client-version` 发送的也是 `DSH_CLIENT_VERSION`；这些调用现在报告的是桌面版本。
- 从源码做开发用的 `dsh web` 启动时，在运行 `pnpm --filter @deepseek-ai/dsh-desktop-app run bundle` 之前，desktop-app 没有 `lib/`，而桌面 profile 需要它。
- 没有 recorded-session 快照需要更新：品牌行、标题与版本行都是客户端外壳，不产生会话事件，也不是模型可见的输入。

## 相关

- [桌面组合层](2026-09-06-desktop-composition-layer-content-search.zh.md)，本笔记扩展的包。
- [ui-brand-official](../../../../packages/client/ui-brand-official/README.zh.md)，同一组 slot 的上游占位者。
