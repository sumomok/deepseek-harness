# Agent Note: Desktop shell: the intentional-stop sentinel for crash resume

Status: implemented

[English](2026-09-27-desktop-shell-crash-resume-sentinel.md) | 中文

## Problem

服务端插件 `@haoran/dsh-crash-resume` 会续跑被服务器崩溃打断的 turn,而被停止请求打断的 turn 则挂起。两种情况下会话日志都停在一个没关上的 turn 里,所以插件靠文件 `$DSH_HOME/crash-resume/intentional-stop.json` 判断:下次启动时文件在,就是停止;不在,就是崩溃。插件自己会在收到 SIGTERM 时写这个文件。Windows 上壳用 `taskkill /pid <pid> /T /F` 停服(`apps/desktop-shell/src/server.ts` 的 `killTree`),服务端一行代码都跑不了;壳里若没有写入方,Windows 上每一次退出和更新重启都会被当成崩溃,把被打断的 turn 续跑。

## Decision

`src/crash-resume-sentinel.ts` 导出 `writeIntentionalStop(home, reason, log)`。它写一行 `{"version":1,"at":<毫秒时间戳>,"by":"shell","reason":"quit"|"update"|"shutdown"}` 加换行,字段顺序与插件的 `formatSentinel`(插件仓库 `packages/crash-resume/src/state-files.ts`)一致,步骤照插件的 `writeAtomicSync`:递归 `mkdirSync`,在同一目录写临时文件 `intentional-stop.json.<pid>.<ms>.tmp`,`writeSync` + `fsyncSync`,`renameSync` 覆盖哨兵(rename 失败时删掉临时文件),除 Windows 外再 fsync 目录。用同步 API,保证停服指令发出前文件已落盘。任何失败都记一行 `[desktop] crash-resume sentinel: <message>` 后吞掉。

home 取壳自身 `process.env` 上的 `resolveHarnessHome()`,也就是 `startEmbeddedServer` 交给隔离扫描的那个;服务器子进程的环境是 `augmentedEnv(process.env)` 加上启动时追加的变量,追加的变量里从不含 `DSH_HOME`,所以服务器和插件默认的 `stateDir` 解析到同一个目录。

每次写入都经过 `src/server-lifecycle.ts` 的 `markIntentionalStop(handle, reason, target)`,它只在 `handle.exited()` 为 false 时写。`main.ts` 在恢复阶梯退避期间、以及停止对话框被关掉之后,都把已崩溃服务器的句柄留在 `server` 里,而之后都可能跟着一次退出或更新安装,所以判断看的是子进程,不是有没有句柄。调用点有三处:`stopServerForQuit`(reason 为 `quit`,在删 cookie 和停服之前;覆盖 `before-quit` 和更新安装器的 `prepareQuit`)、`stopForMandatoryUpdate`(reason 为 `update`,在强制更新拦住启动时的停服之前),以及会话结束监听(reason 为 `shutdown`)。操作系统关机、重启或注销算主动停止:Windows 上 Electron 不为它发 `before-quit`,而是报成每个窗口的 `session-end`;macOS 和 Linux 上报成 `powerMonitor` 的 `shutdown`;`src/session-end.ts` 在该事件里同步调用监听一次。别处都不写:`respondToCrash` 没有这个钩子;`relaunchForRecovery` 在 `app.quit()` 之前先置 `quitting`,所以 `before-quit` 不停服直接返回;`server.ts`——启动超时的 kill 和 `sweepOrphanedServers`——不引用这个模块。`tests/intentional-stop.spec.ts` 经 `startServer` 跑一个脚本化的服务器子进程:运行中停掉会留下哨兵,崩溃之后再退出或关机则不留。`tests/server-lifecycle.spec.ts` 断言 `main.ts` 里的三个调用点。

macOS 和 Linux 上插件收到 SIGTERM 时写这个文件,壳在发 SIGTERM 之前也写。两边都是把自己的完整文件 rename 到目标上,临时文件名因 pid 不同而不同,插件只读 `version`,所以第二次写入只是把一份有效哨兵换成另一份有效哨兵。插件的 `peekSentinel` 只检查 `version`,所以 `reason: "shutdown"` 在插件那边不需要改动。

## Alternatives considered

**只让插件写哨兵。**那只覆盖 POSIX;壳要写,原因就是 Windows。

**壳只在 Windows 上写。**所有平台走同一条代码路径,顺序测试在开发机上才有意义;macOS 上多写一次,代价是每次退出多一次小文件操作。

**异步写。**退出流程就得在 `taskkill` 之前 await 这次写入;同步写不改变停服顺序,延迟限于本地文件操作。

## Consequences

Windows 上退出或更新重启不再续跑被打断的 turn,插件把它挂起交给用户。写入失败的代价最多是下次启动多续跑一个 turn,退出不会因此多等文件操作以外的时间。没装插件时文件留在 home 里,一行,没人读。更新安装失败并重启服务器后,插件会读到安装前那次停服留下的哨兵,把那次停服打断的 turn 挂起。壳自己崩溃会留下没有哨兵的孤儿服务器,下次启动的孤儿清扫把它杀掉,它的 turn 按崩溃续跑。
