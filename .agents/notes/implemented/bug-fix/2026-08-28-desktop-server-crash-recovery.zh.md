# Agent Note: 从启动后内置服务器死掉的状态中恢复

Status: implemented

[English](2026-08-28-desktop-server-crash-recovery.md) | 中文

## 问题

在某客户的 Windows 机器上（rc.24），内置 `dsh web` 服务器子进程在启动完成之后的某个时刻悄悄死掉了。`apps/desktop/src/server.ts` 和 `main.ts` 里,一旦 `startServer` 完成 resolve,就没有任何代码继续持有这个子进程的退出监听,于是死亡这件事没有被记录下来,也没有任何东西把它重新拉起。窗口停留在最后渲染出来的样子——一个看起来正常、实则彻底冻结的页面——与此同时 `notifications.ts` 的两条下行 WebSocket 一直按固定 3 秒的间隔去重连一个再也回不来的服务器:33 分钟内写了 1318 行日志,每次重试两行,第一对之后再没说过任何新内容。

## 决定

**验尸(`server.ts`、`main.ts`)。** `ServerHandle` 新增 `onExit(listener)` 方法;`startServer` 现在维护一个有界的滚动尾部(`RECENT_OUTPUT_TAIL_LINES` = 15,在子进程整个生命周期内持续喂入,而不是此前只在 URL 出现之前使用的那个无界 `collected` 字符串),以及一个 `stop()` 在向子进程发信号之前就置位的 `expectedExit` 标志。通过 `onExit` 注册的监听器会收到一次 `{ code, signal, expected, tail }`——如果子进程此前已经退出,则同步收到。`main.ts` 的 `attachSupervision()` 对每一次 `expected` 为 false 的退出都记录一行 `[desktop] server exited unexpectedly: code=<code> signal=<signal>` 加上尾部日志,并把它交给恢复阶梯;而一次预期内的退出(`stop()`——退出流程、强制更新闸门、以及每一次重绑都会走到这里)不会额外记录任何东西。

**恢复阶梯(新模块 `apps/desktop/src/server-supervision.ts`)。** 一个纯 reducer——`onUnexpectedServerExit`、`onRebindFailed`、`onRebindSucceeded`,作用在 `{ recentUnexpectedExits, rebindFailures }` 这个 `SupervisorState` 上——只凭普通的时间戳就能决定下一个 `SupervisorAction`(`recover` / `relaunch` / `stop`),自己不持有时钟或定时器。`runRecoveryLadder` 是唯一面向调用方的入口:给定阶梯的当前状态、`now`、这个进程本身是否就是一次 L1 重启,以及 `RecoveryHooks`(`rebind`、`sleep`、`notifyRecovering`——和 `download-retry.ts` 的 `withRetry`/`RetryHooks` 已经在用的同一种注入式 hooks 形状),它驱动完这一次退出的整个结果。

- **L0** 原地重绑:`REBIND_DELAYS_MS` = `[1_000, 5_000, 15_000]`,即最多 3 次尝试。`main.ts` 的 `performRebind()` 是唯一的 `rebind` 实现,阶梯和 L2 的手动重试共用它:用记录下来的 `activeServerSpec` 调用 `startServerWithQuarantine`,成功后重新赋值模块级的 `server`、调用 `retargetWindows()`(对每一个 `isResizable()` 判定为已渲染服务端 UI 的 `BrowserWindow` 调用 `window.loadURL`——和 `main-window.ts` 已经在用的同一个判别式)、对新 URL 再次调用 `setupNotifications`,并把监管重新挂到新的子进程上。
- **L1** 整应用重启一次:`REBIND_DELAYS_MS` 耗尽的 3 次失败重绑尝试,**或者** `UNEXPECTED_EXIT_WINDOW_MS`(10 分钟)内出现 `UNEXPECTED_EXIT_ESCALATION_COUNT`(3)次意外退出——即便每一次重绑都成功了,第二个条件依然会触发,因为一个每隔几分钟就死一次的服务器是在反复抽风,不是偶尔绊了一跤,而每一次成功的重绑本身就已经是一次可见的打断。`relaunchForRecovery()` 先把 `quitting` 置为 `true`(这样 Windows 托盘的关闭拦截就不会在 `app.quit()` 关窗口的过程中插手——这与 `before-quit` 自己抢先置位 `quitting` 是同一个道理),再调用 `app.relaunch({ args })`,把 `RECOVERY_RELAUNCH_FLAG`(`--dsh-recovery-relaunch`)追加进 argv,然后调用 `app.quit()`——而不是 `app.exit()`——好让原有的 `before-quit` 收尾(关闭本地回环服务)照常跑一遍。
- **L2** 停止自动恢复:一个恢复重启实例(`isRecoveryRelaunchInstance(process.argv)` 判定)如果在自己启动后的 `L2_GUARD_WINDOW_MS`(2 分钟)之内又遭遇一次意外退出,直接进入 `stop`,完全跳过 L0。`runStoppedDialog()` 弹出一个原生的 `type: 'error'` 对话框——「后台服务多次崩溃,已停止自动恢复」,按钮是「重试」/「打开日志」/「关闭」——并循环:「重试」调用一次 `performRebind()`,只有失败时才会再次弹出对话框;「打开日志」揭示日志文件,并且总是会再次弹出对话框;「关闭」结束循环并返回,让后端保持关闭、不再自动尝试任何东西,并记一行日志(`user dismissed the crash dialog; backend stays down`)。`STOPPED_DIALOG_CANCEL_INDEX`(`server-supervision.ts`)是「关闭」在 `STOPPED_DIALOG_BUTTONS` 里的下标,把它作为 `cancelId` 交给对话框,这样 Esc 以及任何不点按钮就关掉对话框的方式,都会落在「关闭」上,而不会落在一个读起来像是用户主动要求重试或要看日志的按钮上——一次“打发掉”对话框的动作,永远只能是给用户一个出口,而不能变成继续纠缠。`classifyStoppedDialogAnswer(responseIndex)` 是从对话框自身的 `response` 到 `'retry' | 'open-log' | 'dismiss'` 的纯映射。这里没有任何地方会再调用 `app.relaunch`,所以也就不存在需要设界的重启循环;而“打发掉”对话框这件事,现在也和点「关闭」一样,会把对话框循环结束掉。

**重连退避(`notifications.ts`)。** 固定的 3 秒重试变成指数退避——`reconnectDelayMs(attempt) = min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_BACKOFF_FACTOR ** (attempt - 1))`,3 秒 → 6 秒 → 12 秒 → 24 秒 → 48 秒 → 封顶 60 秒,一旦某次连接真正打开过、之后才关闭,就重置回第 1 次尝试。只有第一次尝试和之后每第 `RECONNECT_LOG_EVERY`(10)次才写一行日志,并且现在带上了尝试次数。改换目标复用的是同一套关闭/重开机制:`setupNotifications` 可以安全地被再次调用——它会先停掉当前活跃的那个 `Generation`(`{ stopped, sockets }`,关闭它的 socket;任何仍在飞行中的重连定时器,等真到触发那一刻会看到自己的 `stopped` 标志而直接空转)再打开新的一个,而 `app.on('browser-window-focus', …)` / `app.once('before-quit', …)` 这两个钩子只会绑定一次——由一个模块级的 `appHooksBound` 标志把关——所以第二次调用 `setupNotifications`(每一次 L0/L2 重绑都会触发)不会把它们重复绑上去。

**断线提示条:没有实现。** `ConnectionState`(`'connected' | 'reconnecting'`)由 `packages/client/connection` 的 `ConnectionController` 产出,消费方只有 `packages/client/runtime/src/client/index.ts` 里的 `onStateChange` 处理器——它在 `'reconnecting'` 时只调用 `sessions.handleDisconnected()`,再没别的动作了;和会重新 `ctx.emit('connection/reset')` 的 `onConnected` 不同,这里没有任何客户端事件或会话层可读字段把这个状态继续往外传。没有它,任何 fork 自有的界面层(`apps/web`、桌面端自己的 preload/renderer,或某个内置插件)都无法观察到这个状态。`packages/client/runtime` 属于上游 `packages/*` 的地盘,在这条 fork 分支上不能动;提示条被搁置,直到那个包把这个状态重新 emit 出来(例如在既有的 `connection/reset` 旁边加一个 `ctx.emit('connection/state', state)`),这需要走 core-patches。

## 权衡过的备选方案

**用 `vi.useFakeTimers()` 给阶梯写测试,直接驱动 `main.ts` 自己的定时器。** 否决:`main.ts`(和这个包里每一个碰 Electron 的模块一样——包括 `notifications.ts`、`tray.ts`、`updater.ts`)在这个代码库里本来就没有单元测试;它自身的真实进程行为,是靠桌面应用的开发模式实跑来验证的。把阶梯抽成 `server-supervision.ts` 里的一个纯 reducer 加一个由 hooks 驱动的编排函数(`runRecoveryLadder`)——和 `download-retry.ts` 已经确立的形状一样——让决策逻辑可以用普通的注入式 `sleep`/`rebind` 函数做单元测试,同时把 `main.ts` 留成按惯例不测的薄胶水代码。

**用环境变量作为 L1 的标记,依赖 `app.relaunch` 拉起的新进程继承它。** 否决,改用 argv flag:`app.relaunch({ args })` 是把信息带给下一个实例的、文档化的显式机制;依赖 Electron 重启时的进程恰好会做怎样的环境继承,是这个决定不该去依赖的未言明行为。

**只在重绑尝试耗尽时才升级到 L1,不看原始的意外退出次数。** 否决:一个服务器死掉、重绑成功、又死掉、又重绑成功、第三次又死掉的过程,从来不会让单独一轮 L0 序列耗尽,但这恰恰就是 L1 存在的目的所要应对的反复抽风场景。`onUnexpectedServerExit` 会统计 10 分钟窗口内的每一次意外退出,无论跟在它后面的那次重绑是否成功。

**从 `apps/web` 这一侧绕开缺失的 `ConnectionState` 缝——比如轮询 `document.title` 或者刮取 DOM 拼一个断线提示。** 否决:这次任务的落位规则说得很明确,一个需要上游缝的横幅要如实上报,而不是绕开去将就实现;而且一个刮 DOM 拼出来的提示条,一旦它所依赖的上游标记结构变了,也会悄无声息地坏掉。

## 后果

一次意外的服务器死亡,现在总会在日志里留下自己的一行,带着服务器临终前说的最后几句话;它会被自动重试,并伴有用户可见的反馈;如果重试一直失败,最终落到的是一个由用户来做的决定,而不是一个悄悄冻结的窗口、一个无限重启的循环,或者一个无限弹窗的循环。在这台机器上以开发模式、针对一个临时 `DSH_HOME` 做了实测验证:用 `SIGKILL` 杀掉服务器子进程,会产出验尸日志行、系统通知、在新端口上的重绑、两条通知流都重新连到新端口(通过对主进程和网络服务子进程跑 `lsof` 确认),以及窗口重新显示出服务端 UI;在窗口期内连杀三次,会产出带标记的 `app.relaunch`;在重启后的实例的 L2 保护窗口内再杀一次,会弹出原生对话框。它的三个按钮和 Esc 分别单独驱动过一遍(用 `osascript`/System Events 操作对话框的 sheet,在会结束循环的那两个动作之间重新走一轮完整的重启周期):「重试」成功完成一次手动重绑并关掉对话框;「打开日志」打开了日志(通过运行进程列表里出现了 Console.app 来确认),对话框会再弹出来;「关闭」和 Esc 则都会彻底关掉对话框、记下那行“打发掉”的日志,并让后端保持关闭、没有任何服务器进程在跑。

断线提示条本身没有交付——`packages/client/runtime` 的 `onStateChange` 处理器需要先把 `ConnectionState` 重新 emit 成一个客户端可观察的事件,fork 自有的界面代码才谈得上去消费它。`notifications.ts` 的重连日志量,从固定 3 秒一次、每次两行(现场事故的 33 分钟里累计 1318 行),降到第 1 次尝试两行、之后每第 10 次再两行,退避在服务器死掉大约两分钟之内就会封顶到 60 秒,而不是无限期地每 3 秒轮询一次。
