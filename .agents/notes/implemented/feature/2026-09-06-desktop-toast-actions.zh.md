# Agent Note: Answering an approval from the Windows toast

Status: implemented

[English](2026-09-06-desktop-toast-actions.md) | 中文

## Problem

桌面壳早就会告诉用户「某个会话在等一次工具批准」，点那条通知也会把窗口抬起来。但要拒绝这次请求，仍然得把窗口这一趟走完：还原窗口、找到会话、读那张卡、按按钮。而拒绝恰恰是唯一一个不需要这趟路的答案——没看清就拒掉，代价只是模型重试一次——于是最便宜、也最安全的那个答案，反倒是通知唯一送不出去的。

## Decision

Windows 上审批的 toast 带两个按钮，顺序固定：「拒绝」和「去看看」。

「拒绝」在 `$events/result` 上用 `{ kind: 'result', value: 'rejected' }` 答复这次 waterfall 投递，走的就是壳本来答 `next` 的那条已鉴权 HTTP 通道。任一客户端返回 `result` 就为所有客户端结算这次请求，于是 Host 会取消发给浏览器页面的那次投递，那张审批卡在按下按钮的同时消失——用户的动作落在用户看得见的地方。「去看看」调用的就是点通知本体所调用的那个 `reveal`；点本体的行为没有变化。

没有「批准」。toast 只说了某个会话请求执行哪个工具，别的什么都没说——没有命令、没有文件、没有将要写入的内容——而批准得当着它所批的那样东西给。

按下按钮会关掉这条 toast，因为 Windows 会把已弹出的 toast 连同仍然可按的按钮留在操作中心里。若按下时这条投递已经不在壳的等待之列——页面答过了、别的客户端答过了，或者它自己那份 60 秒宽限的答复已经发出——那么除了写一行日志之外什么都不做：Host 本就会丢弃迟到的答复，按钮也不假装另有其事。

`toastButtons` 只在 Windows 上画出这些按钮。Linux 的 `Notification` 直接忽略 `actions`，而 macOS 根本走不到通知那一步——壳在 macOS 上用 Dock 角标加一次弹跳来回应这类时刻。

即便发错了词也是构造上安全的：`dsh-user-approval` 会把词汇表之外的任何答复归一成 `unavailable`，而它拒绝这次工具调用。答错的壳只可能多拒，绝不可能误批。

## Testing

`apps/desktop/tests/notifications.spec.ts` 以纯函数的方式钉住按钮的顺序、文案和平台规则。`apps/desktop/tests/toast-answer.spec.ts` 直接驱动这个模块——替身 `WebSocket` 全局投递 `ready` 与一次 `approval/request` waterfall，替身 `Notification` 接住那条 toast——并从环回服务器上读回答复：按下「拒绝」时 `$events/result` 的确切载荷、按下「去看看」时的抬窗，以及投递已被取消或已被答复之后的一片安静。

Windows 的 toast 本身无法单测，验收在真 Windows 机上对着安装版进行：按钮依赖 NSIS 安装器写到开始菜单快捷方式上的 AUMID，而 `pnpm dev` 不会创建它。

## Alternatives considered

**「批准」也放上 toast。**否决，因为在 toast 上批准的是 toast 没有展示过的东西。正文只说了会话和工具名；真正让一次批准成其为决定的那些内容——命令、路径、差异——都在窗口里那张卡上。

**改用 `{ kind: 'rejected', error }` 而不是 `result` 答复。**否决，因为那个 outcome 是通道自己的失败通路：它让 Host 的待决 promise 被拒绝，而不是结算这次审批，审批服务读到被抛出的答复只会当成 `unavailable`。用户按了一个按钮，这是一个答案，不是一次传输失败。

**按下已过期的按钮时把窗口抬起来。**否决，因为那次请求已经没了：抬起窗口只会让用户看到一个没有卡片的会话，也解释不了他这一按为什么什么都没发生。

**请求在别处被结算时主动关掉那条 toast。**没做。它会让操作中心保持诚实，代价是把每条已弹出的 `Notification` 挂在 generation 上、并在 `cancel` 帧到达时逐一处置；而过期的那一按本就已经是空操作，所以这份代价买到的是整洁，不是正确。

**用 `toastXml` 或 `electron-windows-notifications` 来承载 toast 上的按钮。**没有必要：Electron 43.4.0 在 Windows 上原生支持 `button` 类型的 `actions`，而这个应用早已设置了 Windows 要求 toast 发送方持有的那个 AUMID。

## Consequences

壳不再是一个只会弃权的客户端：它的流里有一种投递现在可以由它结算，模块里的 `answer` 也因此接收 outcome，而不是假定 `next`。它播报的其他事情——一轮跑完、一个问题、一份计划评审——依旧不带按钮；一个问题的答案不是二选一，需要另一种 action 类型。

从 toast 发出的拒绝抵达模型时就是普通的那次拒绝，所以 agent 的重试或改问，与从卡片上拒绝时完全一样。用户按下它不会失去任何东西，也不会获得任何他本来做不到的事——只是省掉了窗口这一趟。
