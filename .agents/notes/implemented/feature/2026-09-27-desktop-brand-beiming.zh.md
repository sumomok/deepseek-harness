# Agent Note：桌面端改名北冥，发行版本只在更新页显示

Status: implemented

[English](2026-09-27-desktop-brand-beiming.md) | 中文

## 问题

桌面客户端显示的是上游本地构建的身份。侧栏品牌行渲染 ui-sidebar 的回退：`brand.localBuild`（「DSH 本地构建」/「DSH Local Build」），下面一行是构建版本；窗口标题是 `DSH_CLIENT_TITLE ?? t('brand.localBuild')`。设置 → 通用的最后一行写着 `当前版本：0.1.7-rc.2`，这是仓库版本；而 `@haoran/dsh-desktop-update` 渲染的更新设置页显示的是应用自己的版本（`0.1.0-rc.34`）。产品要叫北冥（英文 Beiming）。客户端构建嵌入的版本保持上游的，侧栏不显示版本，所以桌面发行版本只在更新页显示。侧栏的鱼形标志和名称要比 ui-sidebar 的 24px 标志、以及叠在版本徽标上方的名称更大。应用名、安装包名 `DSH Desktop` 与 `appId` 保持不变，因为 userData 和更新通道都以它们为键。

改动必须留在 fork 自有路径里。有三条上游事实决定了做法：

- `scripts/build.ts` 会把继承来的 `DSH_CLIENT_TITLE` 保留在它嵌入并记录的客户端环境里；继承来的 `DSH_CLIENT_VERSION` 则被换成根 `package.json` 的版本。
- 窗口标题是构建期的单一字符串。`common` 命名空间里的 `brand.localBuild` 无法覆盖，因为 `LocaleRegistry.register` 遇到重复的命名空间与语言会抛错。
- slot 注册表允许多个条目以不同优先级共用一个格子，只渲染优先级最低的那个；list slot 的格子就是条目的 `id`。客户端半边拿不到组合行的 `config`，而根客户端构建的 workspace 是 `vendor/*`、`packages/*/*`、`apps/cli`，所以 vendored tarball 看不到本次构建对 `DSH_CLIENT_*` 的替换。

## 决定

桌面在浏览器侧的改动都放在 `@deepseek-ai/dsh-desktop-app`（桌面自己的组合层）里。该包新增一个空的 Host apply（`src/index.ts`）和一个浏览器半边（`src/client/index.ts`），该层的 `cordis.patch.yml` 插入指向本包的 `desktop-brand` 行。浏览器半边做三件事：

- 注册 `desktop-brand` locale 命名空间（`name`：北冥 / Beiming），并只以名称占住 `sidebar.brand.name`，字号 18px，落在该行 24px 的行高上；字重留给 ui-sidebar，它设为 600，在 Windows 标题栏下降为 400。`ui-brand-official` 保持挂载；它只在 `official` 客户端 profile 下注册，而本应用从不以该 profile 构建。
- 以 `@deepseek-ai/dsh-client-ui-primitives`（外壳平台模块）的 `FishLogo` 占住 `sidebar.brand.mark`，尺寸为占有方 `size` 的 1.25 倍。ui-sidebar 在展开行和收起的窄条里都传 24，所以标志宽 30px、高 22px：既在该行 24px 的身份框之内（宽于 32px 的标志会被裁掉），也在窄条 36px 的切换按钮之内。
- 在 `settings.general.item` 的 `current-version` id 下以优先级 -1 注册一个渲染 `null` 的条目，遮住 ui-settings-general 以默认优先级 0 注册的那一行。list 条目渲染时没有包裹元素，所以这一行不会留下空元素；通用设置对最后一个子元素去掉分隔线的规则，会落到现在排在最后的那一行上。

本包的 `build.ts` 用 esbuild 打出两个半边，浏览器半边采用模块加载器消费的闭包工厂形式，向外壳模块表请求 `PLATFORM_MODULES`。该半边不读取任何 `process.env` 取值，所以 bundle 不做任何替换。它沿用 vendored 插件的构建方式，而不是 `packages/client/tsdown.client.ts`，因为那个预设只在 `packages/*/*` 下解析清单。

桌面打包以 `DSH_CLIENT_TITLE=北冥` 运行 `pnpm run build`（`apps/desktop-shell/scripts/client-build.ts`）。随后读取客户端构建记录——记录必须与产物一致并写明该标题——并要求 `apps/web/dist/index.html` 带 `<title>北冥</title>`（`assertDesktopClientTitle`），之后才打包 desktop-app。`--skip-repo-build` 同样经过这道检查和打包。

## 备选方案

- **把桌面发行版本作为 `DSH_CLIENT_VERSION`。** `scripts/build.ts` 会替换继承来的版本，所以打包脚本得自己重跑构建步骤。它还会改变 `ui-settings-account` 在 DeepSeek Platform 账号调用里发送的 `x-client-version`。
- **vendored 的 `@haoran/dsh-desktop-brand` tarball。** 这是 fork 放浏览器代码的常用路子，而且该半边不读取任何构建期取值，预先构建的 bundle 渲染结果相同。该半边留在本包里，与挂载它的 `desktop-brand` 行放在一起，一次改动同时改到两者。
- **在 ui-sidebar 自己的品牌行里放大尺寸。** 回退标志尺寸和 `.brandName` 字号在 `SidebarRoot.tsx` 及其样式表里，属于核心。
- **`official` 客户端 profile。** 它注册 DeepSeek Harness 字标并设 `DSH_CLIENT_TITLE=DeepSeek Harness`，这是本产品不能显示的身份。
- **在 `common` 字典里覆盖 `brand.localBuild`。** 这样不需要 slot 占位者就能得到按语言切换的标题与侧栏名称，但 locale 注册表拒绝同一命名空间与语言的第二次注册。

## 后果

- 窗口标题在两种语言下都是北冥。按语言切换标题需要改 `AppFrame` 或 `common` 字典，属于核心。
- 收起的窄条里标志同样是 30px，位于 36px 的切换按钮中：占位者在两个调用点收到相同的 `size`，无法区分二者。Windows 标题栏下不渲染窄条标志。
- 设置 → 通用不显示版本。更新设置页显示 `当前版本 {version}`，取自壳的 `app.getVersion()`，而且只在打包启动时出现，因为只有那时壳才提供更新状态。
- 从源码以桌面 profile 启动 `dsh web` 之前，要先运行 `pnpm --filter @deepseek-ai/dsh-desktop-app run bundle`，因为该 profile 挂载 `desktop-brand` 行。
- 没有 recorded-session 快照需要更新：品牌行、标题与设置行都是客户端外壳，不产生会话事件，也不是模型可见的输入。

## 相关

- [桌面组合层](2026-09-06-desktop-composition-layer-content-search.zh.md)，本笔记扩展的包。
- [ui-brand-official](../../../../packages/client/ui-brand-official/README.zh.md)，同一组 slot 的上游占位者。
