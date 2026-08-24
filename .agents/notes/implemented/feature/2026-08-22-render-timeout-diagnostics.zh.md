# Agent Note: 超时的渲染会说出页面当时在等什么

Status: implemented

[English](2026-08-22-render-timeout-diagnostics.md) | 中文

## Problem

在 Windows 上、DSH Desktop 0.1.0-rc.17,有人让 agent 去截一个需要登录的 Redmine 实例。每一个登录后的 Redmine 页面都带着 gravatar.com 的头像,而那个网络把 gravatar.com 黑洞掉了,于是每一次图片请求都卡在 TCP 建连上,直到大约 21 秒后 Windows 自己放弃。[渲染服务](2026-08-22-desktop-render-service.zh.md)等的是完整的 `load` 事件——`await window.loadURL()` 在 did-finish-load 时才 resolve——期限 25 秒,所以带一个头像的页面要花约 22 秒,而带好几个头像的问题列表直接越过了期限。

这时工具交给模型的是 `504 render timed out after 25000ms`,一句话,再没有别的。这一行是真的,也是没用的:它分不清卡住的子资源、死掉的代理、写错的端口、跳去登录页的重定向,还是一个停止绘制的渲染进程,而这几种情况的下一步各不相同。模型挑中了错的那一种,花了 36 分钟、约 200 次工具调用去重写一个并非病因所在的 cookie 代理。一行写着 `main document 200, load event not fired, 7 requests pending: [image] https://www.gravatar.com/avatar/…` 的话,第一次调用就结束了。

## Decision

服务为每个受理的请求持有一份 `RenderTrace`,窗口那一半往里填,504 的响应体就是从它构造出来的一行。

**这份 trace 属于服务,renderer 只往里写。**`startRenderService` 在 `runQueued` 里为每个受理的请求创建一份 `RenderTrace`,并作为 renderer 的第三个参数传进去,于是 `Renderer` 现在是 `(request, signal, trace) => Promise<Buffer>`。它记三样东西:渲染所处的阶段——创建时是 `queued`,随后是 `navigating`、`loaded`,以及 `delaying`、`measuring`、`resizing`、`capturing` 中这次请求真正走到的那些;主框架最终的 URL 与 HTTP 状态码,来自 `did-navigate`;以及页面已经发起、尚未结束的请求,以 Chromium 的请求 id 为键、按插入顺序保存,所以先打印出来的就是卡得最久的那些。把一个从未开始过的 id 判为结束是无操作而不是错误,因为命中缓存的响应根本不会发送请求头就直接完成——开始的那一批和结束的那一批不是同一批。`RenderTrace` 与它的阶段联合类型都是导出的,这正是单元测试能驱动真家伙而不是替身的原因。

**窗口那一半只用非阻塞的观察者去喂它。**`render-window.ts` 在加载之前,在 `webContents` 上注册 `did-navigate`,在这次渲染自己的 session 上注册 `onSendHeaders`、`onCompleted` 与 `onErrorOccurred`。`onSendHeaders` 在建连之前就触发,这正是卡在 TCP 建连里的请求——也就是这次事故的情形——会被算作 pending 的原因。这里没有任何东西改变渲染本身:这三个只观察,而阻塞钩子会扣住每一个请求直到自己的回调跑完,那样就会改变它本来要报告的时序。

**这一行在 abort 之前构造,只构造一次。**期限定时器先读 `trace.describeTimeout(timeoutMs)`,再 abort,因为 abort 会销毁窗口,而 session 随后会把所有还在飞行中的请求报为失败,把这一行本来要点名的那份清单清空。`RenderTimeout` 现在把整行作为自己的 message 携带,所以它沿着原有的 `fail(response, 504, error.message)` 这条路抵达调用方,别处一点都不用改。

**这一行说些什么**,同时保持调用方与 README 拿来 grep 的开头 `render timed out after <ms>ms` 不变:

| 阶段 | 期限之后的那半句 |
|---|---|
| `queued` | `the render had not started (queued behind earlier renders)` |
| `navigating`,主文档还没有回答 | `no response from the main document yet, 2 requests pending: [mainFrame] …, [other] …` |
| `navigating`,主文档已经回答 | `main document 200, load event not fired, 7 requests pending: [image] …, [image] …, [script] … (+4 more)` |
| `loaded` 及其之后 | `page loaded, timed out while waiting delayMs` / `while measuring the document` / `while resizing the window` / `while capturing` |

当主框架最终落脚的地方不是请求所指的地址时,它会被接在状态码后面——`main document 200 at http://127.0.0.1:18099/login?back_url=…`——跳去登录页的重定向就是这样显出来的。Electron 报不出 HTTP 状态码的那种导航写作 `main document with no HTTP status`。还在 navigating 却一个请求都不在飞行中,则打印为 `no requests pending`,因为这本身就是信号:页面并不是在等网络。

**它被限制到刚好装进读它的人手里。**`@haoran/dsh-screenshot` 只把错误响应体的前 500 个字符引进模型看到的消息里(它 `lib/types/desktop.js` 中的 `MAX_ERROR_DETAIL`),所以这一行最多列 3 个 pending 的 URL、每个截到 96 个字符、其余计作 `(+N more)`,并把整行截到 500 个字符——每一次截断都以省略号收尾,好让模型看得出是有东西被丢掉了,而不是读到一句半途而止的话。这三个常量放在 `render-service.ts` 顶部,各自带着自己的理由。

## Alternatives considered

**用阻塞的 `onBeforeRequest` 给每个请求计时。**那样能给出每个请求的确切耗时,而不只是"开始了、还没结束"。否决:阻塞钩子会扣住每一个请求直到自己的回调跑完,于是诊断本身就落进了它所报告的时序里——一次超时的渲染,可能正是因为被测量才超时的。一个能改变自己所描述结果的诊断,比一个做不到这一点的粗糙诊断更糟。

**挂上 `webContents.debugger` 去读 Network domain。**它能带来多得多的东西——各段耗时、每个请求的状态码、响应头——也正是 devtools 面板会显示的那些。以代价与姿态否决:它会给每一次渲染都挂上一个调试器,而不是只给出问题的那一次;它是又一套要随 Electron 升级一起维护的协议;而那些多出来的细节,没有一样会改变调用方的下一步——而下一步是这一行存在的全部目的。

**超时时把已经画出来的部分截下来,答 200。**这常常是最有用的回答——头像卡住的页面,通常早就排好版了。在这里作为另一个决定否决:它改变了协议里"成功"的含义,调用方就不能再把 200 读作"这就是那个页面",而且它还需要自己回答部分截图该如何标注。是推迟,不是拒绝——[渲染报告这一篇](2026-08-23-desktop-render-report.zh.md)把它作为逐请求的 `onTimeout: 'capture'` 发了出去,只有主动要了它的调用方才可能收到,而 `outcome: 'timeout'` 为它打上标签。

**成功的渲染也在响应头上带上诊断**,好让慢但成功的渲染也说出自己等过什么。暂时否决:插件读的是失败的响应体和成功的字节,所以不改插件就没有人会读这个响应头,而那个插件是本仓库并不拥有的一个 vendored tarball。[会话与文件输出这一篇](2026-08-22-screenshot-session-and-output.zh.md)就其中最要紧的那一件事——主框架最终落在哪里——推翻了这个结论,办法是把两半一起发出去。[渲染报告这一篇](2026-08-23-desktop-render-report.zh.md)以同样的理由推翻了其余部分,把整份记录放到 `x-dsh-render-report` 上,出现在每一个真的开始渲染过的回答里。

**不动 504,改成告诉模型换一个更长的期限重试。**否决:壳的期限被钉在插件自己 30 秒预算之下,根本没有可以拉长的余地;而对着一个被黑洞掉的主机重试,只会更慢地得到同一个 504。

## Consequences

504 现在会点出被渲染页面所加载的第三方主机。这正是调用方需要的——它是"页面很慢"与"gravatar.com 在这个网络上不回答"之间的差别——而这也值得直说:这一行因此会在一份抵达模型的响应体里,报告页面把浏览器指向了哪里。除页面自己请求过的东西之外,不报告任何别的。

这一行被限制了两道,一道是每个 URL 的截断,一道是整行的截断,所以 URL 极长的页面没法把阶段和状态码挤出调用方那 500 个字符的引用范围。开头的 `render timed out after <ms>ms` 没有变,所以按它匹配的东西照旧匹配。

渲染本身什么都没变:同一扇窗口、同样的隔离、同样的边界、同样的队列、同样的期限。原来能成功的渲染照样成功,原来会超时的渲染照样超时——在同一个时刻,只是句子长了一些。

## Testing

`apps/desktop/tests/render-service.spec.ts` 用注入的 renderer 驱动真正的 `RenderTrace`,对上面每一种形态断言确切的那一行,另加 `(+N more)` 的溢出、96 字符的 URL 截断、重定向形态、结束的请求确实离开 pending 清单、对一个从未开始过的 id 判结束,以及当每个 URL 都长到足以撑爆时,这一行仍是一行、且不超过 500 个字符。

`apps/desktop/scripts/render-smoke.mjs` 覆盖任何注入的 renderer 都够不着的那一半:它起一个接受连接却从不回答的 `net` 监听,在 2 秒期限下渲染一个唯一的图片指向它的 `file:` 页面,并断言 504 的响应体说出 `load event not fired` 并点出那张图——这正是"session 的 `webRequest` 钩子确实通到了 trace"的那一条断言。
