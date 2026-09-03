# Agent Note: 把 electron-updater 的 debug 通道挡在 dsh-server.log 之外

Status: implemented

[English](2026-09-03-updater-log-hygiene.md) | 中文

## 问题

产生了[多段响应那篇 Agent Note](2026-09-03-updater-multipart-uncaught-exception.zh.md)里那个崩溃框的那台 Windows 客户端，同时也发回了它的 `dsh-server.log`。一次从 0.1.0-rc.24 到 0.1.0-rc.28 的更新往这个文件里写了约 700 行，而这次更新是成功的。

这 700 行有两个来源。electron-updater 的 `debug` 通道把差量下载的整份计划倒了出来——`DifferentialDownloader` 写的是 `JSON.stringify(operations, null, 2)`，每个分块一个 `{ kind, start, end }` 对象，约 650 行——后面跟着 `downloadPlanBuilder` 每发现一个在 blockmap 里重复的校验和就写的一行。而差量下载自己那次已被处理的失败，被记成了 `[updater] error: Cannot download differentially, fallback to full download: Error: net::ERR_CONNECTION_RESET` 加一段堆栈，因为外壳把这个通道原样透传了。

这一整块内容没有一处是错的。回退正是 electron-updater 该做的事，随后的全量下载也把更新装上了。但 `dsh-server.log` 正是支持人员要用户发回的那个文件，而它装着的是关于一次成功更新的 700 行，顶上还带着 `error` 字样和一段堆栈——用户就是把这一块当成崩溃粘进了聊天里。

## 决策

[`apps/desktop/src/updater-log.ts`](../../../../apps/desktop/src/updater-log.ts) 掌管 electron-updater 被允许写下什么。`updaterLogLine(channel, message)` 渲染出一条记录，或者返回 `null`，[`src/updater.ts`](../../../../apps/desktop/src/updater.ts) 用它拼出 `built.logger`——整个决定就是一个纯函数，跑起来完全不需要 electron。

`debug` 通道返回 `null`，只留两行例外。6.8.9 里走这个通道的东西分三类。差量下载自己的痕迹：计划倒出 `JSON.stringify(operations, null, 2)`（`DifferentialDownloader.js:41`）、每发出一个范围就写一行的 `download range: bytes=a-b`（`DifferentialDownloader.js:184`），以及在 blockmap 里每发现一个重复校验和就写的一行（`downloadPlanBuilder.js:100`）。`MacUpdater` 的 Squirrel 痕迹：代理的关闭、创建、监听那几行（`MacUpdater.js:44`、`:47`、`:129`、`:131`、`:208`、`:210`），以及决定一台 Mac 取哪个产物的那两次探测（`:59`、`:69`）。还有两行自成一类：`checkForUpdatesAndNotify called, downloadPromise is null`（`AppUpdater.js:290`），外壳根本产不出它，因为外壳不调那个方法；以及 `updater cache dir: <path>`（`AppUpdater.js:552`）。前两类里没有一行给出版本、URL、大小或失败，所以它们回答不了支持人员会问的问题，合起来反倒把真正回答问题的那几行埋了。差量下载真正值得知道的东西，从同样这两个文件走 `info` 通道，被保留下来：`downloadPlanBuilder` 的 `File has <n> changed blocks`，以及 `DifferentialDownloader` 的 `Full: <size>, To download: <size> (<percent>%)`。

有两行 `debug` 被保留，按消息开头匹配：`updater cache dir: <path>` 与 `nativeUpdater.update-downloaded`（`MacUpdater.js:24`）。两者都写成 `[updater] debug: <text>`，保留 `warn` 与 `error` 本来就带的通道标记，这样文件里的一行仍然说得出自己是哪个通道写的。两者在 `info` 或 `warn` 上都没有对应物，而且各自回答了日志其余部分留下的一个问题。差量下载需要上一版产物就躺在那个缓存目录里，所以这个路径正是「这次更新为什么整包传了」的解释。那行 Squirrel 消息是原生更新器把一次 macOS 更新暂存完毕的唯一记录，而且它伴随的 `squirrelDownloadedUpdate` 标志决定 `quitAndInstall()` 走哪一支（`MacUpdater.js:241`）——是立刻安装，还是等一个事件。`debug` 是注册出来的而不是干脆不设，因为上游每一处调用它都有 `!= null` 守卫：不设就会连这两行一起丢掉，而且会让映射变成代码里三个通道、第四个靠一个缺席的属性表达。

`info`、`warn`、`error` 按它们原有的前缀透传，只有一处改写。`error` 通道上以 `Cannot download differentially, fallback to full download: ` 开头的消息，会变成

```
[updater] differential download unavailable (net::ERR_CONNECTION_RESET); this update transfers the whole artifact
```

——取前缀之后那段文字的第一行，去掉它的类名，并截到 320 个字符，句式沿用外壳自己那些行已有的写法（`[updater] in-place update unavailable (…); this run falls back to the download page`）。这个上限放得下上游能产出的最长首行，也就是 `DigestTransform.validate` 抛出的那条 217 字符的 `sha512 checksum mismatch, expected …, got …`。堆栈被丢掉，`error` 字样也一起丢掉，因为这是那个通道上唯一一条报告「更新器已经自行恢复过来的失败」的行：`AppUpdater.differentialDownloadInstaller` 在 `catch` 里记下它（`AppUpdater.js:705`，macOS 经 `MacUpdater.js:102` 到达，Windows 经 `NsisUpdater.js:49` 到达），然后用全量下载把更新走完；`NsisUpdater.js:170` 与 `AppImageUpdater.js:67` 则为 web 安装器和 AppImage 两条路径记下同样的文本。它并不是那里唯一一条本身不是失败的行——`closeFiles` 在成功路径上也会通过 `logger.error` 报 `cannot close file "<path>": <e>`（`DifferentialDownloader.js:66`）——但它是唯一一条带堆栈的。其他每一条 `error` 消息都原样完整写出。

## 测试

[`apps/desktop/tests/updater-log.spec.ts`](../../../../apps/desktop/tests/updater-log.spec.ts) 直接驱动这份映射，用的文本取自 6.8.9——固定串照抄，模板则按它的写法填出来。`debug` 上：计划倒出、一行 blockmap 重复项、一行 `download range:` 和一行代理消息被丢弃，而那两行保留项活下来，一条只是「包含」它们文本的消息则不然——这一例正是把匹配钉在开头的钉子。其他通道上：两行 `info` 概要和一条普通 `warn` 带着各自前缀留下，`error` 上的一段 `ENOENT` 堆栈和一条 `status 503` 消息原样通过。回退前缀之下：一段渲染好的堆栈变成上面那一行，`DifferentialDownloader.js:36` 抛出的 `version is different (…)` 那个 `Error` 被摘掉类名，本来就没有类名的原因、以及一个根本不是 `Error` 的被抛值都原样通过，一条按 `createHttpError` 的拼法造出来的 `HttpError`（`builder-util-runtime/out/httpExecutor.js:52-57`）收成 `503 Service Unavailable`——因为它的描述块和头部倾倒都在首行分割早已切掉的那几行上，217 字符的校验和不符连两段摘要一起完整通过，而一条人造的 400 字符首行被截断。`Full: …` 与 `File has … changed blocks` 这两例，正是「丢掉 `debug` 不会损失任何差量下载概要」这一主张的钉子；这个主张的依据是 `node_modules` 里那两处 `logger.info` 调用点。

## 考虑过的替代方案

**把 `debug` 放在一个开关后面。**详细日志开关总是在需要它的那次失败发生之后才被打开，从来不是之前，于是唯一会带上这些额外行的日志，恰恰是已经发出去的那一份。它还会为一批至今没回答过任何支持问题的输出，添出一个设置项。

**干脆不设 `debug`。**上游每一处调用点都带 `!= null` 守卫，所以不设会把这里保留的那两行连同其余一起丢掉。而且这样映射里只写三个通道，第四个由一个缺席的属性决定，读起来像疏漏而不像决定。

**把回退那一行也丢掉。**它是「曾尝试差量下载但没走成」的唯一记录，而这恰恰是一次增量很小的更新为什么走了整包传输的解释。

**改成给每条过长的 `error` 消息截断。**那个通道上其他消息在被记下来的时候都还是没解决的失败，而支持人员要诊断的失败是要看全的。回退之所以被单独挑出来，正因为它到达日志时更新器已经自行恢复过来了。

**改在 `src/updater.ts` 的 `error` 事件监听里。**回退根本到不了那个监听器：它在 electron-updater 内部被 `catch` 住，只是记了日志，所以外壳只能在 logger 上看到它，别处都看不到。

## 后果

一次原地更新的支持日志，现在装的是检查、提示、缓存目录、给差量下载定尺寸的那两行 `info`、重试、macOS 上 Squirrel 的暂存记录，以及安装——还有在差量路径让位的地方，说明原因的一行。代价是：一次产出错误产物的差量下载，不会在文件里留下分块级别的记录。接住错误产物的是 `DifferentialDownloader.js:121` 那个 sha512 `DigestTransform`，而它抛出的 `ERR_CHECKSUM_MISMATCH`（`builder-util-runtime/out/httpExecutor.js:431`）就是在 `differentialDownloadInstaller` 自己的 `try` 里抛出的，落进同一个 `AppUpdater.js:705` 的 catch——所以校验和不符同样出现在被改写的那一行上，随后这次更新整包传输。让那条消息的两段摘要在那里完整留存，正是 320 字符上限的用处。

这次改动只收拾了回退那一行，`error` 上别的什么都没动。`AppUpdater` 在自己的构造函数里挂了一个 `error` 监听，对每一个被派发的错误都记下 `Error: ${error.stack || error.message}`（`AppUpdater.js:201-203`），而 `downloadUpdate` 的 `errorHandler` 会把每一个不是 `CancellationError` 的失败派发出去（`AppUpdater.js:449-460` → `:476-478`）。于是一次 `net::ERR_CONNECTION_RESET`，哪怕 [`src/download-retry.ts`](../../../../apps/desktop/src/download-retry.ts) 下一次尝试就恢复了，仍会从 logger 那里留下一行带堆栈的 `[updater] error:`，外壳自己在 [`src/updater.ts`](../../../../apps/desktop/src/updater.ts) 里的 `error` 监听还会在旁边再写一行。差量回退不在这一对里面：它只被记日志，从不被派发，这也正是它能在 logger 上被改写、而那两行不能的原因。

这处改写钉在一条不带 code 的上游消息上，所以某个改了措辞的 electron-updater 版本会让改写失效、把原始行透传出来——这是看得见的，不是无声的。保留下来的那两行 `info` 概要不钉任何东西：那两处调用点写什么文本，就透传什么文本。
