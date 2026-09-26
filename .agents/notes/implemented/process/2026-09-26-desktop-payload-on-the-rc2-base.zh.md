# Agent Note: Desktop payload and boot gate on the 0.1.7-rc.2 base

Status: implemented

[English](2026-09-26-desktop-payload-on-the-rc2-base.md) | 中文

## 问题

在 dsh 0.1.7-rc.2 上，桌面服务端闭包带进来的包多于桌面 profile 实际运行的包；而暂存启动走到 URL 那一行，也不再能说明 profile 已组合完整。

`@deepseek-ai/dsh` 把 `@deepseek-ai/dsh-experimental-auto-review` 列为运行时依赖，好让上游的插件页能提供它。它的审查与本部署的权限网关并行运行，而不是取代网关。同一个闭包经 `dsh-office-to-pdf` 与 `dsh-skill-office` 带进 `@deepseek-ai/libreoffice-kit`，连同构建宿主的 LibreOffice 引擎包，而 `stageWindowsVariants` 还会在旁边取来 win32-x64 引擎。每个引擎都是一整套 LibreOffice 构建，远超一百兆字节；web 应用的 `office-to-pdf` 行就在它上面为右侧边栏的文档标签页启动转换器。

出厂组合包组合了上游的插件管理器：dsh-base 的 `plugin-manager` Host 行提供安装、启用、移除 bundle 的 `pluginManager` 服务，dsh-web-app 的 `ui-plugin-manager` 行是它的侧栏页。这个安装器能装回载荷有意不带的包。

基座会跳过解析不到或不予接纳的 `dsh.profile.bundles` 名字，往 stderr 写一行 `skipping profile bundle`，然后不带这个 bundle 的层照常启动。被拒的插件行会伴随一行 `disabling profile plugin` 被禁用，没有激活的条目会在一条 `did not activate` 警告里报出。打包的启动闸原先把 URL 那一行当作每个播种的 bundle 都已组合的证明。

## 决策

**载荷不带上游的 auto-review。** `apps/desktop-shell/scripts/staged-boot-gate.ts` 里的 `WITHHELD_PACKAGES` 点名它；`package.ts` 在 `stageWindowsVariants` 之后、载荷清点之前，把它从暂存树顶层 `node_modules` 删掉，所以载荷闸从来看不到这次移除。随后只要任何深度还留着同名目录，`verifyStaging` 就失败，因为提升方式一变，副本可能嵌到别的包下面，顶层删除就落空了。

**没有哪份载荷带 LibreOffice 引擎，Office 预览关闭。** `apps/desktop-shell/scripts/platform-dir-rules.ts` 里的 `platformDirRules` 在两个目标上丢掉每一个 `@deepseek-ai/libreoffice-kit-<suffix>` 目录，保留 kit 的入口包，因为 `dsh-office-to-pdf` 静态导入它；kit 只在创建转换器时才解析引擎。`stageWindowsVariants` 不再取 win32-x64 引擎，并打印一行说明跳过了它。`payload-gate.ts` 的 `EXEMPTIONS['platform-variant']` 收下各目标原生的引擎目录，因为该目标的载荷现在不带它。这条豁免点名的是目录而不是方向，所以引擎混进另一个目标的载荷时它同样放行；因此只要成品载荷在任何深度还留着一个以暂存 kit 的 `optionalDependencies` 所声明的引擎命名的目录，`deriveServerPayload` 就让它失败。desktop-app 层禁用 `office-to-pdf`，于是没有谁会创建转换器。

**插件管理归上游；这一决定归[插件管理那份 Note](../feature/2026-09-26-desktop-plugin-management-on-upstream.zh.md)。**desktop-app 层让 `plugin-manager` 与 `ui-plugin-manager` 保持开启，并把 `pnpmCommand` 指向随包的 pnpm 启动脚本；壳在 profile 层让被扣下的 auto-review 组合为关闭。这一层不加 `tool-plugin-manager` 行。cordis 预设启用的那个 agent 工具位于 `preset-cordis` 的 `config.plugins` 里，按 id 的 patch 够不到那里；一行 `id: tool-plugin-manager` 只会改到 dsh-base 的顶层行，而 dsh-base 与 dsh-web-app 早已把它关掉。改由网关行的 `alwaysAsk` 把这个工具的每次调用交给人。

**暂存启动遇到加载报告就失败，组合出的 dump 必须显出桌面层。** `verifyStagedBoot` 收集服务端的 stderr，任何一行带有 `LOAD_FAILURE_MARKERS` 之一——`skipping profile bundle`、`disabling profile plugin` 或 `did not activate`——都让打包失败。随后它在同一个构建 home 上跑 `--dump-config`，要求 `verifyDesktopLayer` 找到以 `openAt: first-search` 组合出的 `session-query-sqlite`，这个值只有最后一个 bundle `@deepseek-ai/dsh-desktop-app` 会设。

**暂存启动不带构建时包管理器的环境,暂存树必须带齐安装包的闭包。**pnpm 的 `.bin` shim 会导出指向工作区 `node_modules/.pnpm/node_modules` 的 `NODE_PATH`,`resolveBundleDir` 会搜索它,于是暂存启动从构建检出里找到了 `@deepseek-ai/dsh-base`,而载荷里根本没有:pnpm 的 legacy 部署器把 `@deepseek-ai/dsh` 放在部署源旁边,dsh-base 只在它内部的 `node_modules` 里,`restoreLegacyHoists` 把这层丢了。没有 `NODE_PATH` 时,已安装的服务端会跳过 dsh-base 并启动失败。`staged-boot-gate.ts` 的 `stagedBootEnv` 让暂存启动与 `--dump-config` 去掉 `NODE_PATH`、`npm_*` 与 `PNPM_*`;`missingProductionDependencies` 让缺少 `@deepseek-ai/dsh` 任一生产依赖的暂存树、以及缺少其中 `@deepseek-ai` 部分的成品载荷失败;`legacy-hoists.ts` 的 `restoreHoistedDependencies` 把恢复的 hoist 只在自己内部带着的生产依赖拷进暂存树。

## 备选方案

**带上 LibreOffice 引擎，打开 Office 预览。** 0.1.0-rc.34 不采纳：rc.33 本来就没有 Office 预览，不带不算拿走什么，而每少带一个引擎就少一百多兆字节。要带，就在 `platformDirRules` 里保留各目标自己的引擎，并去掉那几条豁免。

**只在载荷闸里豁免引擎、不剪掉它们。** 不采纳：载荷会带着引擎出货，而且 `platform-variant` 豁免不分方向，闸门在两份载荷里都不会再报它们。

**按 id 禁用 `tool-plugin-manager` 行。** 不采纳：那一行位于预设的 `config.plugins` 里，patch 只会改到一个早已关掉的顶层行。

**只靠 stderr 那几行。** 不采纳：它们只能抓住输出了已知措辞的失败。dump 证明的是最后一层确实进了组合出的 profile，与服务端打印了什么无关。

## 后果

桌面上右侧边栏的文档标签页没有 Office 渲染。内置的 `@haoran/dsh-office-preview-notice` 为 Word 与 PowerPoint 的四个后缀注册了一项排在预览自带 Office 渲染器之上的实现,所以打开这类文件时显示的是一行请用户用 Office 或 WPS 打开的说明,而不是那个渲染器关于启用预览服务的提示;在查看方式菜单里手动选那个渲染器,仍会看到那段提示。用户在自己的 patch 层里重新启用 `office-to-pdf` 行，会启动一个转换必然失败的提供者，因为载荷里没有可供 kit 解析的引擎。

启动闸只认 `LOAD_FAILURE_MARKERS` 点名的那几段文字。上游改了这些行的措辞，闸门会悄无声息地放行，直到标记清单跟上；桌面层的 dump 仍能抓住最可能的后果，也就是最后一层没进来。

此后闭包再带进来桌面不运行的包，都要做同样的决定：在暂存阶段扣下，或者按目标剪掉、配一条豁免和一次缺席检查。

## 相关

[桌面载荷裁剪闸](2026-08-20-desktop-payload-prune-gate.zh.md) 负责四条闸门检查和豁免表；[0.1.7-rc.2 基座上的桌面内置插件](2026-09-26-desktop-builtins-on-the-rc2-base.zh.md) 负责同一基座上随包分发的插件集合；[桌面安装包随附插件并把它们播种进自己的 profile](../feature/2026-08-21-desktop-builtin-plugins.zh.md) 负责内置插件为什么在载荷里。
