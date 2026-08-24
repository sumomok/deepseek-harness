# Agent Note: 由用户自己完成的登录,以及它留下的那一份存储

Status: implemented

[English](2026-08-25-desktop-sign-in-window-and-login-partitions.md) | 中文

## Problem

挡在登录墙后面的页面,从一个空着开始的 session 里截不出来。[渲染服务](2026-08-22-desktop-render-service.zh.md)给每次渲染一个全新的、非 `persist:` 的 partition,随窗口创建、随窗口销毁,所以把一次截图指向某个应用自己的页面,拿回来的是那个应用的登录跳转。

对此已经发出去的答案是由调用方提供 session:`POST /render` 的 `cookies` 字段,[截图工具会送出它](2026-08-22-screenshot-session-and-output.zh.md),而 `@haoran/dsh-screenshot` 0.3.0 让模型只点名一个配置在 `cookieJars` 下的 jar,把值挡在工具参数之外。这条路只有在有人已经手工把一份浏览器 session 导进那个配置文件之后才走得通,而凭据此后就一直躺在那里,直到站点不再认它。桌面客户端正是最没有这一步可用的那种安装:它的前提就是一个人不碰终端、不碰包管理器、不联注册表也能跑 agent;而对一个这台机器从未持有过 session 的站点,那个 jar 根本填不出来。

缺的并不是某个调用方能递过来的凭据,而是登录本身:用户就坐在壳已经跑着的那个 Chromium 前面,却没有任何一条路由让他用上它。

## Decision

渲染服务多答三条路由、`POST /render` 多收一个字段,壳则多开一种窗口——而且只有这一种——它的 session 比它自己活得久。

**三条路由。**`POST /login-grant` 收 `{ url, partition }`,答 `{ nonce, expiresInMs }`,它自己不开任何窗口。`POST /login` 收 `{ nonce }`,在这个 nonce 被铸出来时所对应的页面上打开一扇可见的窗口,并在用户关掉它时答 `{ landedUrl, sameSite }`。`DELETE /login-sessions` 收 `{ partition }`,对它调用 `clearStorageData()`,答 `{ partition, cleared: true }`。`POST /render` 随后可以点名同一个 `partition`,那就是能带着登录态回来的那次渲染。`routeOf` 把方法与路径一起读,这四条以外的一切仍是那个 404——用户自己浏览器里的页面必须先发的预检,正是被它拒绝的。

**partition 的空间是写死的 `persist:dsh-render-login-<registrable-domain>`。**`loginPartitionOf` 检查每条路由接受的每一个 partition 名字,渲染那个字段也在内:先是 `LOGIN_PARTITION_PREFIX` 前缀,再是 `LOGIN_PARTITION_DOMAIN`——一个最多 253 个字符的小写域名。它是常量而不是 `Config` 字段,因为正是它把调用方挡在用户自己那扇窗所在的 partition 之外,也挡在这个壳日后可能持有的其他每一份存储之外;在这个空间之内调用方爱起什么名字都行,在它之外则什么都不行。域名由调用方自己算出:本服务没有公共后缀表,也不需要有,它执行的是「名字落在登录空间之内」,而不是「这个标签算得对」。`POST /login-grant` 还额外要求页面的主机名就是那个域名或它的子域,因为一对对不上的组合会把一个站点的 cookie 记在另一个站点的名下,而调用方接着就能带着这份登录态去渲染那另一个站点。

**nonce 定死了一扇窗口可以为什么而开。**`POST /login` 既不带 URL 也不带 partition——这一对在 `LoginGrant` 里,是铸出这个 nonce 时定下的。`spendNonce` 先删掉条目再判是否过期,`LOGIN_NONCE_TTL_MS` 是 30 秒,`MAX_LOGIN_NONCES` 是 8,过期的授权在读这张表的那两次调用里被清掉,而不是靠一个会让进程醒着的定时器。于是一个 nonce 重放不了,也瞄不到它被铸出来时那一对之外的任何页面或 partition,更不能过了这一轮再花:用户看到的那扇窗,就是他刚刚给出的同意所针对的那一扇。

**nonce 不是第二重身份验证,这里也没有任何地方把它当成第二重。**持有 bearer token 的人依次调用 `POST /login-grant` 与 `POST /login`,一样能拿到一扇窗;决定谁够得着这个服务的,始终只有 token 一个。这一拆买到的是:开窗与请求是两件分开的事,而开窗被绑定在确切的一对与 30 秒之上,所以为某个页面拿到的授权,开不了别的页面。

**同一时刻一扇窗,期限按人来定。**`signingIn` 在花掉 nonce 之前检查,所以第二个调用拿到的 503 不会动到它那份还能花的授权。不认识的、已经花掉的或已经过期的 nonce 得到 403,并点名 `/login-grant` 是再要一份的地方。`RenderLimits.loginTimeoutMs` 是十分钟——人要读一张表单、找一个密码、过一道第二因子,而 `RenderLimits` 里其余每一个界限都是页面的、以秒计——到点还开着的窗口会被关掉并答以 504,壳退出时还开着的那扇也一样。`close()` 先中止 `closing` 再断开套接字,因为登录窗口在有人把它撤下来之前一直在屏幕上,而拿着它的那个请求正是那些套接字之一。

**这扇窗说出正在问你的是哪个源。**`lockTitleToOrigin` 在 `did-navigate`、`did-redirect-navigation`、`did-navigate-in-page` 上把标题设成当前的源,在 `page-title-updated` 上也一样,并取消页面自己那个标题:正在输密码的人必须看得见是哪个站点在问,而一个能给窗口起名字的页面,就能自称是另一个。`LOGIN_WINDOW` 写下其余的形状——首次加载返回之前不显示、520 乘 680 内容像素、空标题,以及 `resizable: false`,后者也正是 `apps/desktop/src/main-window.ts` 里 `mainWindow()` 用来把应用自己那扇窗与其余每一扇分开的标志。这个形状放在 `render-service.ts` 里、协议旁边,于是那套用例不需要显示设备就能检查它。

**四道封锁照旧,一道放松。**权限请求、权限检查、下载与声音在这扇窗里照渲染窗口那样一律拒绝,`devTools: false`、`sandbox: true`、`contextIsolation: true` 以及「没有 Node 集成」原样不动。放松的是 `disableDialogs: false`:登录页正是用 `alert()` 与 `confirm()` 报出密码错了或第二因子没过,而这扇窗——不同于隐藏的渲染——是用户主动要的、正看着的。

**页面要开的窗口变成这同一扇窗的一次导航。**`setWindowOpenHandler` 拒掉那个子窗口,并把它的 URL 载入用户已经在看的这扇窗,于是一次 OAuth 交接能走到身份提供方再走回来,而屏幕上始终只有一个源。路由答回去的落点是在 `did-navigate` 与 `did-navigate-in-page` 发生时就读下来的,因为 `closed` 触发时 web contents 已经没了。

**留存到此为止,就这一个空间。**点名了 partition 的渲染不能同时带 `cookies`,带了就答 422:把调用方自己的 cookie 罐写进一个活得比这次请求更久的存储,等于替它保存一份凭据,而这正是本服务唯一不做的事。在不承载 session 的 scheme 上点名 partition,同样被这样拒绝。壳里没有任何东西去读登录 partition 里的值,没有任何一条路由把它返回出来,而 `clearLoginSession` 就是 `clearStorageData()`——cookie、缓存,以及 Chromium 为一个 partition 保存的每一种存储后端——对一份本进程从不读取的存储来说,「退出登录」也只能是这个意思。

**两半都是注入进来的,理由和 `Renderer` 早就成立的那个一样。**`RenderServiceSpec` 在 `renderer` 旁边要求 `openLogin` 与 `clearLoginSession`,`apps/desktop/src/login-window.ts` 装着全部 Electron 实现,于是 nonce 表、partition 文法、各个期限,以及那扇窗声明出来的形状,全程不需要任何显示设备就能驱动。

## Alternatives considered

**让调用方在 `POST /render` 上点名一个 partition,不做任何授权流程。**这是可能的最小改动:一个字段、`render-window.ts` 里一个分支,不加路由。否决,因为那样没有任何东西把一份被存下来的 session 与一个人的决定拴在一起——渲染写进去的那份存储活得比请求久,而如果没有一条「由人打开那扇填满它的窗口」的路由,壳就是在为一次用户根本没看见的调用保存一份持久 session。

**把同 eTLD+1 的弹窗开成子窗口。**`sameSite` 已经把这个判断算出来了,`setWindowOpenHandler` 完全可以为落在该 partition 所属站点上的目标真开第二扇窗,其余一律拒掉。否决,选择让每一个弹窗都在同一扇窗里跟下去:第二扇窗不带那条标明源的标题栏,`mainWindow()` 靠 `isResizable()` 找应用自己那扇窗,所以第二扇登录窗也得声明 `resizable: false`,而用户还是会同时看着两个源。身份提供方通常也并不在被登录的那个站点上,而那恰恰是同站判断会丢掉的东西。

**把 `openLogin` 与 `clearLoginSession` 做成 `RenderServiceSpec` 上的可选项。**否决:一个不带登录那一半就组装出服务的壳,会对一次已经拿到同意的 `POST /login` 什么也不开地作答,而调用方会把它读成用户拒绝了登录。把成员做成必填,答这几条路由的壳就一定持有那扇窗。

**让同一次渲染既带 `cookies` 又带 `partition`。**作为一次合并很有诱惑力——手里既有 jar 又有已登录 partition 的调用方两样都能用上——而它被否决,是因为它会让本服务去做那件事:把调用方的凭据写进一份活得比请求更久的存储。对点名了 partition 的渲染来说,partition 就是那个 session,拒绝的那句话说的正是这个。

## Consequences

本服务的否定性保证从「什么都不留存」收窄为一处带四条性质的开口,而正是这四条让它成为可选范围里最窄的那一处:只有一个具名的 partition 空间、每一条接受名字的路由都检查它、没有任何一条路由读得到它,也从不与调用方提供的 cookie 混在一起。

持有 bearer token 的本地进程能在屏幕上摆出一扇指向它所选页面的可见窗口,也能抹掉一个登录 partition。它读不到其中的内容,开不了授权里没有点名的页面,也够不着登录空间之外的任何 partition——包括应用自己那扇窗所在的那个。

壳从不让登录 partition 过期,也不回收它。用户登录留下的东西一直躺在应用 userData 目录下 Chromium 的 profile 数据里,直到有谁对那个 partition 调用 `DELETE /login-sessions`;也没有任何一条路由列出存了些什么。

同一时刻只有一次登录开着,第二次是被拒绝而不是排队,所以需要登两次的调用方只能一次一次来。

载荷里自己的调用方一样都没用上:`@haoran/dsh-screenshot` 0.3.0 用配置好的 `cookieJars` 渲染,不点名任何 partition,所以在每一种安装上 `cookieJars` 仍是那条 session 路径,而这三条路由由持有 token 的东西去够。

## Testing

`apps/desktop/tests/render-service.spec.ts` 对着一个注入的 opener 驱动整套协议:没有 token 时每条登录路由都在读请求体之前被拒、没人铸过的 nonce 与形状不对的 nonce、只铸不开的授权、抵达 opener 的那一对、只花得掉一次的 nonce 与超出存活时间的 nonce、页面不在其 partition 所属站点上的授权、两条点名 partition 的路由上落在登录空间之外的每一种名字、退出登录那次调用、在不花掉 nonce 的前提下被拒的第二扇窗、没人去完成的那扇窗、`LOGIN_WINDOW.resizable` 与 `isResizable()` 这个判别标志的关系,以及渲染那个字段——交到窗口那一半手上、不点名时不出现、落在空间之外被拒、与 cookie 并列被拒、在不承载 session 的页面上被拒。

`apps/desktop/scripts/render-smoke.mjs` 在它那三处服务上都组装真正的 Electron 两半。它不打开任何登录窗口:那扇窗是由人关掉才算完成的,而这个 smoke 无人值守地跑。
