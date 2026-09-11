# Agent Note：桌面更新安静、可续传,且只在点击后安装

Status: implemented

[English](2026-09-11-desktop-quiet-resumable-updates.md) | 中文

## 问题

尽管没有哪一次安装是在没人点击的情况下发生的,这套更新流程读起来仍然像强制。

三处呈现造成了这个读感,而它们没有一处是被请求的。静默检查发现新版本,立刻弹出一个模态框征询下载。同意之后,一扇 440×200 的窗口自己显示出来并抢走焦点,整个传输期间还占着任务栏或 Dock 的进度条。传输完成的那一瞬,第二个模态框问要不要现在重启——它出现在用户正在做别的事情的中途,前面还伴着一次 Dock 弹跳或任务栏闪烁,而且必须回答才能继续这次会话。默认按钮是「暂不」,但一个不回答就回不到工作的问题,体验上不是可选的。

在这之下,传输本身也靠不住。electron-updater 全量下载不发 `Range` 头,任何错误都会删掉半截文件(`AppUpdater.executeDownload` → `removeFileIfAny`),所以每一次尝试都要重传整个产物——本产品 macOS 构建是 170 MB,而在一台第一次原地更新还走不了差量的机器上,那就是整包再来一遍。[重试计划](../bug-fix/2026-08-21-desktop-update-download-retry.zh.md)把一次中断的代价封顶在 26 秒内的三次完整重试,这盖得住一次 Wi-Fi 切换,盖不住一个每几分钟断一次的晚上。

这两个问题其实是一个问题:一次传输只有在能承受「要多久就多久」的前提下,才可能是安静的。

## 决定

传输不可见且可续传;唯一可见的状态,是一个已下载、已校验、离安装只差一次点击的更新。

### 下载过程的任何部分都不上屏

一次检查——启动后 15 秒、此后每四小时、帮助 → 检查更新,以及设置里的那个入口——发现什么就直接开始传,不先征询。`offerDownload` 与 `offerInstall` 的非阻断那一半连同支撑它们的模块状态(`declinedVersion`、`postponedVersion`)一起删掉;`showProgress`、`showRetrying`、`updateProgress`、`closeProgress` 与 `mainWindow()?.setProgressBar(...)` 也是。`progress-window.ts` 只留 macOS 的安装提示窗,那是应用唯一欠一句解释的时刻:Squirrel 会占住屏幕十五秒上下,而这段时间里的强制退出正好落在包被替换到一半的窗口里。

帮助 → 检查更新 位置与文案都不变,因为一个消失了的菜单项没人再找得回来。它跑的是同一个静默检查,而它给出的每一句都是点击要来的:「已是最新版本」、「无法检查更新」,以及更新已经在路上时的「正在后台下载新版本」或「新版本已下载完成」。后两句只报更新在哪儿、不问任何事,因为一次什么都不产生的点击读起来就是菜单项坏了。仍有一个手动对话框在问问题,而且只出现在下载页那一层:「发现新版本 / 去下载」。保留它,是因为那一层没有别的口子把下载交出去——设置入口只能报出一个这个构建装不上的版本——而那一层的静默检查除非 feed 的红线高过在跑的版本,否则什么都不说。就地那一层永远走不到这个框:它的检查被打断时,点击得到的是「无法检查更新」,静默检查则无论有没有红线都不作声。

普通路径上根本不弹任何对话框:查出活儿来的检查,答案在更新所在的地方——因为一个写着「正在下载」的对话框,正是这次改动要拿掉的那种打断。

### 状态是一台状态机,而设置窗口是它被呈现的地方

`update-state.ts` 持有 `idle | checking | downloading | ready | failed` 与一份快照,里面没有 electron。两种状态拒绝被移动:`ready` 会熬过此后的每一次检查,所以定时检查收不回一个已经就绪的更新;`markUnavailable` 设下的那个 `failed` 在本次运行里是终局,因为一个装不上自己所下之物的构建——从源码启动的实例,或者原地安装路径已失败的 macOS 包——再往下报「离安装还有多远」已经没有意义,那次安装根本不会发生。

五个 phase 就是全集,而且刻意没有第六个用来表示「这套部署根本没有更新通道」。需要那个值的读方自己拥有它:服务器上的 `dsh web` 在自己的环境里找不到端点,自己作答;而壳只为它确实有的通道作答。`checkedAt` 是 ISO 8601 字符串而不是 epoch 毫秒;`downloading` 同时带上 `percent` 与 `transferredBytes`/`totalBytes`,而不是只带其一,于是读方永远不必从一个推另一个。

`update-service.ts` 是渲染服务与插件管理服务之外的第三条本机监听,打开与传递的方式和它们完全一样:`127.0.0.1` 加一个临时端口、一个以常数时间比较的 32 字节 token,两者都只进服务端那一个子进程的环境,叫 `DSH_DESKTOP_UPDATE_ENDPOINT` 与 `DSH_DESKTOP_UPDATE_TOKEN`。它有自己的 token,是因为三者中它借出的权力最重:`/install` 会替换掉整个应用,而渲染 token 换来的是像素,插件管理 token 换来的是装一个包。四条路由——`GET /state`、`POST /check`、`POST /download`、`POST /install`——都不读请求体;逐字段的快照契约归 `apps/desktop-shell/README.zh.md` 所有,另一个仓库里的插件正照着它写。

**`/install` 不弹任何对话框。**设置窗口里的那次点击就是同意,再弹一个原生确认框只会把一次点击之前刚回答过的问题重问一遍。真正保护这条路由的是 phase:它在 `ready` 之外一律被拒,所以它唯一能装上的产物,是 sha512 已经与清单对上的那一个。

**开这条路由的 token,服务端里跑的每个插件都够得着。**它注入的是服务端子进程的环境,而那个进程里的第三方插件读环境变量和读别的东西一样;那些插件自己不声明任何审批闸。上面那段论证针对的是「页面自己也能画一个确认框」,这里是它的另一面。这条路由能被驱使去做的事仍然有上限:退出应用,装上一个 sha512 已被 electron-updater 逐字节对着更新源清单核对过的产物(`DownloadedUpdateHelper.getValidCachedUpdateFile`),macOS 还要在此之上拒绝一切不满足运行中 bundle 的 designated requirement 的东西。伪造一个暂存文件需要 sha512 的原像,所以一个恶意插件最坏买到的是一次没人要求的重启,而不是一段自选的代码。正因如此,与插件管理服务那个原生确认之间的不对称被保留下来:那个服务装的是调用方指名的包,这个服务装的是更新源发布的那一个产物。代价是一条审计项,记在 `apps/desktop-shell/README.zh.md`:引入一个第三方插件时,要一并看它有没有读 `DSH_DESKTOP_UPDATE_TOKEN`。

它先答再做:`{ "ok": true }` 先上线,安装排在下一个 tick。安装会停掉嵌入服务端,并把机器交给一个要替换掉本进程的安装器,所以一个还等在响应上的调用方,会把那次断开的连接读成一次失败的安装——为一个正在被应用的更新报出一次失败。

**设置那一侧是一个插件,不属于壳。**`@haoran/dsh-desktop-update` 0.1.1 以 tarball 形式放在 `apps/desktop-server/vendor/` 下,由 `cd2244802e` 引入。它的 host 半边是一个叫 `desktopUpdate` 的 Typert 服务,代理那四条路由,端点与 token 都留在网关的它这一侧;环境里两者都没有时,`state()` 答 `phase: 'unsupported'`,插件什么都不注册。它的浏览器半边注册一个 `settings.section`——id 是 `desktop-update`,即「更新」页——以及一个只在 `phase === 'ready'` 时才渲染的动作:设置行右端的那个更新按钮。那个按钮坐的位子是 `settings.trigger.action`,即核心补丁 D 新增的那个 list 槽(合并提交 `f934c3ae2a`,在 `.claude/core-patches.md` 在册)。补丁不在场时,动作退到 `sidebar.footer.action`——凡是带侧栏的组合都声明它——因为 `ctx.slots.inject` 只会为某个构建确实声明过的 key 触发回调,于是往打了补丁的那个 key 上注入本身就是探测。插件自己的 Agent Note 跟着它的源码走,在 `dsh-plugins` 仓的 `packages/desktop-update/`。

**0.1.0 把那个服务的安装方法叫作 `install`,而客户端 API 保留了这个名字。**`RemoteNamespaceService` 自己的原型上就带着 `install()`,`assertMethodAvailable` 拒绝任何跟它撞名的方法,于是装好的构建里 `ctx.remote.$mount()` 抛出 `client api: method "desktopUpdate/install" conflicts with its namespace service`,Loader 条目随之失败,web 客户端把它变成 `Failed to load plugins`——整页都没了,本插件那一部分和别人的一起。0.1.1 把方法改名为 `installUpdate`,壳那条 `/install` loopback 路由原样不动。放 0.1.0 过关的那次打包构建冒烟挂的是 vm 桩,里面没有这条规则;驱动真实客户端 API 的门禁是 `2026-09-11-vendored-client-runtime-gate`。

### 传输分两半跑,而且顺序是定的

`download()` 仍然先按既有退避跑 `downloadUpdate()`,因为那一半才能取差量更新——相邻两个发布之间实测是 170,291 KB 产物里的 12,392 KB。只有在计划耗尽之后,`transferWithFallback` 才把同一个产物交给 `resumable-download.ts`:它带着 `If-Range` 校验子要 `bytes=<have>-`,追加写进一个 `.part` 文件,边写边算哈希,收尾时拿整份文件对着清单的 base64 sha512 校验。它自己那份计划更长也更慢——2 秒、10 秒、30 秒、2 分钟、5 分钟——因为它的每次尝试花掉的是一个请求,而不是整个产物。

随后 `pending-cache.ts` 把校验通过的文件落到 `<cacheDir>/pending/<fileName>`,旁边写上 electron-updater 自己会写的那份 `update-info.json`,这次传输再调一次 `downloadUpdate()`。库在开 socket 之前先核对缓存(`AppUpdater.js:604-608`),从缓存取文件,两个平台都零网络 I/O 地发出 `update-downloaded`——于是安装路径连同 `quitAndInstall` 都还是原来那一条。

**续传在第一次中断就放弃了,把它照出来的是一个打好包的构建对着会掐断的更新源。**验收台供的是真产物,到 20 MB 就 `socket.destroy()`(`--cut-after`);壳记下库自己那次下载的三轮重试、接手兜底,然后用一行字结束了整次传输——`resume did not finish: terminated`——留下一个 19,988,480 字节的 `.part` 文件,再没向更新源要过任何东西。`RESUME_RETRY_DELAYS_MS` 一次都没走到。Node 的 `fetch` 把被切断的响应正文抛成一个 `TypeError`,它的整条消息就是 `terminated`,唯一的身份信息在 `cause` 上——关闭时是 undici 的 `SocketError`,重置时是一个普通的 `ECONNRESET`——而 `classifyDownloadError` 只从最顶层读 `code`,于是长传输上最寻常的那种失败,按「认不出就算致命」的默认落进了致命。同一次判读还决定着一次被切断的 `latest-mac.yml` 请求会不会把 macOS 踢出原地安装那一层,因为 `fetchFeed` 用的也是全局 `fetch`。两处改动把它合上:分类器顺着 `cause` 链走,由最外层那个 code 定夺;`resumable-download.ts` 把它能从中续下去的每一种中断——正文被切断、超过空闲上限的停滞、正文短于回答所承诺的长度——都以本仓自己拥有的同一个 code 抛出,于是结论不依赖任何一句消息文本。单测之所以没抓住它,是因为它们只断言被切断的传输抛了错,从没断言策略如何判定它抛出的那个错。

`.part` 文件按版本加产物名命名,住在缓存目录的**根**下而不是 `pending` 里:electron-updater 自己下载路径上的任何失败都会清空 `pending`,而那种失败恰恰就是可续传这一半存在的理由。更新源已经翻篇的那些 `.part`,下一次传输开始时就被丢掉。

### 强制更新那条红线原样不动

`--minimum-version` 仍然不经征询就下载,仍然把启动挡在启动页后面,仍然以那个单按钮的「重启安装」对话框收尾。它**不**走续传兜底:在传输返回之前应用是关着的,而一份要花上几分钟续传的计划,在那里读起来就是卡死,重试计划的半分钟则不会。

这条路上真正变了的是启动页那行提示,它现在带上传输的完成度。这是唯一一次用户干等、屏幕上又没有别的东西的下载,而一行在 170 MB 里始终不变的字,和卡死没有区别。变的是那一行字被就地改写——没有窗口,没有任务栏或 Dock 进度,普通路径上更是什么都没有:传输开始时启动页早已不在。

## 备选方案

**在安装点击之后再要一次确认。**插件管理服务在装包之前要求一个原生模态框,而 `/install` 干的事更重。这两件事并不同类:装包是由一个页面发起的,而那个页面正是被攻陷的插件也能画出来的东西;更新按钮则由产品自己的设置窗口画出,并且写明了它要做什么。在那里再确认一次,等于去问一个一次点击之前刚回答过的问题——正是这次改动要拿掉的那种提示形状。

**让帮助 → 检查更新 继续弹旧的下载征询框。**这会给偏好对话框的人留一条通往旧流程的路,同时也会在定时检查复用同一段代码的那条路上把打断留下来。一套流程,一种行为。

**替换 `httpExecutor`,或者继承 `MacUpdater`。**此前已经否决过,理由没有变:`httpExecutor` 在构造函数里赋值且类型标为内部,而 `updateDownloaded` 是私有的,还伸手去动这个类自己拥有的本地代理服务器。把文件落进缓存目录同样依赖那套私有布局,但它是从外面动它——版本一升,失败是响亮的,而不是悄悄改掉一个子类覆写的东西。

**用续传取代重试,而不是排在它后面。**170 MB 的整包续传严格劣于 12 MB 的差量下载,而差量那条路是 electron-updater 的。顺序比这两半各自都更重要。

## 后果

一次更新可以跨越它遇到的任意多次中断,跨会话、跨重启地传完,而盯着屏幕的人看不出它正在发生。过去要赔上一整个会话更新通道的事,现在在可见层面什么都不花;用户听说这次更新的第一句话,就是它已经就绪。

代价是对 electron-updater 私有缓存布局的一条硬依赖——`pending/` 目录、`update-info.json` 的三个字段,以及 `getCacheUpdateFileName()` 的取名规则——它们都不是有文档的契约。`pnpm patchedDependencies` 把这个库钉死在 `6.8.9`,所以任何升级都会在到达构建之前先让安装失败;这个钉子就是本方案依赖的哨兵。另有两项较小的代价:每一次命中缓存的 `downloadUpdate()` 都要重算整个产物的哈希(`DownloadedUpdateHelper.js:123`),大文件上是几秒;Windows 上缓存短路会跳过写在下载任务内部的 `verifySignature`。本产品今天不签任何 Windows 可执行文件,所以被跳过的那一项本来也不会运行——但一旦开始签名,这条路必须自己验签,README 已把它记为前提。

这条决定推翻了[重试那篇 note](../bug-fix/2026-08-21-desktop-update-download-retry.zh.md) 否决过的那个备选,而且是按它自己的说法推翻的。那篇 note 称壳自有的可续传下载器是「对连接糟糕的客户端来说的正确答案」,并给了建造它的唯一条件:现场证据表明仍有可观比例的下载失败。这个条件是被取代而不是被满足的——真正到来的是一条产品要求,下载不得显眼;而一次无法续传的传输不可能安静,因为它的每一次中断都得在用户看得见的地方被报告、被重试。重试计划本身没有改动,而且仍然排在前面;新的是它之后发生的事。

`tests/update-state.spec.ts` 钉住每一条转移,以及那两种拒绝被移动的状态。`tests/update-service.spec.ts` 钉住四条路由、404 先于 401 的判定顺序,以及 `ready` 之外拒绝安装。`tests/resumable-download.spec.ts` 打断一个支持 `Range` 的本地服务器,证明续传后文件的 sha512、请求带上了偏移与校验子、`200` 与 `416` 两种回答都能干净地重来,以及摘要不符会丢掉半截文件而单纯的中断会把它留着。它还会在正文中途重置连接而不是关闭它,并用真正的 `withRetry` 配一副瞬时时钟把那次传输一路带到完整且校验通过的产物——正是现场失败的那种情形。`tests/pending-cache.spec.ts` 拿 electron-updater 自己的 `DownloadedUpdateHelper.validateDownloadedPath` 去核对落好的目录,于是这次交接是由将来真正读它的那段代码证明的,而不是由对它规则的一次复述。`tests/download-retry.spec.ts` 用假件钉住这两半的顺序,也钉住 Node 的 `fetch` 会抛出的那些形状如何判定——只在 `cause` 链深处才找得到的 code、一条指回自己的链,以及一个裹着网络失败的拒绝。`tests/updater-tiers.spec.ts` 用替身顶掉 electron 与 electron-updater,钉住一次 macOS 检查落在哪一层、更新已经在路上时手动检查答什么,以及启动门那行提示带出的完成度。更新通道没有快照泳道,它其余的证据是一个打好包的构建对着真实更新源跑一遍。
