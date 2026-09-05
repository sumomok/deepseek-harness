# Agent Note: page 座位为用户没在看的标签页作答

Status: implemented

[English](2026-09-05-content-seat-hidden-tab.md) | 中文

## Problem

有两件事，让内容区那六件工具在一个开着、也活着的控制台上答不出来。

**可见性是一票否决。** `document.visibilityState` 是 `hidden` 时座位一次都不认领，模型收到的是 `No open, visible console tab is showing this session's content column`。这个词覆盖的远不止「退到后台的标签页」：macOS 把被另一个窗口盖住的前台窗口报成 hidden，锁屏也一样。[认领重启那份 Note](../bug-fix/2026-09-03-content-seat-claim-restart.zh.md) 记下了一个正在跑的控制台约 400 次调用里 33 次这样的拒绝，而人就坐在它前面；它在第 46 行点名了修法——把可见性从一票否决降为偏好，与宿主自己的 `PREFERRED_TAB_WINDOW_MS` 等待同构——并把它留给一份独立的 Note。本文就是那一份；它点名的触发器在 2026-09-05 到达，而在本次改动之前，同一句拒绝已在真机上被一个被遮住的窗口复现。

**展示中的会话是过滤器。** 座位只读当前会话那一行，于是控制台一切到别的会话，后面那个会话的每一次调用就从座位的列表里整个消失——而此时标签页完全可见。frame 还挂着，文档还活着，因为内容栏是把 frame 藏起来而不是卸载它，只是没有人去读它。

## Decision

**可见性改为给出价排序，而不是把门关上。** 每个座位都出价；标签页不在前面的座位，首次出价前付 `HIDDEN_CLAIM_GRACE_MS`（250ms），之后一分不付。这个常量放在 `src/access/wire.ts` 里 `PREFERRED_TAB_WINDOW_MS` 旁边，是同一场竞争里座位这一半：两个控制台都从同一个宿主、各自的投影流上收到这次调用，两者之间的偏差是毫秒级。原先镜像那个值的 state 与 `visibilitychange` 监听器随否决一起删掉了——这个值在用到它的地方读，也就是出价那一刻。

**座位持有的是「每会话一份栏」，不再是「一份栏」。** `ContentReadSeat.sessions` 为展示中的那个会话、以及座位仍持有其 frame 的每一个别的会话各带一份 `SeatSession`。展示中的会话从内容栏自己的选择里取页面，那是用户在多项之间挑了哪一项的唯一去处；别的每一个会话从帧缓存里取，缓存的 recency 表是「用户上一次给这个会话看的是哪一页」的唯一记录。`CachedFrame` 现在直接带上它本来就编码在 frame id 里的会话 id 与条目 id，于是没有任何地方去解析那个字符串。座位不持有活 frame 的会话，是从列表里缺席而不是留一份空的，于是座位绝不为一个自己答不了的调用出价，那次调用照旧由宿主的认领窗口收场。

**不在前面的会话上照跑 `content_act`，只有一个分支。** 审批点名的是用户读那份请求时在前面的那一项，而既有的 front-changed 闸拿它与该会话自己的页面比对，而不是与控制台的比对——那个会话若已经移动过，就按名字被拒。要改成「不在展示中的会话上一律拒绝跑步骤」，只是 `answer` 里一个分支；写在这里，是为了让这个决定看得见，而不是埋着。

**拒绝说的是 showing，不是 visible。** `No console tab is showing this session's content column (waited 3s)`，后半句 `; the <kind> "<title>" is already in front.` 不变。这个结局已经与可见性无关；还成立的事实是：没有任何控制台持有该会话内容栏的活 frame——无论那一页从未在它上面展示过，还是它的 frame 已被淘汰。

## Alternatives considered

**在 `ClaimRequest` 里带上可见性，让宿主替隐藏的出价做等待。** 更强——仲裁归宿主而不是各座位自己的时钟——但代价是一个 wire 字段、它的解析器、一个宿主分支、一条顶替规则和一套宿主测试；而且在 `claimTimeoutMs` 默认 3000 的情况下，每一次隐藏出价都会在等待里吃掉认领窗口的三分之一。认领重启那份 Note 已经把形状定成座位侧的宽限。升级路线仍然摆在那里：触发器是真实部署里两个控制台同开一个会话，并且现场报出「步骤跑在了我没看的那个窗口里」。

**去问内容栏：非当前会话在前面的是哪一项。** 那个选择是 `dsh-experimental-content-column` 的组件本地 state，而且只对当前会话下发。帧缓存是更好的答案，也是本包自己的：它点名的那一项，正是文档还挂在这里的那一项，也是座位唯一读得到的那一页。

**为「最多服务几个会话」加一个类似 `cacheSize` 的旋钮。** 已经有一个了。一个会话可服务，恰好就是它的 frame 还活着的那段时间，而这由 `cacheSize` 界住；第二个旋钮只会让两者互相打架。

**隐藏时跳过 settle 等待，并把清单标成还在变。** 那么每一次读一个长期隐藏的页面都会带上 `The page was still changing when this read ran`，模型每次照做重读，答案永远不变——正是截图插件那份现场报告已经付过学费的那种宏循环。安静定时器晚到只会让判定更保守，从不让它变错。

**给座位的等待换一套 Worker 或 `MessageChannel` 时钟。** 本片不做；见下面关于节流的那条结论，它正是去做这件事的触发器。

## Consequences

- 用户切走了的、被另一个窗口盖住的、或者留在锁屏后面的控制台，和摆在眼前的那个一样作答读取与步骤，只是晚一个宽限窗口。
- 两个控制台同开一个会话时，宽限只给第一轮排序。读取的等待在投影帧到达时就已经开着，于是在前面的标签页出价撞上的是一次尚未被认领的调用，另一个撞上的是已经授出的认领。`content_act` 要等有人答完审批才登记等待，那时两个座位的重试环相位任意，排序只在统计意义上成立；真正让连续调用收敛到同一个标签页的，是宿主的 `pinMs` 偏好。
- **隐藏标签页的定时器归浏览器管，超过约五分钟就是一分钟醒一次。** 真机隐藏 8.4 分钟实测：`setTimeout` 立刻对齐到一秒，之后 Chrome 的 intensive throttling 把它拉到约一分钟——其间控制台自己那条 WebSocket 一直连着，所以持有活动连接并不能让页面免于这一档。本座位花的每一次等待都是这样的定时器：出价之间的间隔、上面那个宽限、观察页面是否安静下来的窗口、一步之内的轮询，以及问在前面那个 frame 现在在哪的轮询。于是在一个长时间隐藏的标签页里，一次读取可能撞上宿主的回报截止时间，模型收到 `The console claimed this read but did not answer within Ns.`——那是真话，模型据此重试一次即可。本片不为它改任何等待：座位那几个 share 常量说的是「一次调用的截止时间怎么分」，与可见性无关；跑批自己的截止时间按墙上时钟算，不受影响。后续是给座位的等待换一套 Worker 时钟，那是它自己的一片；触发器是现场报出「长期隐藏的控制台认领之后不作答」。
- 隐藏标签页里的图读可能导出一张用户从未见过的帧，因为用 `requestAnimationFrame` 作画的页面在标签页离开视野后就不再画。已记在本包 README 里 WebGL 那条天花板旁边；两者都一样，从页面外面看不出来。
- 这个控制台从未展示过页面的会话，或者 frame 已被 `cacheSize` 淘汰的会话，读取照旧由宿主的认领窗口收场。那正是这句拒绝现在说明的天花板。
- `SESSION_FORMAT_VERSION`、`contentAccess` 的 `stateVersion`（4）、wire 的各套 schema 与 `Config` 面全部未动：本片只加了一个协议常量，没有加任何随部署变化的值。

## Testing

`packages/experimental/content-frame` 保持每文件 100% 覆盖。两套 executor 用例新增：隐藏的标签页晚一个宽限窗口出价并回报它的清单、在前面的标签页在宽限之内就出价、宽限只付一次而不是每次出价都付，以及从不在前面的标签页跑一组步骤。`tests/content-cross-session.client.spec.tsx` 用两个会话驱动座位的 props：为展示中那个会话背后的会话读取、答案落在它自己的 frame 里；两个会话的读取各自落在各自的文档里；以及一个会话被从列表里排除的三种方式。原先那条 `claims nothing while the tab is hidden, and catches up when it comes back` 描述的正是被替换掉的行为，因此随行为一起改写。

`apps/web/tests/content-read-hidden.e2e.ts` 是浏览器车道这一份，既不要 key 也不要录制：那次待办调用被拼进播种的日志里——那正是 `contentAccess` 投影发给每个浏览器的东西——而宿主对它的等待，由用同一个 call id 直接跑一次工具打开。Playwright 启动 Chromium 时关掉了后台节流，所以那条车道覆盖的是这道闸，永远覆盖不了那些时钟。四份逐字断言拒绝的用例带上了新句子，`tests/self-contained-copy.client.spec.ts` 会把它走一遍查工具名。

2026-09-05 在真机上跑了两个探针。那句拒绝在一个被遮住的前台窗口下被复现，那是整片的前提。以及：标签页隐藏 8.4 分钟期间，对被托管页面里一棵 `content-visibility: auto` 子树读 `checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })`，全程答 `true`，因此无论标签页在不在前面，读取器问浏览器的都是同一个问题，为它起草的那个条件分支不写。
