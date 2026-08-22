# Agent Note: 被中断的更新下载先重试,而不是就此认输

Status: implemented

[English](2026-08-21-desktop-update-download-retry.md) | 中文

## Problem

下载途中断一次连接,整个会话的更新就到此为止;在 macOS 上,这次下载所在的那一层也一起没了。

electron-updater 既不重试也不续传。全量下载不发 `Range` 头,而 `AppUpdater.executeDownload` 抛出的任何错误都会走 `removeFileIfAny`:删掉半截文件,并经 `DownloadedUpdateHelper.clear` 清空 pending 目录。差量路径救不了这件事:它按块用 `Range` 请求取产物,一块失败整轮 reject,`differentialDownloadInstaller` 把异常吞掉并返回 true,于是同一次调用退化成全量下载;而且它只在 `<cacheDir>/update.zip` 已经存在时才会运行,全新安装后的第一次更新永远不满足这个前提。没有超时或重试选项可设,`httpExecutor` 也不是有文档的扩展点。

这套库行为要付多少代价,由壳决定,而[更新通道](../feature/2026-08-19-macos-in-app-update-self-signed.zh.md)对所有失败给的是同一个动作。`apps/desktop/src/updater.ts` 的 `error` 监听器关掉进度窗、清掉任务栏进度,并在 darwin 上对任何错误一律调用 `demoteMac`。同一个失败随后让 `downloadUpdate()` reject,走到 `runCheck` 的内层 catch,再降级一次,并在同一个 tick 里把这次检查改到下载页那一层重跑。一次被中断的传输,在启动检查或手动检查上看得见的结果就是一个「去下载」对话框,请用户去浏览器下载一个应用本来就装得了的构建,外加 `macInstallUnavailable` 在本次运行剩余时间里一直立着,于是这个会话里后面的每次检查也都移交给浏览器。Windows 上没有降级,但 pending 目录照样被清空,而这次检查什么也不说就结束了。

下载能结束在两类失败上,这两类并不一样,而通道把它们当成了一样:连接被切断,并不说明这个构建能不能替换自己;而签名被拒或校验和不匹配,说的恰恰就是这件事。

## Decision

被中断的下载会再试——按 2 秒、6 秒、18 秒再试三次——之后才由界面报告;而只有「再装一次也不会变」的失败,才把 macOS 从就地安装那一层拿下来。

### 策略单独成模块,里面没有 electron

`apps/desktop/src/download-retry.ts` 装着整个判断:`classifyDownloadError`、`describeDownloadError`、`RETRY_DELAYS_MS`,以及 `withRetry(run, delays, { onRetry, sleep })`——`sleep` 由调用方注入,于是这套计划可以对着一只瞬时时钟跑测试。`updater.ts` 与 `progress-window.ts` 引入 electron,做不了单测;而策略里没有任何东西非待在那儿不可。

`withRetry` 每次尝试调用一次 `run`——每次尝试都是一整个下载,因为上一次什么都没留下——并以最后一次尝试失败时的那个错误 reject,无论是失败本身致命,还是计划用尽。调用方再对这个错误分类一次,决定自己那块界面怎么办。

### 什么会重试

分类器是 fail-closed 的:只有匹配上已知网络状况的失败才算 transient,其余一切——包括根本不是 `Error` 的值——都算致命。因此一个不认识的失败会结束这次下载,而不是凭猜测把几百兆再传三遍。

| 判定 | 失败 |
|---|---|
| `transient` | `ECONNABORTED`、`ECONNREFUSED`、`ECONNRESET`、`EAI_AGAIN`、`EHOSTUNREACH`、`ENETDOWN`、`ENETRESET`、`ENETUNREACH`、`ENOTFOUND`、`EPIPE`、`ESOCKETTIMEDOUT`、`ETIMEDOUT`;任何点名 `net::ERR_…` 原因的消息——Electron 的 `net` 模块就是这样报告每一次失败的,而下载正跑在这个执行器上;`HttpExecutor` 的 `Request timed out` 与 `Request has been aborted by the server`;Node 的 `socket hang up`;5xx、408、425 或 429,无论它以 `HttpError` 的 code 形式到达,还是写在 `doDownload` 的 `Cannot download "<url>", status <n>` 文本里 |
| `fatal` | 任何 `ERR_UPDATER_*` code,`ERR_UPDATER_INVALID_SIGNATURE` 也在其中;`DigestTransform` 抛出的 `ERR_CHECKSUM_MISMATCH`;其余的 4xx;`Too many redirects`;磁盘写满;以及一切不认识的失败 |

`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` 包的是检查阶段的网络故障,在这里被判为致命,而这是对的:分类器只对 `downloadUpdate` 的失败负责——`checkForUpdates` 失败有它自己的层级回退。最后这半句判错了那个回退的代价,[检查重试那篇](2026-08-22-desktop-update-check-retry.zh.md)取而代之:检查路径的回退会把 macOS 降级到本次运行结束,所以检查现在也走这同一个分类器,并配有自己的重试计划。

### 下载只从一处开始,失败的含义也只在一处判定

`updater.ts` 有三个下载入口——用户同意的那次征询、会话中途的强制下载、以及启动阻断——现在三个都走 `download(host, version, run)`。它在整段传输(含重试)期间掌管 `downloading`、进度窗与任务栏进度,于是这三个入口的差别只剩下各自记什么日志、拿到答案后做什么:

- **完成**——交给 `update-downloaded`,不变。
- **transient,计划用尽**——返回 false。什么都不降级,层级不变,下一次定时检查从头再传一遍。手动检查会拿到一个对话框,说明下载没有走通;静默检查只留一行日志。
- **致命**——降级 macOS 并重新抛出,经由 `runCheck` 原有的 catch 把这次检查落到下载页那一层。这一类失败的行为,通道一直就是这样。

`ERR_UPDATER_INVALID_SIGNATURE` 在两个平台上都是致命的,所以一个由别人签名的 Windows 安装程序绝不会被寄望「再下一次就不一样了」而重下。

`downloading` 为真期间,`error` 监听器退场。这个失败会被送达两次——一次给监听器,一次给 await 着 `downloadUpdate()` 的那一方——而 `download` 才是能判断它含义的那一半;在监听器里动手,等于关掉重试马上要往里写的那个窗口,并为一个丢掉的包把层级降下去。`downloading` 为假时,监听器做的还是它一直做的事,也就是 Squirrel 内部失败浮上来的地方:暂存与安装发生在本模块 await 的每个 promise 都已敲定之后。

`blockWithInstaller` 保留它的「重试」/「退出应用」对话框,而它出现在自动重试之后而不是取而代之——这个按钮是给熬过了 26 秒尝试的故障准备的,按下去会重新进入整套计划。

### 窗口说什么

`progress-window.ts` 在进度条下面多了一行状态,以及 `showRetrying(attempt, total, delayMs)`,往里写「下载中断,N 秒后重试(n/N)…」。重试期间窗口不关:传输是从零重来的,关掉再开会成为屏幕上唯一看着像进展的东西。下一个 `download-progress` 采样会清掉这行,所以恢复的下载不需要另一次调用来撤掉提示;这行也和最后一个采样一样被记着,于是被用户关掉、又被手动检查重开的窗口,回来时说的还是同一句话。

## Alternatives considered

**壳自己实现可续传的下载器。**唯一能让重试从「有上限」变成「便宜」的设计:用我们自己的 `Range` 请求取产物,保留半截文件,把一个已完成的下载交给 electron-updater。对连接糟糕的客户端来说这是正确答案,而它不是这次改动,因为它必须复刻 electron-updater 在肯装之前会校验的那套私有布局——`pending/` 目录、`update-info.json`、清单发布的 base64 sha512——这些都不是有文档的契约,而且一个小版本就可能在我们脚下改掉它们。做它的条件是证据:如果这套计划上线后仍有可观比例的下载失败,那个失败率就是自己接管传输的理由。

**子类化 `MacUpdater` 或替换 `httpExecutor`。**重试会落在传输所在的位置,那本来是它天然该待的地方。`httpExecutor` 不是扩展点——它在构造函数里赋值,类型标为内部——而 macOS 上要覆写的那个方法 `updateDownloaded` 是私有的,还会伸手去动这个类同时持有的本地代理服务器。子类会被钉死在一个本产品并不掌控的库的某个补丁版本上。

**一直重试到成功,延迟逐次拉长。**一直失败的下载,通常是更新源或那台机器在接下来几分钟里不会好起来,而无上限的计划会把强制启动阻断——它在应用打开之前就下载——按住到故障结束为止。三次尝试摊在 26 秒里,足够覆盖一次 Wi-Fi 切换、一次路由变更、一次 nginx 重载;再往后,下一次定时检查比第四次尝试更适合当重试,因为等它对用户不花任何代价。

**给延迟加抖动。**对付惊群是标配做法,而这里没有群:更新源是一个静态 nginx 目录,它的客户端按各自的启动时间与四小时定时器检查,重试本来就是散开的。固定延迟让这套计划在日志里和测试里都可复现。

**把不认识的失败判为 transient。**这样确实会有更多下载最终成功,而每个不认识的致命错误都要再赔上三次整包传输和 26 秒,才说出同一件事。fail-closed 也让分类器保持诚实:值得重试的失败要在上面那张表里占一行、配一条测试,而不是靠默认值混进来。

## Consequences

被网络中断的下载,代价从「本会话的更新通道」变成几秒钟,而 macOS 在整个过程中保住就地安装那一层。装不了的构建在第一次尝试就降级,所以下载页兜底照样不用等。

代价是连接真的死了时的墙上时间:强制启动阻断现在要花掉最多 26 秒外加四次传输尝试,才给出「重试」/「退出应用」;普通检查也要花同样的时间才转入沉默。每次尝试都重传整个产物,所以一个在大文件下载后段才断的连接,要为此多付三次带宽。这里没有任何东西让更新变成可续传,而全新安装之后的第一次更新无论如何都是全量下载,因为差量路径需要缓存目录里已有上一版的 `update.zip`。

`apps/desktop/tests/download-retry.spec.ts` 钉住上面那张表里每一行的分类、不认识即致命这条默认、对着注入时钟的延迟序列与 `onRetry` 上报、计划用尽时以最后一个失败 reject,以及致命失败既不重试也不等待。`updater.ts` 与 `progress-window.ts` 引入 electron,不做单测;它们承载的是模块测试看不见的接线,而更新通道没有快照泳道——它跑在打包后的 Electron 壳里,对着一个活的更新源,所以它的证据是一个已签名的构建和一次真实的中断下载。
