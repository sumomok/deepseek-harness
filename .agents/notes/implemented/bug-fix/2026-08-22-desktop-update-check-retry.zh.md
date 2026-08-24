# Agent Note: 被网络打断的检查会重试,不再赔上应用内更新那一层

Status: implemented

[English](2026-08-22-desktop-update-check-retry.md) | 中文

## Problem

[下载重试那篇](2026-08-21-desktop-update-download-retry.zh.md)把分类器的适用范围限定在 `downloadUpdate`,并写明了理由:「检查失败有它自己的层级回落」。那个回落是 `runCheck` 把 macOS 降级、改由 `checkGeneric` 作答——而 `demoteMac` 立的是 `macInstallUnavailable`,这个标志不是按次检查算的,是本次运行剩下的全部时间。于是下载路径刚刚学会规避的那笔层级代价,任何撞上断连的检查仍在全额支付,而那篇 note 称为「足够」的回落,正是它前一段刚描述成 bug 的同一个永久降级。

rc.17 让它变得可复现。壳在「第一次检查发出」和「server ready 触发的第二次检查」之间新增了两件主进程同步工作——播种 desktop profile,以及开渲染服务——首次启动时这段延迟足以让第一次检查的连接空转到被对端关闭。日志依次是 `Checking for update (already in progress)`、`net::ERR_EMPTY_RESPONSE`,然后 `in-place update unavailable … falls back to the download page`。rc.16 的启动日志里这两行都没有。服务端已手工排除:5 次串行加 3 次并发,全部 200,约 0.1 秒。

有三个调用点对任何检查失败一律降级——`resolveGate` 的 catch、`runCheck` 包住 `checkInPlace` 的 catch,以及 `error` 监听器——同一个失败可能到达其中不止一处,`demoteMac` 的一次性守卫决定的只是谁抢到了记日志的机会。

## Decision

检查遇到瞬态失败会重试,只有重试解决不了的失败才把 macOS 移出应用内更新那一层。

### 重试跑者共用,计划不共用

`downloadWithRetry(run, hooks)` 变成 `withRetry(run, delays, hooks)`,并对「一次尝试返回什么」泛型化,好让检查把清单经由它传回来。`RETRY_DELAYS_MS` 仍是下载计划。`CHECK_RETRY_DELAYS_MS` 是 `[1_000, 3_000]`:一次检查只传一份小清单,被打断的代价是一个请求而不是几百兆,而整个计划装得进 `GATE_TIMEOUT_MS` 允许的十五秒——正是这一点,让撞上断连的强制启动门能从一次重试而不是从它自己的超时里得出结论。

分类器不变,继续共用。这是刻意的,但有一处边界值得点名:`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` 包裹的是检查期的网络故障,它仍然是 `fatal`,所以以这种形式失败的检查既不会被重试,那一层也保不住。上面那个回归浮现出来的是 `net::ERR_EMPTY_RESPONSE`,属于瞬态,已被覆盖。为检查期放宽分类器的做法在下面被否决。

### 只有一处向 feed 提问,并在重试期间把这次检查按住

`checkFeedWithRetry(host, instance)` 为原本各自调用 `checkForUpdates()` 的两个调用点——`checkInPlace` 与 `resolveGate`——统一包装,并在整个计划期间持有 `checkInFlight`。

这个标志才是让重试真正生效的那一半。每次失败的尝试都会抛出 `error` 事件,而监听器原本无条件降级;没有这个标志,第一次尝试就会在第二次尝试有机会成功之前把那一层拿走,重试也就只是装饰。现在监听器对检查让位,和它早已对下载让位的做法一致,理由也是同一条:正处在计划中的调用方才是能判断这个失败意味着什么的那一半。仍然会到达监听器的,还是一直以来的那些——Squirrel 内部的失败,它运行在本模块 await 的所有 promise 都已 settle 之后。

### 剩下两处降级都先分类

`resolveGate` 与 `runCheck` 只对 `fatal` 降级。熬过重试仍未成功的瞬态失败,代价就是这一次检查——`resolveGate` 下面照样去读原始清单,`runCheck` 照样由 `checkGeneric` 作答——下一次检查会重新走应用内那条路。这与下载路径早已遵循的是同一条规则,现在只是在被漏掉的那两处也写了出来。

## Alternatives considered

**只分类,不重试。** 三处各改一行,报告的症状就消失了:瞬态的检查失败不再赔上本次运行的层级。否决理由是这一轮检查仍然落到下载页,也就是让用户去浏览器下载一个应用本来就装得了的构建——正是下载重试那篇 note 要消灭的那个界面。先重试,才能让这个回落变成罕见,而不只是可恢复。

**检查也复用 `RETRY_DELAYS_MS`。** 一份计划、一个常量,不必为新东西辩护。但它的 26 秒超出 `GATE_TIMEOUT_MS`,强制启动门会在重试还在跑的时候从自己的超时里作答——门会在一台本该被拦下的机器上打开,而重试在那个调用点的全部意义也就丢了。

**在检查期放宽分类器**,让 `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` 在检查抛出时算瞬态。重新请求一份缺失的 channel 文件很便宜,不像重传产物。暂不采纳,因为这个码同时覆盖「feed 确实没有该通道的清单」和「网络故障」两种情况,而区分它们需要包装器并未携带的成因。在真实 feed 产出瞬态形态之前,它保持 fail-closed。

**在 `error` 监听器里重试。** 失败先到那里,重试能起得更早。但监听器无法把答案交回给 await `checkForUpdates()` 的那一方,调用方仍会看到原始的 reject 并据此行动,而重试在它背后空跑。

## Consequences

撞上断连的首次启动会在四秒内重试两次检查,并为本次运行保住应用内更新。熬过重试仍失败的检查只赔上这一轮,下一次定时、手动或 server-ready 检查会重新走应用内那条路。真正装不了的构建仍在第一次尝试就降级,不额外增加等待。

代价是一次检查放弃之前最多多等四秒、多发三次请求;强制启动门把这段花在它已有的十五秒竞速之内,而不是之外。

`apps/desktop/tests/download-retry.spec.ts` 覆盖泛型跑者、它交回的值、被重试的检查是按检查计划排布的,以及两条不变量:检查计划比下载计划更紧,且装得进启动门的预算。`checkInFlight`、`checkFeedWithRetry` 和那两处分类过的降级都在 `updater.ts` 里,它 import electron,按下载重试那篇 note 给出的理由继续不做单测;它们的证据与那篇相同——一个签名构建对真实 feed 跑,以及最初暴露这次降级的那段启动日志。
