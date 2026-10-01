# Agent Note: The desktop downloads the LibreOffice engine on request

Status: implemented

[English](2026-09-27-desktop-office-engine-on-request.md) | 中文

## Problem

rc.34 把每个 `@deepseek-ai/libreoffice-kit-*` 引擎都从两个桌面载荷里剔掉,并关掉了 `office-to-pdf` 那一行,所以桌面预览不了任何 Word 或 PowerPoint 文件。rc.35 的产品决定是:桌面照旧不带引擎,用户可以选择下载;`dsh web` 部署照旧自带。每个引擎都是一整套 LibreOffice:`darwin-arm64` 的压缩包 66,711,287 字节、解压 145 MB,`win32-x64` 是 71,367,891 字节与 182 MB。

`@deepseek-ai/libreoffice-kit` 0.1.1 决定了引擎能从哪来。`lib/index.js` 用 `createRequire(import.meta.url)` 从它自己的目录解析 `@deepseek-ai/libreoffice-kit-<platform>-<arch>/package.json`(第 1211–1295 行),不从配置或环境变量读任何路径,要求引擎的 `package.json` 版本与 `prebuilds.json` 都等于它自己的 `0.1.1`(1295),检查可执行位(1287),而且在 macOS 与 Windows 上直接抛 `Required LibreOfficeKit native package is missing`,不退回 WASM。`@deepseek-ai/dsh-office-to-pdf` 会删掉创建失败的转换器槽位(`src/index.ts:241-244`),下一次转换重新创建。

## Decision

- **版本取自 kit。** `readEngineRequirement` 从服务端闭包沿 `@deepseek-ai/dsh` → `dsh-web-app` → `dsh-office-to-pdf` → `libreoffice-kit` 解析到 kit(这条链在 hoisted 载荷与工作区检出里都成立),读 `optionalDependencies["@deepseek-ai/libreoffice-kit-<target>"]`,只接受一个精确版本。kit 升级时,要下载的东西跟着变,壳不用改。
- **位置是数据目录的函数。** `officeEngineRoot(dataDir)` 是 `<dataDir>/engines/office`,每个版本一个目录。`main.ts` 传入 `resolveHarnessHome()`;rc.35 的数据目录搬迁在这里传它自己的目录。
- **`NODE_PATH` 从启动起就设好。** `engineServerEnv` 把 `<root>/<version>/node_modules` 放在服务端子进程 `NODE_PATH` 的第一位,排在继承来的值前面,不管它存不存在。Node 把 `NODE_PATH` 读进全局路径只读一次,只缓存解析成功的结果;`rc34-work/office-scope/probe/t.mjs` 证实启动之后才建好的包目录在同一进程里能解析到,`t2.mjs` 证实启动之后删掉 `process.env.NODE_PATH`,本进程照样解析,子进程则看不到它。桌面层去掉了自己的 `office-to-pdf` 行,出厂那一行从启动起就开着,下载完之后的第一次转换不用重启就能成功。
- **这一项单独点名。** `DSH_DESKTOP_OFFICE_ENGINE_MODULES` 带着同一个路径;提示插件的宿主那一半在 apply 时从 `process.env.NODE_PATH` 里删掉恰好这一项。`@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv` 在 spawn 时复制 `process.env`,并且已经去掉所有 `DSH_*` 名字,所以 endpoint、token 与 modules 这几个变量从不进工具的子进程;需要删的只有 `NODE_PATH`。
- **用随包的 pnpm 安装,先暂存再改名。** `installEngine` 建 `<root>/.staging-*`,用随包的 Node 跑 `pnpm.mjs`,参数是 `add <engine>@<version> --ignore-workspace --ignore-scripts --reporter=ndjson --config.node-linker=hoisted --config.lockfile=true --store-dir=<staging>/.pnpm-store`,拿这次运行的 `pnpm-lock.yaml` 给引擎记下的完整性值去比 `ENGINE_DOWNLOADS` 固定的 sha512(即 registry 的 `dist.integrity`),核对引擎的版本、`prebuilds.json` 与可执行文件,删掉这次运行自己的仓库,再把暂存目录改名成 `<root>/<version>`,遇到 `EPERM`/`EBUSY`/`EACCES` 每隔 500 毫秒重试,共九次,约 4.5 秒。pnpm 按 registry 元数据校验压缩包,并管 `os`/`cpu` 过滤、可执行位与用户的 `.npmrc`;固定值挡住的是指向别的压缩包的元数据。表里没有的 kit 版本不提供下载。进度条由 `pnpm:fetching-progress` 记录驱动(`started` 带 `size`,`in_progress` 带 `downloaded`);字段名取自一次抓下来的 pnpm 11.7.0 运行。
- **一条带原生确认的本机服务。** `office-engine-service.ts` 在它自己的 token 后面提供 `GET /state`、`POST /install`、`POST /cancel`。`/install` 立刻答 `202 confirming`,弹出一个挂在主窗口上的原生对话框;只有点了确认按钮才开始下载,默认按钮是取消。用户取消后 30 秒内,`/install` 直接答 `409 declined-recently`,不再弹框。每个 `409` 的响应体都是 `{ code, message }`,插件据此告诉用户是哪一种拒绝。调用方什么都不指定。`close()` 中止正在跑的下载,不等还开着的对话框,之后才到的回答什么都不启动。
- **只按名字形状清理。** 服务端启动之前、以及一次安装之后,root 下凡是当前版本以外的精确版本名、或以 `.staging-` 开头的条目都被删掉;别的名字保留。
- **载荷不变。** `platformDirRules`、闸门的 `platform-variant` 豁免、打包步骤的缺席检查照样把每个引擎挡在外面;它们写明的理由现在说的是下载。

## Alternatives considered

- **用 `module.registerHooks` 改写解析** —— kit 用的 `require.resolve` 绕过解析钩子,kit 照样找不到引擎。
- **在载荷的 `node_modules` 里做链接或复制** —— 在 macOS 上要写进已签名的应用包,在 Windows 上要写进 `Program Files`,两处都会被更新替换。
- **Electron 的 `session.downloadURL`** —— 在 macOS 上会给每个解出来的文件打上 `com.apple.quarantine`,还把完整性校验、解包与可执行位都留给壳自己做。
- **`dsh-pnpm.cmd` 启动脚本** —— Windows 上 Node 不带 `shell: true` 就拒绝 spawn `.cmd`,而且杀进程杀到的是 `cmd.exe` 而不是 pnpm。
- **用户全局的 pnpm 仓库** —— 会在用户主目录下再放一份 145 MB,落在搬迁功能要挪动的数据目录之外。
- **把引擎版本写死** —— kit 一升级,就与 kit 自己的检查悄悄对不上。

## Consequences

- macOS arm64 上的端到端实跑(`rc34-work/rc35-office/e2e/run.mts`)经 `installEngine` 把真实的 `darwin-arm64@0.1.1` 引擎装进一个 `mkdtemp` 数据目录,用时 7 秒:13 次进度报告直到 66,711,287 字节,盘上 147 MB,可执行文件权限 755,没有 `com.apple.quarantine`,没留下仓库。一个去掉了引擎兄弟包的 kit 在没有 `NODE_PATH` 时拒绝转换,有了它就把一份生成的中文 `.docx` 转成了 PDF,`pdftotext` 读回的文字原样不变。
- 提示插件没加载时,服务端的子进程会继承引擎的 `NODE_PATH` 一项。
- 随包 vendor 的提示插件在 rc.35 的 vendor 步骤之前停在 0.1.0,所以这棵树打出来的包不提供下载。
- 从「lend the server a loopback service that downloads the Office engine」到「document the on-request Office engine, with an Agent Note」这三个提交单独检出时测试或 hygiene 不全绿,「read the engine service's JSON answer without an unknown assertion」修好了它。历史只追加,所以 bisect 时 `git bisect skip` 这三个。
- Windows 还没在真机上验证:改名时 Defender 扫描解压后的引擎、`win32-x64@0.1.1` 引擎能否转换、hoisted 布局下的路径长度。

## Related

- `apps/desktop-shell/src/office-engine.ts`、`office-engine-service.ts`、`pnpm-launcher.ts`(`pnpmInvocation`)、`main.ts`(`startOfficeEngineForServer`)
- `apps/desktop-app/cordis.patch.yml`;`apps/desktop-shell/README.md` 的「Office 引擎服务」
- `@haoran/dsh-office-preview-notice` 0.2.2,vendor 为 `apps/desktop-server/vendor/haoran-dsh-office-preview-notice-0.2.2.tgz`,它在「用默认程序打开文件」旁提供下载,并删掉 `NODE_PATH` 那一项
