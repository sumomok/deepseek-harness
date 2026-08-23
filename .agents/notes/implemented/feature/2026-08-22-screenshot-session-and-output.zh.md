# Agent Note: 截图工具能渲染它被指向的那个页面了

Status: implemented

[English](2026-08-22-screenshot-session-and-output.md) | 中文

## Problem

两个会话,在两个平台上,被要求为 `http://117.73.8.33:30010/` 上一个需要登录的 Redmine 写一份带插图的运维手册。两边都调了一次 `screenshot`,拿到登录页,然后就丢下了这个工具。

Windows 那一边跑在 rc.17 上,写了 `proxy.mjs`——一个挡在 Redmine 前面、往请求里注入 cookie 的反向代理——并在 14 次重启之间改了它 28 次。等它终于产出图像,它仍然找不到这些图像的文件,于是又写了 `grabshot.ps1`,按修改时间和大小去 `~/.dsh/attachments/v1/objects/` 里捞 PNG。这一条也断了:附件存储是内容寻址的,重新截同一个页面根本不会写出新对象,而"取最新文件"这个启发式取回来的是上一张截图。

macOS 那一边出于同样的原因写了 `/tmp/redmine_proxy.py`,随后彻底放弃了这个工具,改写 `/tmp/batch_shots.sh` 去驱动它自己的无头 Chrome,把图片输出到 `images/`。它还在已安装的应用里搜过有没有随包的 playwright 或 puppeteer。

两个会话都再没有回头考虑过这个内置工具,而原因在会话日志里,不在模型里。装配出来的系统提示词里有十一行 `Use the X tool` 指令——read、write、edit、glob、grep、web_search、goal、workflow、ralph、subagent、subagent_fork——没有一行是给 `screenshot` 的。它在那里唯一的出场是 code-mode 段落里那句否定式的:*the browser provides no implicit DOM, route, or screenshot context*。而工具自己的描述写的是 `Use it to verify visual work (layout, colors, spacing) against a reference before calling it done`,这把一件取像仪器框定成了"检查自己刚写的 CSS"。加进一份没人会再读的 schema 里的参数不是能力,提示词从不提名的工具也不是。

同一个工具返回的图像尺寸还取决于机器。`capturePage` 返回的位图带着显示器的缩放系数,所以 `screenshot({ width: 900, height: 700 })` 在 Retina Mac 上存下的是 1800x1400,在 Windows 上是 900x700。在 rc.17 那条 2000 px 的准入上限下,这让工具自己的默认视口——1024x768,截出来是 2048x1536——直接以 `IMAGE_DIMENSION_TOO_LARGE` 失败。[rc.18 把准入抬到 8192,并把更大的归一化下压到 2048](2026-08-20-unified-image-request-pipeline.zh.md),失败因此结束,尺寸依然是错的:1440x900 回来的是 2048x1280,既不是请求的视口,也不是它的整数倍,而 `width` 与 `height` 对模型的说法是"视口像素"。

## Decision

`@haoran/dsh-screenshot` 0.1.4 与壳的渲染服务:带上会话、说出渲染落在哪里、写出文件,并返回被请求的那个尺寸。

**一个请求可以带 `headers` 与 `cookies`。**两者都是 string 的 name→value 映射。插件只检查模型写的是字符串、名字非空,然后原样送出;边界归渲染服务所有,因为发出那次请求的是它那一侧。`render-service.ts` 在 `resolveRequest` 里校验它们:两个映射合起来最多 24 个条目、8 KB,名字对 RFC 9110 的 token 文法,头部值对可见 ASCII 加空格与制表符,cookie 值对 RFC 6265 的 cookie-octet。`cookie` 这个头会被指名拒绝并指向 `cookies` 字段。在 `file:` URL 上带 headers 或 cookies 是 422。

这两个字段做的事不一样,而这个不一样正是两个都要有的理由。`render-window.ts` 在加载之前通过 `session.cookies.set` 把 cookie 设到这次渲染自己的内存 session 上,于是它们覆盖页面发出的每一个请求——一个图片全部 401 的已登录页面,不是任何人想看的那个页面。headers 走 `loadURL(url, { extraHeaders })`,那只是主框架那一次导航,而那正是 bearer token 或 Host 覆写想要的位置。每一条隔离性质都没有变:每次渲染独有的 `partition:` session、拒绝一切权限、不许下载、不许对话框、静音、在每一条退出路径上销毁。凭据由调用方提供,壳一点也不留。

**cookie 设在路径 `/` 上,而路径之所以要显式给出,是因为默认值是一个目录。**`session.cookies.set` 不带 `path` 调用时,Chromium 套用的是 RFC 6265 的默认路径,也就是这个 cookie 是从哪个 URL 设进去的、那个 URL 所在的目录——而不是整个站点。在真实 Electron 上以 `cookies: { probe: 'yes' }` 与 `headers: { 'x-note': 'hello' }` 渲染 `/deep/page.html`,服务器看到的是:

```
/deep/page.html   cookie=probe=yes    x-note=hello
/api/pixel.png    cookie=(none)
/deep/sib.png     cookie=probe=yes
```

作用域是 `/deep/` 的 cookie 覆盖文档和它的邻居,碰不到另一个顶层路径下的任何东西,而渲染照样成功、照样返回一张看上去很像样的图。这正是那个首要用例:应用把页面放在 `/app/…`、把数据放在 `/api/…`,于是一个按目录划定作用域的 cookie 到了 API 那边就是未登录状态,截下来的正是这个字段本来要终结的那张空白页或未登录页。

用 `path: '/'` 而不是从 URL 算出来的某个前缀,是因为调用方指名的是一个属于这个站点的 cookie,而不是属于某个目录的 cookie,而真实的会话 cookie 就是以 `Path=/` 下发的。它也没有把任何东西放宽:session 是这次渲染自己的内存 session、只加载一个页面,所以一个站点级的 cookie 再没有别的页面可去,并且随窗口一起消亡。`domain` 保持不设,于是 cookie 是 host-only 的——调用方提供的凭据是给它指名的那台主机的。这两者调用方都改不了,因为 cookie-octet 文法会拒掉那个用来起头写属性的 `;`。

**成功的渲染会说出"这不是你要的那个页面"。**服务本来就知道:`RenderTrace` 从 `did-navigate` 记下主框架的落点,[超时那一行](2026-08-22-render-timeout-diagnostics.zh.md)会点出它。现在 `RenderTrace.landedElsewhere()` 把它暴露出来,`runQueued` 在渲染之后读它,当主框架落在请求所指之外时,200 便带上 `x-dsh-render-landed-url`——可见 ASCII 之外做百分号编码,截到 96 个字符,并在 URL 归一化之后比较,所以 Chromium 给源地址补的那个斜杠不算重定向。插件把这个响应头变成工具结果里的一句话:

```
The main frame ended at http://10.0.0.4:30010/login?back_url=/issues, not the requested URL: the site redirected the render, so pass cookies or headers to capture it with a session.
```

它放在结果正文里而不是错误里,因为这次渲染成功了;插件对引用错误响应体的那条 500 字符纪律不适用于它,落点长度改由壳来限。一张登录页的截图被不加评论地交回去,正是把两个会话推上代理那条路的东西。

**超时的渲染也会说同一件事,用同一套措辞。**[超时那一行](2026-08-22-render-timeout-diagnostics.zh.md)点出主框架落在哪里——`main document 200 at http://10.0.0.4:30010/login?back_url=/issues`——并在它旁边带上重试方式:`pass cookies or headers to capture it with a session`,与成功那句话结尾的措辞一模一样,于是无论这次渲染怎么结束,调用方读到的都是同一条指示。条件是服务真正知道的那件事,`RenderTrace.landedElsewhere()`,而不是这是不是一张登录页。导航走掉的 `file:` 渲染只说出落点就打住,因为 `resolveRequest` 对这个 scheme 上的 headers 或 cookies 答的是 422,而服务自己会拒绝的建议比不给建议更糟。load 之后的阶段同样点出落点——`page loaded at http://127.0.0.1:18099/login, timed out while capturing`——于是重试方式绝不会脱离它所依据的那个事实单独出现。

**这句话摆在行里的哪个位置,才是这次的决定。**它印在待完成请求列表之前,而不是行尾。它前面的每一样都是有界的——超时时长、一个状态码、截到 96 字符的落点 URL,以及固定措辞,加起来不到 250 字符——而那份列表随页面增长,同时 `TIMEOUT_LINE_CHARS` 在 500 处截掉行尾,因为插件从一份错误响应体里也就引用这么多。因此追加在列表之后的重试方式,恰恰会在卡住的渲染最难解释的那些页面上被丢掉:在途请求最多的那些。把它放在前面,最坏情况下的代价是第三条待完成 URL 的尾巴,而那是这一行里最便宜的损失,因为 URL 是从尾部截的,而说清哪个请求卡住的主机名在它的头部。按事故本身的形状量过,带上重试方式的那一行是 353 个字符;单元测试驱动的最坏情况——一个被截断的落点 URL 加十二条长 URL——会撞上 500 的截断,而整句重试方式和待完成列表的开头仍在它前面。

**系统浏览器后端选择拒绝,而不是假装。**`renderScreenshot` 负责选后端,而带着 headers 或 cookies 的调用在 `--headless=new --screenshot` 这条命令行上会以一句话失败,点名这个后端做不到什么。悄悄把它们丢掉,交回来的恰恰是这次改动要消灭的那件产物。

**`outputPath` 把 PNG 写成文件。**图像块没有变,仍然是模型去看的那样东西;文件则是后续工作能用的那样东西。相对路径按调用会话的工作区(`exec.agent.session.header.cwd`)解析,与 harness 里其他每一个写文件的工具一致,而解析出来的路径必须留在工作区之内。工作区内缺失的父目录会被创建,已存在的文件会被替换,结果会说出它写了哪条路径、以及有没有替换掉什么。没有会话的调用根本不能要文件,因为没有工作区可以安放它。

这次写入是一次普通的 `node:fs` 写。`ctx.fs` 没有字节写——`writeText` 收的是 UTF-8 文本——所以 PNG 过不了文件系统这道缝,而插件也没有声明任何可以用来查询调用方真实可写根目录的 sandbox 依赖。会话工作区是这个插件能够诚实地划出的那条边界,它比任何部署策略都更窄,而不是更宽。

**描述说清了这个工具是干什么的,一行提示词在模型真会读到的地方又说了一遍。**描述现在以 `Render any page in a headless browser and return what it looks like as an image` 开头,并点名 `cookies`、`headers` 与 `outputPath`;"检查自己刚写的 CSS"那套框定没有了。`applyScreenshotTool` 把工具与一段 section 一起注册,用的是 harness 自己那十一行的语气:

```
Use the screenshot tool to look at any page as pixels — your own HTML or CSS work, or a live site you need to see, including one behind a login: pass cookies or headers to render it with a session, and outputPath to save the PNG as a file as well.
```

`ctx.systemPrompt.section({ name: 'tool:screenshot', order: 100, … })` 用的正是 `tool:read`、`tool:write`、`tool:edit` 用的那个公开注册表,order 也相同;插件把 `systemPrompt` 加进它的 `inject`,并对 `@deepseek-ai/dsh-system-prompt` 加了一条 peer 依赖。`packages/` 里什么都没改。这个工具配得上这一行、而别的插件工具不配,原因是这次失败是被测出来的而不是被假设的:两个会话、两个平台、同一堵墙,每一边都花了大约一小时,用代理和文件打捞器把那个缺掉的参数重造了一遍。这次量到的东西可以推广成什么——新增参数却不同时改描述等于没有新增、失败信息是补回遗漏参数最省成本的位置、提示词 section 需要一条记录在案的理由——写在[工具实操手册](../../../../docs/cookbook/adding-a-tool.zh.md)里。

**截图就是被请求的那个尺寸。**`render-window.ts` 在编码之前把截到的 `NativeImage` 缩放到请求的 CSS 像素——`image.resize({ width, height, quality: 'best' })`,对着 `electron@43.4.0` 的 `electron.d.ts` 核对过(`resize(options: ResizeOptions): NativeImage`,`quality` 取 `good | better | best` 之一)——而当截图本来就是那个尺寸时跳过缩放。整页截图缩放到请求的宽度,以及它测得并据此设过窗口的那个内容高度。窗口保留显示器自己的缩放系数:`--force-device-scale-factor` 是进程级的,会为了修一张截图而改变用户看得见的那扇窗。把 2x 的截图降采样到 1x,不会丢掉 1x 渲染本来就有的任何东西。

## Wire contract

| 字段 | 方向 | 含义 |
|---|---|---|
| `headers` | 请求 | name→value 映射;挂在主框架那一次导航上 |
| `cookies` | 请求 | name→value 映射;加载前设到这次渲染的 session 上、路径为 `/`,覆盖页面发出的每一个请求 |
| `x-dsh-render-landed-url` | 响应,200 | 主框架最终落在哪里,当那不是请求所指的地址时 |

只有调用带了 `headers` 与 `cookies` 时插件才发它们,所以一个两者都不提的请求与 rc.18 发出的那一个逐字节相同。一个无法履行它们的壳必须拒绝该请求;README 把这一条写成壳所实现的契约。

## Alternatives considered

**一个注入 cookie 的反向代理,和一个去附件存储里打捞的工具。**两个会话造的正是这两样,而两样都是把对的直觉用在了错的层上:代理在已经会发请求头的浏览器之外重造了请求头,打捞器在已经拿着字节的工具之外重造了一条文件路径。代理的代价是一个进程、一个端口,以及每个站点一次重写;打捞器则对内容寻址的存储根本不可能成立,而这正是它的 `Get-ChildItem | Sort-Object LastWriteTime` 用最硬的方式发现的事。作为证据而非设计被否决:它们是参数缺席时调用方会做的事,也是这件事代价几何的量度。

**强制一个进程级的设备缩放系数。**一个开关——`app.commandLine.appendSwitch('force-device-scale-factor', '1')`——每次截图就都是 1x,不必缩放。否决:它是进程级的。用户自己的窗口也在这个进程里,为了让截图出来对而让那扇窗以错误的缩放渲染,是拿一个看得见的产品缺陷去换一个看不见的。

**不动描述,让 schema 去承载新参数。**能想到的最便宜的改法,也正是证据推翻的那一个:丢下这个工具的模型,面前摆着的就是一份完整的 schema。描述与那行提示词才是这次改动,参数是它们所指向的东西。

**只在失败时报告落点。**[超时诊断那一篇](2026-08-22-render-timeout-diagnostics.zh.md)否决过"成功路径上的响应头",理由是没有人会读它——插件是本仓库并不拥有的一个 vendored tarball。那个理由不成立了:这次改动把两半一起发出去,而成功路径正是事故真正走的那一条,因为跳向登录页的重定向渲染得很快、答的是 200。

**把重试方式追加在超时那一行的末尾。**最容易想到的位置,也正是 500 字符的截断打败的那一个:一个有十来条在途请求的页面会把这行撑爆,而被丢掉的就是行尾——于是建议恰好从最需要它的那些渲染里消失。按上面那笔账否决。

**给重试方式预留位置,把待完成列表截到刚好放得下。**两半都能保证,诊断信息的阅读顺序也保住了。作为"为排序已经做到的事再造一套机器"被否决:重试方式在列表之前时,截断唯一可能落下的位置就是列表内部,而这正是预留位置本来要安排的结果。

**识别登录页。**否决:服务知道主框架落在哪里,却对那个页面上有什么一无所知,于是识别器只会把一个猜测印成事实——同意页、地区闸和错误页同样会重定向。`landedElsewhere()` 才是这次渲染量到的东西。

**落在别处就拒绝这次渲染,而不是报告它。**很诱人,而且是错的:登录页有时正是调用方想拍的那个页面,跳向同意页或地区页的重定向也并不总是失败。告诉调用方它拿到的是什么,由它来决定。

**`cookies` 用一个 `Cookie:` 头字符串。**一个字段而不是两个,也更接近调用方从 devtools 里复制出来的东西。否决:cookie 头只覆盖文档、覆盖不到文档里的任何东西,于是已登录页面回来时每一张图片、每一份样式表都在 401——这是比登录页更糟的一件产物,因为它看上去像渲染出了 bug。name→value 映射也正是 `session.cookies.set` 要的形状,于是没有任何东西需要去解析一个 cookie 头。

**`outputPath` 走 `ctx.fs` 写。**如果它有字节写,这就是对的那道缝。它只有 `writeText`,再没有别的;而为了一个插件的 PNG 去给一个核心包加一个字节写,是从错误的一端去改一个共享能力。这里是记录下来而不是关掉:文件系统缝上的一个 `writeBytes` 会把这次写入移到 sandbox 策略之后,那才是它该在的地方。

**给想要 2x 图像的调用方一个有界的 `scale` 参数。**刻意没有发。`width` 与 `height` 已经说清了调用方要多少像素,而第二个乘数会与附件存储自己 2048 的归一化相互作用——1440 宽的视口上一个 `scale: 2` 产出的,恰好是这次改动要停止交回的那个 2048x1280。想要更多细节的调用方去要一个更大的视口,那是一个名字与含义相符的旋钮。

## Consequences

工具结果现在会在抵达模型的正文里点出一个第三方主机与一次登录重定向。这正是要点——它是"页面没渲染出来"与"站点把这次渲染送去了它的登录页"之间的差别——而这也值得直说:被报告的落点 URL 是页面自己产生的。

一次被重定向的渲染的 504 长了 53 个字符,而且全在待完成列表之前,于是本来就已经撞上 500 截断的行,末尾那条待完成 URL 会少显示这么多。这个取舍是刻意的:URL 是从尾部截的,那里是它最不具辨识度的部分,而它让出位置换来的重试方式,是这一行里调用方唯一能据以行动的东西。

插件现在会携带调用方提供的凭据。它们活在随渲染窗口一起消亡的 session 上,什么都不持久化,壳也不生成任何自己的凭据;README 里与 `@haoran/dsh-llm-permission-gateway` 的配对说明已经更新,写明 `screenshot` 调用也因为这个理由值得审查模型的注意。权限闸像审别的调用一样审它。

图像不再随显示器而变。一次 `screenshot` 调用在 Retina Mac 与 Windows 上答的都是被请求的那个视口,这也意味着对一次普通截图来说 rc.18 的归一化不再触发:没有任何调用方没有明确要过的东西会撞上 2048 的天花板。这是对 rc.18 已发布行为的一次刻意改变——原来以 2x 回来的截图现在以 1x 回来,拿一张存下来的 rc.18 截图与同一请求的新截图对比的人,会看到不同的像素尺寸。

一个第三方插件现在会往系统提示词里贡献内容。这个注册表是公开的,机制也正是 harness 自己的工具所用的那一个,但提示词是一份共享预算,而这是一个先例:一行、一个工具,以及"没有它这个工具就够不着"的证据。

一个没有壳的渲染服务的安装,现在比有它的安装更窄。带会话的 `screenshot` 调用在那里会被拒绝,而不是被答以一个未登录的页面;这是诚实的结果,也是桌面客户端与其他每一个界面之间一处看得见的差别。

## Testing

`apps/desktop/tests/render-service.spec.ts` 覆盖新的校验——不是映射的字段、不是字符串的值、不合 token 的名字、一个 `cookie` 头、头部值里的 CR/LF 与 cookie 值里的分号或逗号、两者共享的条目数与字节边界、`file:` 的拒绝,以及只有当请求真的带了映射时 renderer 才收到它们——另加落点响应头:trace 落在别处时带着 URL 出现、停在原地时不出现、非 ASCII 时做百分号编码、过长时被截断。

同一套测试把超时那一行当作完整字符串来断言:导航期间的落点与重试方式、load 之后的落点与重试方式(`page loaded at …, timed out while capturing`)、只说落点而不给重试方式的 `file:` 渲染,以及截断用例——一个被截断的落点 URL 加十二条长的待完成 URL,此时 `pass cookies or headers to capture it with a session, 12 requests pending: ` 必须完整出现在一行以省略号结尾的 500 字符里。一旦重试方式被挪到列表之后,这一条断言就会失败,而这正是这个位置要挡住的回归。

`apps/desktop/scripts/render-smoke.mjs` 覆盖任何注入的 renderer 都够不着的那一半。它起一个站点:任何没有会话的访问都被重定向到 `/login`,并对着真实 Chromium 用三种方式渲染它——不带会话(200 加落点响应头)、带 cookie、带 header(200,没有那个头)。第二个站点用例把页面放在 `/app/issues/page`,一张图在它旁边、另一张在 `/api/pixel.png`,断言的是那个服务器收到了什么,而不是回来的像素:cookie 出现在文档和两张图上,额外的 header 只出现在那次导航上、两张图都没有。对像素做断言在按目录划定作用域的 cookie 下同样会通过,因为一个图片全部 401 的页面照样编码得出一张 PNG。它的视口用例断言截图正好是被请求的尺寸,而在 Retina Mac 上,这一条就是"缩放确实跑了"的断言。还有一个用例是真实重定向与真实在途请求唯一相遇的地方:它渲染的登录页会加载一张来自永不作答的监听器的图片,于是在 2 秒的截止时间下,504 那一行同时带着 Chromium 通过 `did-navigate` 报出的落点和重试方式,而 `render-smoke` 会把这一行打印出来。

插件自己的测试覆盖 `outputPath`(写在工作区内、替换的报告、路径在工作区之外与调用没有会话这两种拒绝)、带会话调用在系统浏览器后端上的拒绝、渲染结果里那句落点说明,以及 `applyScreenshotTool` 确实在工具旁边注册了那段提示词 section。
