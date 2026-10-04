# Agent Note: kit 声明新引擎版本时,不询问就升级已下载的引擎

Status: implemented

[English](2026-10-03-desktop-office-engine-upgrade-without-asking.md) | 中文

## Problem

桌面只在用户点了原生确认框之后才下载 LibreOffice 引擎([按需下载那篇](../feature/2026-09-27-desktop-office-engine-on-request.zh.md)),确认框的说明写着组件会留在这台电脑上。kit 只接受 `package.json` 版本等于它自己 `ENGINE_VERSIONS[target]` 的引擎(kit 0.1.5 `lib/index.js:1554`),而从 kit 0.1.3 起,kit 每发一版都会把每个桌面引擎以新版本号重新发布一次,连没有任何 macOS 源码改动的 0.1.4 也不例外。打包带的 kit 来自 legacy hoisted `pnpm deploy`,它不认锁文件钉住的版本,而是把 kit 的范围(rc.35.1 与 rc.36 两个构建里是 `^0.1.1`)解析到部署那一刻已发布满一天的最新版本:rc.35.1 暂存到 0.1.3,晚一天部署的 rc.36 暂存到 0.1.5。这样的构建第一次启动时,启动清理删掉了用户下载过的引擎,把他当成从没下载过的人:提示重新给出「在这里预览 · 需下载约 64 MB」,同一个确认框再问一遍。开发用的 Mac 上在 rc.35.1 与 rc.36 两个构建之间发生过一次(`dsh-server.log` 第 6886–7023 行:`removed 0.1.3`,然后 `0.1.5 … (absent)`,然后点击之后的下载)。新字节是真的——0.1.3 与 0.1.5 之间那个 140.7 MB 的可执行文件 `sha256` 和 `LC_UUID` 都不同——所以下载躲不掉,再问一遍却可以不问:版本变化不是谁的决定,用户也已经同意过留下这个组件。

## Decision

- **同意从盘上读。** 声明的版本还没装好时,`office-engine.ts` 里的 `versionsToKeep` 除了这个版本,还留下另一个装着所声明包的完整引擎、版本最高的那个版本目录(`supersededEngine`:清单版本等于目录名,`prebuilds.json` 点名了可执行文件,而且它是可运行的文件)。只有确认过的对话框后面的 `installEngine`,或从它写出的引擎升级而来的安装,会写出这样的目录,所以它在不在,就是用户同意留下引擎的记录,别的什么都不持久化。声明的版本一旦装好,更早的那个就不再留。
- **状态在服务端起来之前就变。** `startOfficeEngineForServer` 把留下的版本作为 `superseded` 交给 `OfficeEngineManager`,并在引擎服务和服务端启动之前调用 `beginUpgrade()`,于是 phase 读作 `installing`、0 字节,中止控制器也已就位。`@haoran/dsh-office-preview-notice` 只在 `apply` 里读一次 `/state`,之后只在 phase 是 `confirming` 或 `installing` 时轮询;如果那一次读到的是 `absent`、之后才变,提示会一直给出一个服务用 `409 installing` 拒绝的下载,直到页面重新加载。插件不需要改。
- **下载等启动走完。** `runUpgrade()` 在服务端就绪、启动闸门放行、应用显示出来之后才运行,所以 pnpm 和约 150 MB 的解包排在服务端启动之后,被强制更新拦住的启动什么都不下载。引擎服务没能启动的启动改为关闭 manager,因为用户既看不到进度也取消不了这次下载;更早的引擎留给下一次启动。它原样调用 `installEngine`:对照 `ENGINE_DOWNLOADS` 的锁文件完整性校验、完整引擎检查、改名到位。安装之后的清理再删掉更早的引擎。
- **失败保留记录,取消或拒绝就是拒绝升级。** 安装失败读作 `failed` 并带上原因,保留更早的引擎,下次启动再试一次;提示里的重试走确认框。退出会中止下载,同样保留引擎。这次启动里更早的引擎还在盘上时,对任何一次下载(升级自己的那次或重试那次)的 `POST /cancel`,以及在重试的确认框里拒绝,都是用户拒绝这次升级:管理器在应答之前就删掉更早的引擎,所以即使应用在 pnpm 退出之前就退出(退出不等它),下一次下载也先询问。正在跑的安装不往那个目录里写任何东西:pnpm 写在 `.staging-*` 下,改名的目标是声明的版本。下载还没开始的升级立即结束,读作 `absent`。没能弹出的确认框不算拒绝。
- **声明的版本没登记时保留更早的引擎。** 需求读作 `unsupported`,什么都不下载,引擎留给之后登记了这个版本的构建。`RequirementResult` 的拒绝分支在版本旁边带上声明的包名,找更早的引擎要用到它。
- **打包带的 kit 由闸门钉住。** `scripts/office-engine-gate.ts` 里的 `DESKTOP_ENGINE_HOSTS` 写明每个桌面主机要带的引擎版本(两个都是 0.1.5),暂存的 kit 声明了别的版本时打包停下,所以版本只在有人调高这个值时才变。

## Alternatives considered

- **kit 每变一次就再问一次** —— 变化跟着部署运行的时间走,不是谁的决定,而用户回答过的那个对话框已经说过组件会留下。
- **在数据目录下或桌面状态里持久化一份同意记录** —— 它重复了更早的引擎目录已经表明的事实,还得和它保持一致:手动删掉的引擎会留下一条对已不存在的引擎的同意记录。
- **在服务端就绪之前开始下载** —— pnpm 的 registry 请求和解包(Windows 上还有 Defender 扫描)会和服务端启动、第一次页面加载同时进行。
- **升级从 `absent` 开始,让页面之后自己发现** —— 提示只读一次状态,所以在重新加载之前会一直给出一个服务拒绝的下载。
- **只下载变了的字节** —— 0.1.3 与 0.1.5 的 737 个文件里有 724 个相同,但它们只占 11.9 MB;引擎构建在字节层面不可复现,可执行文件每版都不同。zstd 差分能把 67 MB 的下载降到约 8 MB,但 npm 校验的是整个压缩包,差分得放在我们自己的服务器上,还要用一套新的逐文件信任根取代压缩包的 sha512。
- **用 `pnpm-workspace.yaml` 的 `overrides` 钉住 kit** —— 部署就会解析到指定的版本,但那是上游的文件,钉住就成了核心补丁,还会改写工作区锁文件;闸门不用这两样也能拦住计划外的版本变化。

## Consequences

- 引擎版本每变一次,用户就不被询问地把新引擎下载一次,macOS 64 MiB、Windows 68 MiB,任何网络上都会下:Electron 在两个平台上都不报告按流量计费的连接,应用自身的更新也是这样下载的。
- 升级完成之前,或一直失败期间,更早的引擎留在盘上;下载期间暂存目录和它的包仓库再占差不多同样大小,完成后只剩一个引擎。
- 升级在被启动的那个构建里运行,所以只覆盖更新到带有它的构建。rc.36 及更早的构建启动时仍删掉其它所有版本:退回它们会再问一次,rc.35.1 → rc.36 这一步也会。两个都带有它、但声明不同版本的构建在同一个数据目录上每切换一次,就不询问地重新下载一次。
- 升级期间,提示显示的是首次下载的文案;专门的文案要改插件仓库。
- 钉住的版本只能手动调。更新的 kit 发布满一天后,重新部署会在闸门处停下,直到有人登记它的引擎并调高钉住的版本。用 `--skip-deploy` 复用一份保存下来的暂存能保住版本,但那份暂存也带着它那次部署的工作区包、客户端 bundle 与 vendored 插件,所以只适合在壳之外什么都不改的重新打包;其他发版都得调高钉住的版本,或用 `overrides` 钉住 kit,而那是 core patch。

## Related

- `apps/desktop-shell/src/office-engine.ts`(`supersededEngine`、`versionsToKeep`、`pruneEngineRoot`)、`office-engine-service.ts`(`beginUpgrade`、`runUpgrade`、`cancel`)、`main.ts`(`startOfficeEngineForServer`,以及启动闸门之后的 `runUpgrade` 调用)、`scripts/office-engine-gate.ts`(`DESKTOP_ENGINE_HOSTS`)
- `apps/desktop-shell/tests/office-engine.spec.ts`、`office-engine-service.spec.ts`、`office-engine-gate.spec.ts`
- `apps/desktop-shell/README.md` 的「Office 引擎服务」
- [桌面按需下载 LibreOffice 引擎](../feature/2026-09-27-desktop-office-engine-on-request.zh.md)
