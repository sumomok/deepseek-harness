# Agent Note: 记录主进程崩溃，并在多段范围响应出错时 reject

Status: implemented

[English](2026-09-03-updater-multipart-uncaught-exception.md) | 中文

## 问题

一台 Windows 客户端在原地更新、更新包正在下载时，弹出了 Electron 自带的「A JavaScript error occurred in the main process」对话框，内容为 `Uncaught Exception: Error: net::ERR_CONNECTION_RESET`，而用户被要求发回的那个文件 `dsh-server.log` 里只有 electron-updater 自己的 `Cannot download differentially, fallback to full download` 一行。更新最终以全量下载完成；文件里没有任何内容表明屏幕上曾出现过崩溃对话框。

这里同时存在两个互相独立的缺陷。electron-updater 6.8.9 的 `out/differentialDownloader/multipleRangeDownloader.js` 在单段范围分支和 `DifferentialDownloader` 中都挂了 `response.on("error", reject)`，唯独在多于一个字节范围时走的多段分支里没有挂；于是被中断的多段响应会抛出一个没有监听者的 `error` 事件，而 Node 会从 emitter 处把它抛出来。同时，Electron 在 `lib/browser/init.ts` 中的默认处理器只弹这个框、不写任何记录，而且一旦应用注册了自己的处理器它就让位——这个外壳一个都没注册，所以每一次主进程异常都只被看见一次，却哪里都没有被记录。

## 决策

`patches/electron-updater@6.8.9.patch` 逐字携带 electron-builder 提交 `5eed26b2a9cfd06a1dbe207b25a46ce2c0b05ae9`（PR #10021）：在多段分支响应回调的第一条语句处加上一行 `response.on("error", reject);`。`pnpm-workspace.yaml` 在 `patchedDependencies` 下登记它，并在旁边写明退役条件——第一个携带该提交的 electron-updater 发行版；6.8.9 是当前最新发行版，早于该提交。

[`apps/desktop/src/crash-log.ts`](../../../../apps/desktop/src/crash-log.ts) 在 `main.ts` 打开的日志槽上注册外壳的 `uncaughtException` 与 `unhandledRejection` 处理器，位置紧接在该日志槽建立之后、更新器与服务器启动之前。异常会把 `[desktop] uncaught exception: ` 与渲染出的那个值写成一条记录，然后弹出 Electron 本会弹出的那个对话框：同样的标题，以及 `Uncaught Exception:` 加上同样的正文。对 `Error` 而言这段正文与 Electron 的完全一致——它的调用栈，没有栈时则是 `name: message` 那一行。抛出的值如果不是 `Error`，则按 `String(value)` 渲染，而 Electron 不是这么做的：它会从该值上读 `name` 与 `message` 并拼出 `undefined: undefined`，当值是 `undefined` 或 `null` 时甚至会在拼接过程中抛出。上报路径上没有任何一处碰 `Error` 的属性，因为上报时抛出的处理器会让 Node 结束进程且不留下任何记录。拒绝会写 `[desktop] unhandled rejection: …` 且不弹任何框，因为 Electron 对拒绝同样不弹框。两个处理器都不退出进程：Electron 的默认行为也不退出，而后台流上抛出的异常不应该终结一次会话。

启动链不会到达这两个处理器中的任何一个。`main.ts` 把启动过程放在 `app.whenReady().then(…)` 里，因此在它自己的 `try` 之上抛出的错误——启动窗口、日志目录、托盘——会变成该 promise 的拒绝，而 Electron 43 让主进程的拒绝运行在 `warn-with-error-code` 模式下：不上报的话，这样一次启动就停在一张空白的启动页上，任何地方都没有记录。因此该链以 `.catch` 收尾，通过导出的 `reportUncaughtException` 上报。它上报到的日志槽是在上报那一刻读取的，而在日志文件存在之前，那个槽会写到 stderr 而不是把这一行丢掉，所以启动过程中没有任何一处是沉默的。

这两半互相独立。补丁让这一种失败不再弹框；处理器让其他所有主进程异常——包括补丁未覆盖的那些——都能从日志中还原。

## 测试

[`apps/desktop/tests/electron-updater-multipart.spec.ts`](../../../../apps/desktop/tests/electron-updater-multipart.spec.ts) 从 `node_modules` 加载该模块，因此它检查的是打包后的应用真正运行的代码，而不是它的一份拷贝。测试用一个假的 HTTP executor 和一个 `PassThrough` 响应，把两个 `DOWNLOAD` 任务送进 `executeTasksUsingMultipleRangeRequests`，在该响应上发出 `error`，并要求这次 emit 不抛出、且 reject 回调收到了它。对未打补丁的 6.8.9，这次 emit 会抛出且没有任何 reject，这正是现场的失败。该套件是安全网而不是退役信号，因为无论那一行来自补丁还是来自更晚的发行版，它都保持通过；退役信号是 pnpm：`allowUnusedPatches` 与 `ignorePatchFailures` 都没有设置，一次让这条精确版本补丁变得无用或无法应用的升级会让安装失败。

[`apps/desktop/tests/crash-log.spec.ts`](../../../../apps/desktop/tests/crash-log.spec.ts) 针对会记录调用的日志槽与对话框注册，把两个处理器识别为 `process` 此前没有的监听者，并直接调用它们——用一个 `Error`、一个不带调用栈的 `Error`，以及会让读 `.message` 的处理器自己死掉的抛出字符串与抛出 `undefined`。`reportUncaughtException` 另有独立覆盖，因为启动链不经过任何注册就会调到它。每一次注册都走 `afterEach` 运行的那个共享释放器，因此断言失败也不会给测试运行器留下本套件的监听者。

## 考虑过的替代方案

**等 electron-updater 发行版。** 该修复在 2026-07-18 合入上游，至今没有发行版携带它；6.8.9 仍是最新。等待意味着每一次多段差分下载都只差一次连接中断就会弹出崩溃框，而这条通道的全部意义正是无人值守的更新。

**fork 或 vendor electron-updater。** 一行差异不足以让我们接管这个包的发布节奏；pnpm 补丁在上游发布的那一刻可以靠删除退役，而 vendor 的副本必须重新同步才能发现这一点。

**改在 [`src/updater.ts`](../../../../apps/desktop/src/updater.ts) 里处理。** 该事件是在 electron-updater 自己的回调内部由 emitter 抛出的；外壳订阅的任何东西都看不到它，而且更新器的回退当时已经执行——最终完成的正是它回退到的全量下载。外壳在这里没有可用的接缝。

**让已注册的 `unhandledRejection` 处理器覆盖启动链。** 它只有在处理器注册之后才会触发，而那已经在启动窗口与日志目录之后——这两步恰恰是最容易失败的——而且它只写一行、不弹框，于是一次彻底停住的启动只会把这件事说在一个还没人被告知去打开的文件里。显式的 `.catch` 覆盖整条链，并按其本来面目上报。

**记录未捕获异常后退出进程。** 那会改变本次修复刻意保留的可见行为：现场报告的崩溃让用户付出的是一个对话框，而不是这次会话；因后台流错误而杀掉外壳，会把一次可恢复的下载失败变成一次丢失的会话。

**把崩溃写进单独的文件。** 多一个文件就是多一样要向用户索取的东西。`dsh-server.log` 已经是菜单打开、支持人员索取的那个文件，而且这条记录会落在它前面那些更新器日志的同一条时间线上。

## 后果

传输中途被中断的多段差分下载会 reject 进 electron-updater 已有的回退路径，而这正是让现场那次恢复过来的路径；用户看到的差别是那个不再出现的对话框。桌面端的依赖闭包携带的是打过补丁的 electron-updater，因此 `pnpm-lock.yaml` 按补丁哈希钉住它，升到任何更晚的 6.8.x 都必须显式地重新应用或退役该补丁，而不会悄悄把它丢掉。

`dsh-server.log` 里有每一次主进程异常与拒绝，也有启动链的每一次失败。这条链上没有任何一处是沉默的：在日志文件打开之前，上报照样弹框，而它那一行写到 stderr。留在外面的是模块顶层、`whenReady` 之上抛出的错误——那里既没有日志槽也没有 `catch`，由 Electron 自己的处理器负责。这次注册的代价是两个进程监听者，在有东西抛出之前不做任何工作。
