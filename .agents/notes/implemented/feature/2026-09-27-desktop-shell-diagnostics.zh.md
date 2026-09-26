# Agent Note: Desktop shell diagnostics: crash records, server logger records, and update leftovers

Status: implemented

[English](2026-09-27-desktop-shell-diagnostics.md) | 中文

## Problem

0.1.0-rc.32 与 rc.33 的现场报告带回来的 `dsh-server.log` 说不清发生了什么。Windows 上以退出码 `3221226505` 死掉的服务器留下了 `server exited unexpectedly` 一行,但尾部停在解释死因的那几行之前:壳在子进程的 `exit` 事件上取尾部,而这个事件可能在子进程最后的输出还在管道里时就到了。V8 致命错误(首先是内存耗尽)在哪里都不留报告,因为没有任何东西让 Node 写一份。插件经 `ctx.logger` 写的每条记录——webserver 监听失败、`@haoran/dsh-auto-compact` 的命名 logger `ctx.logger('auto-compact')`、设置导入逐段的失败——都只进 logger 的内存缓冲区:产品组合没有挂任何 exporter,这些记录随进程一起消失。

更新通道还留着 rc.32 的两个缺口。帮助 → 检查更新 对失败的回答是「无法检查更新」加错误的原始信息,所以用户发来的截图里没有能和日志对上的错误码。electron-updater 的 `pending` 目录在安装落地之后仍留着装好的安装包——macOS 上是整个 zip,Windows 上是整个 NSIS 安装程序——因为这个库只在下载失败或缓存记录与更新源对不上时才清空它。

## Decision

### 服务器进程的崩溃记录

`startServer` 在服务器自己的命令行上、入口脚本之前加上 `--report-on-fatalerror --report-uncaught-exception --report-directory=<日志目录> --report-exclude-env --report-exclude-network`(`diagnosticReportFlags`,目录由 `ServerSpec.reportDirectory` 带入)。报告不含环境变量(提供方的 key 就在那里),也不含网络接口。异常只在 CLI 的 `installFailLoud` 处理器装上之前产生报告,之后那个处理器写的 stderr 行就是记录;绕过 V8 的原生崩溃(例如 Windows 的 `0xC0000409`)不写报告。

退出尸检与 URL 行之前退出的拒绝都等子进程的 `close`——它在两条管道都排空后才到——以 `exit` 之后 `CLOSE_WAIT_MS`(2 秒)为界,应对服务器启动的某个进程仍占着管道的情况。隔离扫描读的是 URL 行之前那次拒绝的 `output`,所以它现在也看到完整输出。

### 服务端 logger 记录进 `dsh-server.log`

`@deepseek-ai/dsh-desktop-app` 多了一个插件模块 `./server-log`,它的 patch 层插入挂载该模块的 `desktop-server-log` 一行。插件在根 logger 服务上注册一个 exporter——这个服务由每个上下文共用,隔离的预设 realm 也在内——把级别不高于 `level: 2` 的每条记录追加到 `DSH_DESKTOP_SERVER_LOG` 点名的文件;壳只给服务器子进程把这个变量设为 `dsh-server.log`,没有这个变量时这一行关闭。cordis 的级别顺序是 ERROR 0 < INFO 1 < WARN 2 < DEBUG 3,所以这个阈值保留 warn、丢掉 debug。每条记录是一次 `appendFileSync`,各行以 `[server-log]` 开头。挂载时插件先追加服务缓冲区里已有的、阈值以内的记录。这个包像壳一样用自己的 `tsc -b` 构建,因为仓库的 tsdown 只覆盖 `vendor`、`packages` 与 `apps/cli`;打包流程在 deploy 之前构建它,暂存启动也点名一个日志文件,让这一行在那里挂载,它的模块就必须能从载荷里解析到。

### 「无法检查更新」的详情

手动检查以「无法检查更新」作答的两处都用 `checkFailureDetail` 拼详情:失败信息的第一行,然后是 `错误码:`,列出 `cause` 链上的全部错误码,或被放弃的请求的 `TimeoutError`/`AbortError`;两样都没有的失败不显示错误码这一行。

### 安装后清空 `pending`

点击安装时,壳把 `pending/update-info.json` 里暂存安装包的 `fileName` 与 `sha512` 连同当时运行的版本记进 `desktop-state.json`。之后的启动在第一次检查之前调用 `sweepInstalledPending`:只有运行的版本比记下的版本新才会动手,并且只在 `pending` 的记录仍指向那个安装包时清空它(记录最后删)。同一版本再次启动说明安装没有落地,那个安装包仍是待装的更新;记录指向别的安装包说明那是之后的新下载。重新拉起应用的 Windows 安装程序仍占着的条目会被报出来,记下的安装保留,下次启动再试。缓存根目录下的差分基线从不动。

## Alternatives considered

**用 `NODE_OPTIONS` 传报告参数。**环境变量会传给服务器启动的每个进程,于是 agent 替用户跑的每个 Node 程序都会把报告写进桌面日志目录,而不带 `--report-exclude-env` 的报告还会带上那个程序的环境变量。这些参数只属于服务器这一个进程。

**挂载 `@deepseek-ai/cordis-plugin-logger-console`。**它经 `console.log` 打印,而壳在服务器的 stdout 与 stderr 里找就绪行,并把两路输出都抄进 `dsh-server.log`:打印出来的记录会被拿去匹配 URL 模式。由 exporter 自己写文件,两路输出保持原样,每条记录只写一次。

**用 logger 预加载或核心补丁抓启动期的 warn。**这一行追加在所有其他条目之后,而 Loader 并发导入条目,所以这一行挂载之前、启动期间记下的 warn 不在重放的缓冲区里,那个缓冲区按 INFO 收记录。给 `LoggerService` 打补丁的 `--import` 预加载,要靠预加载与 CLI 解析到同一个 cordis 模块;改缓冲阈值或加启动钩子是核心改动。这次只改壳,两者都没做。

**从 `pending` 里安装包的文件名推出已装版本。**文件名在版本前后混着产品名、`Setup`、架构和平台,正式版后面跟着 `-arm64` 会被解析成比它低的预发布版本。点击安装时写下的记录用的是这个库自己的字段来指认安装包,由运行的版本判断安装是否落地。

## Consequences

崩溃现在会留下服务器最后写的那几行,V8 致命错误会在日志旁留下一份报告。报告与 `dsh-server.log` 都从不轮转,而日志现在还会收到每个插件 INFO 及以上的 logger 记录。`desktop-server-log` 挂载之前、启动期间记下的 warn 仍会丢失——从 rc.33 升级后首次启动时设置导入逐段的失败也在其中。开发启动之前需要先跑 `pnpm --filter @deepseek-ai/dsh-desktop-app run build:ts`,因为这一行导入的是那个包的 `lib/`。由早于这项改动的版本发起的安装没有留下记录,它的安装包会一直留在 `pending`,直到下一次更新下载时清掉。
