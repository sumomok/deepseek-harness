# Agent Note: 桌面壳为自己的服务端渲染页面,并把发起请求的截图插件一起分发

Status: implemented

[English](2026-08-22-desktop-render-service.md) | 中文

## Problem

写 HTML、CSS 或组件的 agent 是在盲写:它可以把自己写下的每个字节再读一遍,依然不知道两个元素叠在了一起,也不知道布局在被要求的那个宽度上塌了。`@haoran/dsh-screenshot` 用「渲染页面、把像素交回来」闭合这个环,而它唯一的渲染器是它在机器上探测到的无头 Chrome、Edge、Chromium 或 Brave。它从不下载任何东西,这对一个插件是对的取舍——代价是在一台什么都没装的机器上,这个工具答的是 `no headless-capable browser found`。

桌面客户端是这件事最难辩护的那种安装。它存在的意义,就是让人不碰终端、不碰包管理器、不联注册表也能跑 agent;为了截个图叫这个人去装 Chrome,和安装包本来要消除的要求是同一类。而壳本身就是一个 Chromium:它正在运行,正是用户盯着的那扇窗,不需要再装任何东西就能渲染一个页面并把字节交回来。

这个插件还带着两个既有内置插件遇到过的同一个问题的后半截。它没有发布——它以一个本地工作区产出的 tarball 形式存在——所以要装上它,得有终端、能用的 pnpm,还要执行 `dsh plugin --profile web add <path>`。

## Decision

壳为它启动的服务端跑一个 loopback 渲染服务,安装包则携带使用这个服务的插件。

**服务本身。**`apps/desktop/src/render-service.ts` 在 `app.whenReady()` 里、`startServer` 之前,于 `127.0.0.1` 与一个临时端口上打开 `http.createServer`,并生成一个 32 字节的 token。两者经由新增的 `ServerSpec.env` 抵达服务端进程,即 `DSH_DESKTOP_RENDER_ENDPOINT` 与 `DSH_DESKTOP_RENDER_TOKEN`,在 spawn 处铺在继承环境之上——而不是经由壳自己的 `process.env`,因为用户从应用里启动的其他每一个进程都会从那里继承。`POST /render` 收 `{ url, width, height, fullPage?, delayMs? }`,答 `200 image/png`,或在 400(请求格式不对)、401(缺少或写错 token)、404(其他任何路径或方法)、422(格式正确但 scheme 不是 `http`、`https` 或 `file` 的 URL)、500(页面没加载起来,带着 Chromium 的错误码)、503(队列已满)、504(越过期限,这一行会说出渲染当时在等什么——那一行归[超时诊断 Agent Note](2026-08-22-render-timeout-diagnostics.zh.md) 管)下答一行 `text/plain`。这就是插件 README 写明的协议;壳是去实现它,而不是另定一份。

**为什么用 HTTP,而不是两个进程本来就共享的那条通道。**插件跑在服务端里,而服务端是一个 spawn 出来的 Node 进程,所以它对壳说的任何话都要跨越进程边界。壳与那个子进程之间已有的那条流承载服务端的日志输出与它的就绪行,把一套带二进制载荷的请求/响应协议复用上去,就等于让壳在一条「这里的每个字节都进 `dsh-server.log`」的管道上再拥有一套分帧。带 bearer token 的 loopback 端口是插件本来就会说的东西,也是另一个平台上的壳不必继承这一个壳的进程布局就能实现的东西。

**协议之所以这么窄,原因是它的安全位置。**监听绑在 loopback 上,机器外的东西够不着它。token 先比长度再用 `timingSafeEqual` 比较,所以别的本地进程扫到端口也用不了这个服务。从不发送任何 CORS 头,除 `POST /render` 以外的方法一律答 404,于是 `authorization` 头与 JSON content type 逼浏览器发出的预检被拒绝——这正是让用户自己浏览器里的页面无法借用户之手用上这个服务的东西。每次渲染拿到一个隐藏窗口,跑在一个全新的、非 `persist:` 的 partition 上,所以它的 session 只活在内存里、随窗口一起消失:被渲染的页面读不到也写不了用户工作所在那扇窗的 cookie、存储与缓存。那扇窗没有 Node 集成、没有 `webview`、没有 devtools;它的 session 拒绝每一次权限请求与权限检查,`will-download` 被 preventDefault,`setWindowOpenHandler` 拒绝每一个弹窗。对话框被禁用,因为在一扇 `show: false` 的窗口上调 `alert()`、`confirm()`、`prompt()`,给出的是一个用户无从解释的原生模态框,背后是一条要等人点掉才会解除阻塞的页面线程——这也正是下面那处 `executeJavaScript` 挂起的第二个入口。窗口是静音的,因为 Electron 默认的 `autoplayPolicy` 是 `no-user-gesture-required`,而截图要的只是像素。

**边界在哪**:同一时刻只渲染一个,最多受理四个请求(一个在渲染、三个在等),再来的答 503,期限 25 秒。期限从受理时刻起算,而不是从渲染开始时算,因为把这段时间花在排队上的请求,从它的调用方看来也一样花了这么久。取 25 而不是 30,是因为它必须比调用方自己的预算先到期:`@haoran/dsh-screenshot` 的 `AbortSignal.timeout(timeoutMs)`——默认 30 秒——从 fetch 调用那一刻起算,而本服务的期限在受理之后才创建,中间隔着建连、读请求体、JSON 解析、校验与队列检查。两边取同一个数,每次都是插件自己的信号先触发,本服务为模型写的那一行 503 或 504 永远送不到它手里。`fullPage` 截图会测量 `document.documentElement.scrollHeight` 并把窗口调到那个高度,夹到 8192 px 为止,因为无限滚动的文档报出的高度会在测量过程中一直变大。

**串行链在请求被放弃时前进,而不是只在它的 renderer settle 时前进。**`webContents.executeJavaScript` 在窗口被销毁之后永远不会 settle——`loadURL`、`capturePage` 与延时在 abort 后都会 settle,唯独它不会——所以一条等 renderer 的链,能被单个页面在本次进程的整个生命期内卡死:把 `document.documentElement.scrollHeight` 定义成一个不返回的 getter,再请求 `fullPage`,此后每一次渲染都排在一条永不前进的链后面,各自在自己的期限上被答以 504。因此 `runQueued` 让 job 与该请求自己的 abort 赛跑。被放弃的渲染可能比它在链上的那一环活得久,而这不付出任何代价:`renderInHiddenWindow` 在 abort 监听器和 `finally` 两条路径上都无条件销毁窗口,所以窗口与它的渲染进程在下一次渲染开始前就已释放。它确实改变的是每个 job 开头那次拒绝:链现在最迟在头一个请求自己的期限上就会前进,而那个时刻绝不晚于后面任何一个请求的期限,所以排队的请求拿到的是自己那份期限剩下的部分,而不是在窗口打开之前就被拒绝。

**窗口那一半是注入进来的,这正是协议可测的原因。**`startRenderService` 接收一个 `Renderer`——`(request, signal, trace) => Promise<Buffer>`——以及它要执行的边界,后者是显式的 `RenderLimits`,壳自己的数值放在同一个文件顶部的 `RENDER_LIMITS` 里,并在组合这个服务的那一个调用点传入。`apps/desktop/src/render-window.ts` 是 Electron 实现,除了窗口什么都不含。于是 32 个单元用例驱动鉴权、校验、受理、串行、期限、越过期限那一行怎么写、那个抵达 renderer 的 abort,以及链在遇到一个永不 settle 的 renderer 之后仍然活着这一点,全程不需要任何显示设备;而在真实 Electron 下运行的 `scripts/render-smoke.mjs` 覆盖它们够不着的那些事——一扇从未展示过的窗口到底会不会画、`capturePage` 是否返回被请求的视口、整页截图是否确实超出它,以及一个指向永不回答的监听的页面超时后,那个请求会不会被点名。

**监听没能打开不是拒绝启动的理由。**壳记一行日志,不带渲染变量地启动服务端,插件随后做的就是它在所有非桌面安装上做的事:去探测系统浏览器。

**插件随载荷一起走。**`apps/desktop-server/package.json` 把 `@haoran/dsh-screenshot` 声明为 `file:./vendor/haoran-dsh-screenshot-0.1.0.tgz`,那个 tarball 与它一起提交,`BUILTIN_WEB_BUNDLES` 列出它的名字,壳便像对另外两个那样把它播种进 desktop profile。`file:` tarball 正是让这条路走通、而 GitHub 归档 URL 走不通的原因:pnpm 会像对注册表版本那样为它记录 `integrity: sha512-…`,而 `pnpm deploy` 拒绝没有该字段的 lockfile 条目。带作用域的名字没有要求任何新代码——播种构造的每一条路径都是 join 出来的,`ensureLink` 本就会创建链接的父目录,也就是 `@haoran` 这个作用域目录——但它确实要求了证明这一点的测试,因为带分隔符的名字正是字符串拼接能一路蒙混过关、直到蒙混不过去的那类东西。`scripts/bundle-closure.ts` 按既有规则完整保留这个包:它的清单声明了 `dsh.bundle`,而载荷里没有任何东西以标识符导入一个 profile bundle。

**打包闸现在问的是这套机制真正回答得了的问题。**`verifyClientModules` 原本要求每个内置插件都出现在所服务 index 所列的客户端模块里,而这对一个只贡献工具、不向页面贡献任何东西的插件是假的。它现在从**载荷里**每个内置插件的清单读 `dsh.client`:声明了的必须被服务,没声明的由这次启动本身来证明——profile 列了名字而 Loader 解析不了的 bundle 是硬性启动失败,所以打印出 URL 行的服务端已经把三个都解析了——而一次没有任何内置插件声明 `dsh.client` 的运行会失败,而不是空洞地通过。

## Alternatives considered

**在载荷里分发一个浏览器。**Playwright 的 Chromium 或捆绑一个 Chrome,能让这个工具在哪里都一模一样。因体积否决:安装包存在的意义就是让不想要工具链的人下载它,而这会往一个已经含有一个浏览器的包里再塞一个。

**让插件通过服务端子进程的 stdio 驱动壳。**没有端口、没有 token、没有监听。否决,因为那条流就是日志:它的全部约定就是每个字节都进 `dsh-server.log`,把一套二进制请求/响应协议分帧塞进去,意味着壳在一条就绪行已被正则解析的管道上再拥有一套协议。

**Unix domain socket 或命名管道。**比 TCP 端口更紧,因为在 POSIX 上文件系统权限可以取代 token。否决,因为不存在单一的跨平台形式——POSIX 上是路径,Windows 上是 `\\.\pipe\…`——而插件的协议是基于 origin 的 HTTP,所以提供 socket 的壳实现的是另一份协议。

**把 endpoint 与 token 放进壳自己的 `process.env`。**少写一行,spawn 还能白拿。否决:应用此后启动的一切——终端、subagent、用户从 UI 里打开的任何东西——都会继承一个能渲染任意 `file:` URL 的 token。只传给那一个子进程,也让这两个变量落在 harness 自己的擦除之后:harness 拥有的每个 spawner 都走 `scrubbedParentEnv()`(`packages/subprocess/subprocess/src/index.ts`),它会剥掉所有 `DSH_` 前缀的名字,所以两个变量都到不了 harness 启动的进程里。不经过这个调用而自行 spawn 的插件不在这条保证之内,README 的限制小节记了这一点。

**在应用自己的 session 里渲染,或在可见窗口里渲染。**共享 session 会让模型指名的页面读到用户已登录 UI 的 cookie;在可见窗口里渲染则会把 agent 看的每一个页面搬到用户屏幕上。

**像 `dsh-at-file` 那样用 GitHub 归档 URL 声明这个插件。**试之前就否决了:归档没有 `integrity`,这正是提交钉死要绕开的那个失败(`ERR_PNPM_MISSING_TARBALL_INTEGRITY`),而这个插件也没有公开仓库可供钉一个提交。

**用 `link:` 依赖插件的工作区。**否决:那个检出不属于本仓库,所以这条依赖只在把它放在本仓库旁边的机器上才解析得了,而 `pnpm deploy` 在构建时也需要它在场。

**保留原来的客户端模块断言,再按名字豁免这个新插件。**作为又一份需要维护的声明而否决:载荷自己的清单已经说明了哪些包有浏览器那一半,而名单会在某个内置插件第一次获得或失去这一半时就开始漂移。

## Consequences

桌面端的截图不再取决于机器上装了哪些浏览器,而且它是两个后端里更准确的那个:壳会测量文档,而命令行后端渲染进一个固定高度的窗口,再把结果裁掉或补白。CLI 与服务器安装什么都没变,仍走浏览器探测。

壳现在会在应用运行期间一直持有一个打开的监听。它绑在 loopback、由 token 把守,并在 `before-quit` 时关闭;这次关闭不被等待,因为退出不该等一次渲染。

渲染是刻意做成串行且浅队列的,所以一个把期限用满才加载完的页面会占住这个位置,排在它后面的请求只拿得到自己那份期限剩下的部分。壳的视口下限是每边 16 px,而插件自己的最小值是 1,所以要求更小视口的 `screenshot` 调用在桌面端会被答以 400,在别处则由系统浏览器渲染。

那个 vendored tarball 就是这个插件的更新渠道:一个新版本意味着提交一个新的 tarball 并把标识符移过去,而携带某次构建的安装包拥有该版本,与其余每个内置插件完全一样。`THIRD_PARTY_NOTICES.md` 用一条指向该 tarball 的仓库相对链接来标识它,因为一个没发布的包没有公开 URL 可写——它是该文件里链接不指向仓库的那几条之一。

载荷把它作为又一个 profile bundle 带上,构建会在 `package: <target> payload built-in profile bundles:` 那一行点名它保留的每个 bundle。deployer 会把 `apps/desktop-server/vendor/` 连同清单一起复制进暂存树,所以打包步骤把它和已经在丢弃的 README 文件一起删掉:暂存树里已有装好的包,而它来自的那个归档在运行期什么都解析不了。
