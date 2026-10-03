# @deepseek-ai/dsh-desktop-shell

[English](README.md) | 中文

桌面客户端:Electron 壳,主进程启动内嵌的 web 服务器——即 [apps/desktop-server](../desktop-server/README.zh.md) 经 pnpm deploy 物化的闭包,跑在随包捆绑的真实 Node 运行时上(绝不用 Electron 内建 Node,服务端因此保持在被测试的 engines 线上,`node:sqlite` 与原装 N-API 预编译产物照常工作)——传入 `--no-open` 使服务端不把地址交给系统浏览器,等到 `dsh web:` URL 行后在原生窗口里打开所服务的 UI。窗口是纯浏览器面:无 preload、无 Node 集成;外部链接交给系统浏览器。退出时拆除整棵服务器进程树(SIGTERM + 超时升级;Windows 走 `taskkill /T`)。

**工作区包名是 `@deepseek-ai/dsh-desktop-shell`,安装后的应用名却是 `@deepseek-ai/dsh-desktop`**:上游有自己的 `@deepseek-ai/dsh-desktop`、占着 `apps/desktop`,而 Electron 的 `userData`、`sessionData`、macOS 的 `logs` 目录以及更新器缓存目录都由应用名推出,改掉它会让每个已安装版本的 cookie、登录分区与 `desktop-state.json` 全部够不着。`electron-builder.yml` 的 `extraMetadata.name` 钉住打包的那一半,`src/app-identity.ts` 钉住源码树启动,`tests/artifact-names.spec.ts` 要求两者相等。

## 构建安装包

```sh
pnpm exec tsx apps/desktop-shell/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop-shell/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

产物落在 `apps/desktop-shell/dist-app/`。流水线按 python/sdk-runtime 配方暂存服务端(legacy hoisted `pnpm deploy`、恢复 hoist、物化符号链接),删掉本机编译的原生 `build/` 树以强制走多平台预编译产物,补齐 macOS 安装时跳过的平台分包可选依赖的 Windows x64 成员(名字里写 `win32-x64`,或像 sherpa-onnx 那样写 `win-x64`;以版本范围声明的成员,取本机已装成员的版本),再按平台暂存 Node 运行时(`--skip-repo-build` / `--skip-deploy` 复用既有产物)。仓库构建是带 `DSH_CLIENT_TITLE=北冥` 的 `pnpm run build`，该值是所有界面语言下的浏览器标题（`scripts/client-build.ts`）；客户端构建记录或 `apps/web/dist/index.html` 缺少这个标题时，运行在暂存之前停下，`--skip-repo-build` 也一样。通过这项检查后再打包 `@deepseek-ai/dsh-desktop-app`；它的浏览器半边不嵌入任何客户端构建取值。每份载荷冒烟测试之前先过一道载荷门禁:每条平台规则至少丢弃一个目录,每个平台分包目录都要对得上它所在的 target,活下来的模块不得按名解析已被裁掉的包。每次运行(`--skip-deploy` 也一样)还会在暂存的 LibreOffice kit 为 `darwin-arm64` 或 `win32-x64` 声明了 `ENGINE_DOWNLOADS` 没登记的引擎时停下(见「Office 引擎服务」一节);kit 发了新版之后,重新部署就可能暂存到这样的 kit。登记这个引擎要它已发布压缩包的大小和 `dist.integrity`,还要在这个版本上验过一次转换;不登记,就用 `--skip-deploy` 复用一份能通过这项检查的暂存。不带 `--skip-deploy` 的运行在部署之前先删掉 `staging/server`,所以被这项检查停下的运行留下的是被拒的 kit;能通过检查的暂存要在这样的运行之前另外复制一份,复用前再拷回 `staging/server`,`--skip-deploy` 才会用到它。

**一次运行只构建被点名的平台,绝不去猜它能猜到的那个**:`--mac`、`--win`,或者两者都要;两个都不给的运行会在构建任何东西之前停下。运行结束时它会检查该版本为这些平台该交付的每一个文件——mac 的 zip 与 dmg、Windows 安装程序,以及各自的 `.blockmap`——都在 `dist-app` 里、非空、而且**是本次运行开始之后写下的**,打印通过校验的清单,并点名其中缺失、为空或属于遗留的文件。`dist-app` 从不清空,过去每个版本的产物都还在;而修完一个问题重打同一个版本时,该版本自己的文件早已顶着完全相同的名字躺在那里:光看「在不在」分不出「某个平台压根没构建」和「某个平台的产物是上一次运行留下的」。期望的文件名是 electron-builder 对已声明 target 的默认命名,放在 `scripts/artifact-names.ts`,由 `tests/artifact-names.spec.ts` 对着 `electron-builder.yml` 钉住。

**整个构建跑在自己创建、结束即删的一次性 `$DSH_HOME` 上**,于是它启动的任何服务端都不会改动这台机器自己的 harness 状态——`prepareProfile` 会重写 profile 的根配置,`healProfilesModuleFallback` 会把每一条扁平兜底符号链接重指到这次构建随后就要删掉的暂存树上。启动门禁按壳播种真实 home 的同样方式播种那个临时 home,再要求每个声明了浏览器那一半的内置插件都出现在所服务 index 点名的 client 模块里,于是它证明的是载荷的性质,而不是构建机自己 profile 的性质。

**启动门禁像已安装的壳那样运行暂存的服务端,暂存树必须带齐安装包的整个依赖闭包。**暂存启动与 `--dump-config` 运行时去掉 `NODE_PATH`、`npm_*` 与 `PNPM_*`:pnpm 的 `.bin` shim 会导出指向工作区 `node_modules/.pnpm/node_modules` 的 `NODE_PATH`,继承它的服务端会从构建检出里找到载荷缺的任何东西。暂存树缺少 `@deepseek-ai/dsh` 的任一生产依赖或必需 peer(沿每个包自己的依赖追下去,扣掉有意扣下的包)时,`verifyStaging` 失败;每份成品载荷只按这个闭包里 `@deepseek-ai` 的部分核对,因为 `scripts/bundle-closure.ts` 会把第三方包内联掉。pnpm 的 legacy 部署器把 `@deepseek-ai/dsh` 放在部署源旁边,它的一部分生产依赖(包括 `@deepseek-ai/dsh-base`)只在它内部的 `node_modules` 里;`restoreLegacyHoists` 通过 `scripts/legacy-hoists.ts` 把它们拷进暂存树。部署不安装 peer,所以闭包只以 peer 形式点名的 Service Definition 包,由 `apps/desktop-server/package.json` 直接列出。

## 关掉窗口,以及被叫回来

**Windows 上关闭按钮会问一次它该是什么意思**:「最小化到托盘」还是「退出应用」,配一个「记住我的选择」。不勾,答案只管这一次;勾上,答案作为 `closeAction` 写进 `desktop-state.json`,此后每次关闭都照办、不再问,直到托盘菜单的「关闭时询问」把它清掉。最小化按钮原样不动——它仍然是普通的任务栏最小化。托盘图标从启动起就在,于是「最小化到托盘」指的是屏幕上已有的东西,窗口隐藏期间 **检查更新** / **退出** 也仍然够得着;菜单是 打开 / 检查更新 / 关闭时询问 / 退出,和菜单栏一样本地化。每一次退出——托盘的、记住的、更新触发的——都走同一条停服务器的 `before-quit` 拆除链;更新对话框会先把窗口显示出来再挂上去,因为挂在隐藏窗口上的窗口模态对话框既看不见也找不到。macOS 保留自己的习惯:关窗把应用留在 Dock 里,`activate` 重开窗口,所以没有菜单栏图标。

**客户端会说哪个会话在等你。**够格的时刻有两个——会话跑完了,以及会话在等批准或等回答——窗口有焦点时两者都不打扰。两者都从壳自己启动的那个服务器上读,走 `/api/remote.mux`,也就是浏览器 UI 在消费的那条 WebSocket,在它上面开一条 `$events` 逻辑流;为此上游没有新增任何东西,而这条流在重开时会重放仍然挂着的请求,所以每个请求只报一次。每条消息用发出那一刻 `session/list` 报的标题称呼它的会话;会话还没有标题、或者查询失败时,称作「会话」,查询失败还会往 `dsh-server.log` 写一行,带上查询失败的原因。Windows 弹系统 toast,点击把窗口抬起来,而审批的 toast 上带两个按钮:「拒绝」直接在 toast 上答复这次请求——走的是页面上那张审批卡同一条 `$events/result` 答复,所以卡片会随之消失——「去看看」把窗口抬起来;没有「批准」,因为 toast 只报了工具名、别的什么都没有,而批准得当着它批的那东西给。**壳弹出的每一条 toast,一旦被人动过、或者它所问的那件事已经结束,就会被撤下**,否则 Windows 会把它连同它带的按钮一直留在操作中心里可按:按钮被按下了、壳自己那份一分钟宽限的答复发出了、请求被取消了,或者壳已经不再盯着那个服务器。此后再按按钮——横幅几秒钟就收进操作中心,所以超过那一分钟才按下才是常态——抬起来的是窗口而不是一次答复,用户在那里才看得见卡片还在不在、还能不能答。而应用重启后仍留在操作中心里的 toast,它的按钮够不到任何投递:壳没有注册 Electron 的冷启动激活回调,刚起来的壳也没有可以把这一按对上的投递。macOS 显示 Dock 角标并弹跳一次,不往通知中心投任何东西——十来个跑完的 turn 会变成十来条要一一划掉的横幅,而角标只说有几条,并在窗口获得焦点时清零。角标数的是跑完的会话加上仍在等待的请求,每个请求算一个:请求被取消——有人在窗口里或别的客户端上答了——或者壳不再盯着那个服务器时,它就从计数里减掉,计数不会低于零。壳自己那份宽限答复不会把请求从计数里减掉,因为页面还挂着这个请求,而服务器不会给已经答过的客户端发取消;让窗口获得焦点就会清零。

**通知打开的是应用,不是会话。**Web UI 没有 URL 路由,壳无处可导航;是侧边栏自己的待交互与已完成标记指认出那个发问的会话。

**所服务 UI 的下载只问一次,完事把文件指给你看。**窗口是浏览器面,却没有浏览器的下载管理器,于是 Electron 对一次下载的回答是一张什么都不解释的「存储为」面板——而发起下载的页面早已宣布下载开始了,会话日志导出在传输一开始就打出「Session 导出已开始下载」。因此,重定向链上每一跳都与内嵌服务器同源的传输,改用壳自己的保存对话框:「保存文件」,旁边写着「保存 `<文件名>`」,一个「保存」按钮,默认落在系统下载文件夹里、用下载自己建议的文件名——该名字已被占用时,在最后一个点后缀之前插入 ` (2)`、` (3)` ……——而文件从这里可以存到任何地方。**这个对话框不声明任何文件类型过滤。**凡是服务器以附件形式发出的东西都会走到这里——会话日志导出、侧栏的工作区文件下载,以及往后插件添的任何东西——而过滤器会把它没料到的那些改名,因为 macOS 把 `filters` 映射成 `setAllowedFileTypes:`,而 Electron 不设 `allowsOtherFileTypes`。传输完成后,文件会在系统文件管理器里被选中:壳把文件指给你看,而不是播报一句,因为在一台从未授权应用发通知的机器上,通知是静默的。划掉对话框就取消这次下载,不再多说;写盘失败则弹出一个点名该文件的错误框。这三种结局各在 `dsh-server.log` 里留一行。同源包含页面为自己铸造的 `blob:` URL,它的 origin 就是页面自己的;`data:` URL 不带 origin,永远不会被接管,来自其他 origin 的传输也一样,从别处起手再重定向进服务器、或从服务器起手再重定向出去的也一样——它们保持 Electron 的默认行为,连那张面板一起,因为不是这个壳服务出去的文件就不归它安置。macOS 把下载文件夹拦在 TCC 后面,所以 `electron-builder.yml` 里的 `NSDownloadsFolderUsageDescription` 给系统的授权弹窗一个说得出口的理由:对话框还开着的时候,Chromium 就已经把到达的字节写进默认下载目录了,不管用户最后把它送去哪里。

## 更新机制

已安装的客户端读一个静态更新源——一个 electron-builder `generic` provider 目录,里面是清单与它们点名的产物:

```
https://lhr.ink/dsh-updates/win/     latest.yml  + the NSIS installer + its blockmap
https://lhr.ink/dsh-updates/mac/     latest-mac.yml + the zipped app
```

更新源没有服务端:清单**本身**就是判断过程,所以 nginx 发一个目录已经把它整个实现了。更新源地址存在于两处——生成清单与打包内 `app-update.yml` 的 `electron-builder.yml`,以及运行时读取它们的 `src/updater.ts`——迁移更新源要同时改这两处。`channel: latest` 在两端都显式写出;默认行为会拿运行版本的预发布段给渠道命名,那会让渠道名随发布周期的每个阶段改名。

**下载过程是安静的,只有装得上的更新才不是。**静默检查——启动后 15 秒、此后每四小时、**帮助 → 检查更新**,以及设置里的那个入口——发现新版本就直接开始传,不先征询。整个传输过程不上屏:没有对话框、没有窗口、没有任务栏或 Dock 进度,也不请求注意。唯一可见的状态是它的终点——一个已下载并校验通过的更新——由壳经下面那个更新服务报出,再由设置窗口画出来。**没有用户的决定就不会发生安装**,退出时或别的任何时候都一样:`autoInstallOnAppQuit` 关闭,应用只在有人点了那个窗口里的按钮之后的几秒里替换自己。那一次点击就是同意,所以不会再问第二遍;没装的更新留在盘上,下次启动照样报出来。帮助 → 检查更新 位置与文案都不变,跑的是同一个静默检查,作答只有「已是最新版本」「无法检查更新」两种——别处不显示的就这两个状态。「无法检查更新」的详情先是失败信息的第一行,再是一行 `错误码:`,列出 `cause` 链上的全部错误码(`ENOTFOUND`、`HTTP_ERROR_503`、`DSH_TRANSFER_CUT ← UND_ERR_SOCKET`),或被放弃的请求的 `TimeoutError`/`AbortError`;两样都没有的失败不显示错误码这一行。查到新版本的检查什么都不说:更新已经在设置那一行上,装它的按钮也在那里。在下载页那一层,手动检查查到新版本时改问「发现新版本 / 去下载」,因为那一层没有别的口子把下载交出去。

**剩下的对话框是强制更新那几个,以及未签名 macOS 的下载交接。**在 Windows 上它们全部挂在应用自己的窗口上,因为没有 parent 的对话框可以被系统排到用户正在用的东西后面,更新提示就这样存在却没人看见;在 macOS 上它们刻意不挂 parent,因为那里带 parent 的对话框是 sheet,任何抬起父窗口的动作——比如点一下 Dock 图标——都会像按下它第一个按钮那样把它结束掉。两边都一样:应用不在前台时会先请求注意,Windows 闪任务栏按钮,macOS 弹一次 Dock 图标。可选更新不再走到这条路上。

**安装既不静默,也不需要走向导。**可选的形态有三种,只有中间那种既诚实又无需点击:

| | 用户看到什么 | 为什么不选 |
|---|---|---|
| 完整向导 | 目录页、进度页、完成页 | 重问一遍那次点击已经回答过的问题;读起来像重装 |
| 静默(`/S`) | 什么都没有——直到出错 | 没有任何界面的安装无法自报进展,而 NSIS 的卸旧失败框照样会弹(`handleUninstallResult` 的 MessageBox 不带 `/SD`),于是唯一到达用户面前的东西是一个来路不明的报错 |
| **只留进度条** | 一个进度窗,不提问,应用自己回来 | — |

`quitAndInstall(false, true)` 选的是第三种。拿掉向导靠的不是静默:目录页在 `--updated` 时由模板自己的 `skipPageIfUpdated` 跳过,完成页由 `build/installer.nsh` 以同样方式跳过,MUI 自己的 `SetAutoClose true` 在安装段结束时关窗。重新拉起应用于是成了我们的活——模板的拉起条件是 `${if} ${isForceRun} ${andIf} ${Silent}`,非静默安装永远满足不了——所以 `customFinishPage` 用 `ExecShellAsUser` 启动它,顺带丢掉安装器的提权令牌。`$INSTDIR` 在 `.onInit` 里读自 `HKLM\SOFTWARE\<APP_GUID>\InstallLocation`——也就是安装段写下的那个值——该值缺席时退回 `%ProgramFiles%\DSH Desktop`;所以只要当初那次安装留下的这个键还在,更新就落在应用已占的目录。

**Windows 为所有用户安装,因此更新会提权。**`perMachine: true` 加 `packElevateHelper: true` 把 `isAdminRightsRequired` 写进清单,更新器于是通过 `elevate.exe` 启动安装器。在 UAC 为普通设置的机器上,这是**每次安装一次确认框**;在 UAC 设为「从不通知」的机器上则被静默放行,什么也不会出现。没有这次提权,per-machine 的卸旧会中止——这是走到 `Failed to uninstall old application files: 2` 的两条路之一。

**另一条路是旧卸载器的暂存路径,把它压短的是 `build/installer.nsh`。**更新会带 `--updated` 运行**旧**卸载器,它的卸载段在删除任何东西之前,先把安装目录里的每个文件搬进 `$PLUGINSDIR\old-install`。`$PLUGINSDIR` 位于 `%TEMP%`,所以每个暂存路径都是这个前缀加上该文件相对安装目录的路径——对装到 `D:\soft\DSH Desktop` 的安装,这个前缀长了 34 个字符,而载荷里最深的文件本就在 208 个字符处。261 个字符比 MAX_PATH 多一个,NSIS 又不支持长路径,搬移以 `ERROR_PATH_NOT_FOUND` 失败——模板把它报成 `File is busy`,而事实并非如此。五次重试之后安装器弹出「DSH Desktop 无法关闭」,而「重试」执行的又是同一次注定失败的尝试,因为超长的那条路径每次都是同一条。`customRemoveFiles` 替换掉了这套暂存:安装目录被**整个**改名成它自己的同级兄弟目录再在那里删除,于是它下面每条路径都保持原有长度,而且整个搬移留在同一个卷上。`customInit` 仍然先清掉旧版本的进程——应用本身、它的 `node.exe` 服务端,以及 `elevate.exe`(更新器正是从应用自己的 `resources` 目录启动它,并且它会在那儿等到整个安装结束)——因为活着的进程会让那次删除留下一个暂存目录,并让随后的解压覆盖旧版本仍在读取的文件。它先立刻杀掉 `elevate.exe`(不带 `/T`,因为安装器是它的子进程),再给应用与服务端 10 秒自行退出,超时后对残留连子进程一起杀。围绕它,退出时对停服务器封了顶(Windows 4 秒,落在安装器自己的耐心之内;别处 10 秒),到点照退;每次启动还会杀掉上一轮留下的服务器,匹配的是本安装那个内置 Node 的完整路径,而不是 `node` 映像名。

**那个「它还在跑吗」的判断,可能把满机器的进程都当成应用。**模板自带的「它还在跑吗」这一步收一个文件名参数,然后在 PowerShell 分支里把它忽略掉:它数的是可执行文件路径以 `$INSTDIR` 打头的进程,只要个数大于零就回答「在跑」。这个前缀不补分隔符,而 `String.StartsWith("")` 对任何字符串都为真——于是一个没解析出来的 `$INSTDIR` 会匹配整台机器,连安装器自己都算在内。它的清理这一步照同一个集合逐个 `Stop-Process -Force`,大多数会失败,下一轮又发现残留,最后停在「DSH Desktop 无法关闭。请手动关闭它,然后单击重试以继续」,而「重试」回到的是同一个循环。但上面那个对话框并不是这样来的——报告该问题的机器在一次失败安装中被以 250ms 采样盯了全程,看到的是五次 `old-uninstaller.exe`,以及一次进程检查都没有;它的 `$INSTDIR` 从向导里直接读出来是 `D:\soft\DSH Desktop`。这个过度匹配本身仍然是真的,而且拒绝它的代价很低。

`build/installer.nsh`(按文件名从 `buildResources` 被取用)于是定义 `customCheckAppRunning`,把这一步整个换掉——安装器在卸旧之前走它,卸载器在开始搬文件之前也走它,两边经过的是同一个宏。它先清 `elevate.exe`,单独清、不带 `/T`(安装器是它的子进程,树杀会把安装本身杀掉;先清它也把本进程从应用的子孙链里摘了出来),再给应用与服务端 10 秒自行退出,超时后对残留连子进程一起杀——服务端自己的子进程占着同一批文件。三条硬约束框住它:`$INSTDIR` 只有在是绝对路径、长过卷根、目录存在、且目录里有本产品的可执行文件时才用作前缀,用时必补分隔符;本进程的 pid 从每个匹配集里排除;全程不弹任何对话框,因为一个用户满足不了的框正是内置版本走死的地方。前缀不可信时,清扫改按精确映像名——`elevate.exe` 经由本进程自己的祖先链定位,应用连树一起杀——而绝不碰裸的 `node.exe`,那名字在任何机器上都属于别人。围绕这一切,退出时对停服务器封了顶(Windows 4 秒,落在安装器自己的耐心之内;别处 10 秒),到点照退;每次启动还会杀掉上一轮留下的服务器,匹配的是本安装那个内置 Node 的完整路径,而不是 `node` 映像名。

**新版本自己会报到。**每次启动都把版本记进用户数据目录下的 `desktop-state.json`,而启动时读到一个更旧的版本——这正是「更新装完并自行重启了应用」的样子——就在启动页上留一行:「已更新到 vX.Y.Z」。别的什么都不变,没有要关掉的对话框。

**安装失败时**,下载好的安装程序仍在 `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\` 里。手动运行它——右键**以管理员身份运行**——装的就是这次更新要装的那一版,会话记录两种路径下都在。之所以要提权运行,是因为手动启动的安装程序没有 `elevate.exe` 替它索取 per-machine 卸旧所需的权限。

**安装落地后,下一次启动会把它从 `pending` 里删掉。**electron-updater 只在下载失败或缓存记录与更新源对不上时清空这个目录,所以装好的 zip 或安装程序——整个安装包——本来会一直留到下一次更新开始下载。点击安装时,壳把暂存安装包的文件名、sha512 和当时运行的版本记进 `desktop-state.json`;更新后版本的第一次启动,在 `update-info.json` 仍指向那个安装包时清空 `pending`,再删掉这条记录。同一版本再次启动说明安装没有落地,文件留给上面说的手动安装;记录指向别的安装包说明那是之后的新下载,保留。重新拉起应用的 Windows 安装程序仍占着的条目会写进日志,记录保留,下次启动再试。缓存目录根下的差分基线(`update.zip`、`installer.exe`、`package.7z`、`current.blockmap`)从不动。由早于这项改动的版本发起的安装没有留下记录,它的安装包仍要等下一次更新下载时才清掉。

**如果连这条路也停在「无法关闭」**,说明本产品记录的安装目录丢了,把它写回去就足以放行一个旧版安装器:

```
reg add "HKLM\SOFTWARE\e36966b0-1805-5ec4-9648-404e09da7db1" /v InstallLocation /t REG_SZ /d "D:\soft\DSH Desktop" /f /reg:64
```

键名是 electron-builder 由 `appId` 推出的 GUID,也是安装器读取目录的唯一出处——旁边那个 `Uninstall` 项只带 `DisplayName` 与 `UninstallString`,本来就没有 `InstallLocation`,在那儿看到空值并不说明任何问题。这个值缺失的代价不止那句提示:`uninstallOldVersion` 会把从 `UninstallString` 推出的正确目录当作 `_?=` 交给旧卸载器,而旧卸载器自己的 `initMultiUser` 又在卸载段开始前用同一个空键覆盖掉 `$INSTDIR`——于是它什么也没卸,新版本却装进 `%ProgramFiles%\DSH Desktop` 这个兜底目录,应用被悄悄搬了家,旧的那份留在原地。

**macOS 同样原地安装,前提是构建已签名。**Squirrel.Mac 只在替换件满足当前运行应用的 designated requirement 时才暂存更新,这正是发布构建要签名的原因(见下方「信任与签名」一节)。安静的检查、安静的传输,以及「只有点击才安装」这条规则都与 Windows 一致;不同的是安装本身。它要十五秒上下,其中大部分时间屏幕是空的——Squirrel 在解压与验签,而 ShipIt 要等本应用的所有进程退出才能开始换包——所以那次点击会立起一个常驻的「正在安装 vX」提示把这件事说清楚,并隐藏主窗口,因为它的服务马上就没了。**交给安装器之后安装失败,应用会回来**——Squirrel 拒收暂存的包,或 Windows 安装器没能启动,都会到达更新器的 `error` 事件:提示窗关掉,更新入口显示失败,本次运行不再提供原地安装,退出状态被清除,服务器按正常启动流程重启,窗口重新出现。在强制更新的启动拦截之下,服务出来的 UI 保持关闭,由一个对话框提供重试安装或退出。

**没有**签名的构建保持旧行为:自己比对版本,用系统浏览器打开下载,只在启动时或手动检查时,绝不在会话中途。走哪一条由每次检查现场判断:看 `Contents/_CodeSignature/CodeResources` 在不在——签名会写出它,ad-hoc 链接器签名不会。已签名的构建若在运行期以重试修不好的方式失败,本次运行剩余时间降到同一条下载路径,并留下一行日志,而不是让这次检查以错误框收场。

**下载中断会先重试,然后续传。**electron-updater 不保留失败传输的任何部分:全量下载不发 `Range` 头,而任何错误都会删掉半截文件并清空 pending 目录。因此 `src/download-retry.ts` 在失败前面放了三次完整重试——间隔 2 秒、6 秒、18 秒——而这一切都不上屏。会重试的是网络:连接被切断或被拒绝、DNS 失败、请求超时、任何 `net::ERR_…`,以及更新源返回的 5xx、408、425、429。不重试的是判定:`ERR_UPDATER_*` 拒绝、签名不符、校验和不匹配、4xx——以及分类器不认识的任何失败,它们默认按致命处理,这样一个不认识的错误不会再赔上三次整包传输。判定所依据的 code 会顺着失败的整条 `cause` 链去读,因为遇上它的是 Node 的 `fetch` 时,**连接被对端重置**只在那条链上留下名字——交到调用方手里的是一个光秃秃的 `TypeError: terminated`;决定权归最外层那个 code,所以一个裹着网络失败的拒绝仍然是拒绝。有两种失败在这两处都不留名字,各自有一条规则接住:被 `AbortSignal.timeout()` 或一次 abort 放弃掉的请求,判定读它的 `name`——`TimeoutError`、`AbortError`——于是更新源一次慢应答花掉的是一次重试,而不是 macOS 在本次运行剩余时间里的原地安装那一层;而被回绝时拿到的状态码,会以 `HTTP_ERROR_<status>` 挂到那个失败上——它的消息是本仓库自己写的中文,这里没有任何模式认得:壳自己那半传输这样挂,于是那里的 503 会重试、404 不会;壳自己那次清单读取也这样挂,否则一个被回绝的清单什么名字都没有。致命失败仍按上面那套层级规则走——macOS 在本次运行剩余时间降到下载页,并在那一层重跑这次检查。

**重试用尽之后接手的是壳自己的传输,它把已经到手的字节留着。**`src/resumable-download.ts` 带着 `If-Range` 校验子向更新源要 `bytes=<have>-`,追加写进一个 `.part` 文件,边写边算哈希,收尾时拿整份文件与清单里那个 base64 sha512 比对;它自己那份计划更长也更慢——2 秒、10 秒、30 秒、2 分钟、5 分钟——因为它的每次尝试只花掉一个请求而不是整个产物,足以熬过一次比换路由更久的中断。那份计划要重试的就是传输被切断:对端在正文中途重置或关掉连接、连接安静超过 60 秒的空闲上限、正文比它自己答应的长度短——这三种都以壳自己拥有的同一个 code 抛出,于是判定不依赖任何一句消息文本。而起点不是请求所要的那个 `206`、两趟都被答 `416`,以及完成后 sha512 不是清单里那个,都是终局,因为下一次尝试遇到的是同一个回答。随后 `src/pending-cache.ts` 把校验通过的文件落到 `<cacheDir>/pending/<fileName>`,并写上 electron-updater 自己会写的那份 `update-info.json`,这次传输再调一次 `downloadUpdate()`:库核对缓存、从缓存取文件,不开一个 socket 就发出 `update-downloaded`。库自己的传输永远排在前面,因为差量下载是它这一半才有的能力——在缓存里已有上一版产物的机器上,那只是个位数百分比的字节量,任何整包续传都比不过。`.part` 文件按版本加产物名命名,住在缓存目录的根下而不是 `pending` 里,因为 electron-updater 自己下载路径上的任何失败都会清空后者;更新源已经翻篇的那些 `.part`,下一次传输开始时就被丢掉。有两件事它不改变:全新安装之后的第一次更新仍然是整包传输,因为差量路径需要缓存目录里存在上一版的 `update.zip`;强制启动门也不走续传兜底,因为在它返回之前应用是关着的。**上 Authenticode 之前要回头看的一个前提**:electron-updater 把 `verifySignature` 写在下载任务内部,所以走缓存短路时它不执行。本产品不签任何 Windows 可执行文件(`electron-builder.yml` 写着 `signExecutable: false`,也没有 `publisherName`,而没有它 `verifySignature` 直接返回 null),所以被跳过的是一项今天什么也不做的检查——但一旦开始签名,这条路必须自己验签。每次重试与结束它的那个结论都写进 `dsh-server.log`。electron-updater 自己的日志也写进同一个文件,只去掉它的 `debug` 通道:一次差量下载会把整份分块计划从这个通道倒出来——在观测到的那一次更新里约 650 行 JSON,不含版本、大小,也不含失败——而概括同一份计划的那两行 `info`(`File has N changed blocks`、`Full: … To download: … (P%)`)保留。另有两行 `debug` 跟着一并保留,顶着 `debug:` 标记,因为它们说的事别处不记:`nativeUpdater.update-downloaded`,macOS 上 Squirrel 完成暂存的唯一凭据;以及 `updater cache dir: <path>`,它给出的目录决定下一次更新能不能走差量。electron-updater 写进那里的行里,唯一一条为「它自己已经恢复过来的失败」带上堆栈的,会被改写而不是照搬:在 Windows 与 macOS 上同样,`Cannot download differentially, fallback to full download` 带着堆栈、顶着 `error` 字样,出现在一次随后仍以全量下载完成的更新里,`src/updater-log.ts` 把它压成一行,只说原因。

**要求多于一个范围的差分下载已打补丁。**electron-updater 6.8.9 没有给多段响应挂 `error` 监听,而计划中范围多于一个时发出的正是多段请求,于是传输中途被切断的连接会抛出一个没人监听的 `error` 事件——主进程里的未捕获异常,也就是 Electron 自带的「A JavaScript error occurred in the main process」对话框,盖在一次随后仍以全量下载完成的更新上面。`patches/electron-updater@6.8.9.patch` 携带上游的一行修复(electron-builder 提交 `5eed26b2a9cfd06a1dbe207b25a46ce2c0b05ae9`,PR #10021),直到有发行版带上它为止。`tests/electron-updater-multipart.spec.ts` 对着 `node_modules` 里的那份副本钉住这个行为,补丁在与不在都保持通过;真正来讨要这个补丁的是 pnpm——当某次升级让这条精确版本补丁变得无用或无法应用时,它会让安装失败。

**检查被打断也会重试,用的是另一份计划。**一次检查只传一份小清单,被打断的代价是一个请求而不是整包传输,所以计划是两次重试——间隔 1 秒、3 秒;这四秒的等待还装得进强制启动门允许的十五秒,于是撞上断连的启动门是从一次重试、而不是从它自己的超时里得出结论。重试与不重试的界线和下载一致,由同一个分类器判定。瞬时失败熬过重试后,只赔上这一次检查:**macOS 保住原地安装的层级**,启动门退回自己去读 `latest-mac.yml`,下一次检查照旧先走原地这一条。只有重试修不好的失败——`ERR_UPDATER_*` 拒绝,或更新源上这个通道根本没有清单——才会把 macOS 在本次运行剩余时间降到下载页。

### 强制更新

清单里带一个本产品自有的字段 `minimumVersion`:低于它的客户端必须更新才能继续使用。

| | Windows | macOS |
|---|---|---|
| **启动时** | 不展示 UI,服务端拆除,下载不经征询直接开始。下载失败时给出重试与退出两条路。 | 阻断对话框给下载或退出;两种选择都不会进入应用。 |
| **会话中** | 立即下载并弹一次对话框告知;下载完成后仍可推迟安装。 | 提示一次;下次启动阻断。 |

连不上的更新源会**放行**而不是关门——网络故障绝不能把人锁在自己的机器外面。这条线在发布时显式设定,此后自行延续,所以忘记加参数不会把它悄悄丢掉。

### 发布

```sh
pnpm exec tsx apps/desktop-shell/scripts/publish-update.ts --notes notes.txt             # ship the built version
pnpm exec tsx apps/desktop-shell/scripts/publish-update.ts --notes notes.txt --dry-run   # verify without uploading
pnpm exec tsx apps/desktop-shell/scripts/publish-update.ts --notes notes.txt --minimum-version 0.1.0-rc.8
pnpm exec tsx apps/desktop-shell/scripts/publish-update.ts --notes notes.txt --republish  # repair a cut-off upload
pnpm exec tsx apps/desktop-shell/scripts/publish-update.ts --notes notes.txt --no-prune   # leave every old version in place
pnpm exec tsx apps/desktop-shell/scripts/publish-update.ts --notes notes.txt --no-tag     # leave the shipped commit untagged
```

脚本会拒绝与 `package.json` 对不上的 `dist-app`,重新校验安装程序的 NSIS 完整性 CRC,并断言本次构建盖过更新源在提供的版本。上传顺序是**先产物、两端校验、清单最后**,因此发布途中轮询的客户端读到的是旧清单指向旧产物,绝不会读到一份指着还在上传的文件的清单。它还会剔除本次不上传的产物在清单里的条目:macOS 构建会在 zip 旁边列出 dmg,而只有 zip 会发布,留着那条就等于在更新源里放了一个 404。

**更新源自己会清理,而且两类文件留的深度不同。**等两个清单都从更新源回读到新版本之后,脚本会列出各渠道目录,按两条规则裁掉多余的:**最新的两个版本留产物,最新的十个版本留 `.blockmap`**。更新过程中真正会从更新源取的只有其中一类——electron-updater 会下载新版本的 blockmap,但旧版本的那份先读客户端自己的缓存,只有缓存里没有了才回落到更新源;而旧**产物**它同样只从那个缓存里打开,从不走网络。所以留在服务器上的旧产物(138–174 MB 一个)是给回滚和手动下载用的,旧 blockmap(145–181 KB 一个)则是给缓存丢了的客户端兜底;两者留同样深,等于用前者的价钱买后者的好处。发布成功之前不删任何东西;版本按 semver 优先级排序而不是按名字排(`0.1.0-rc.9` 比 `0.1.0-rc.10` 旧);清单以及本次发布上传的一切永远不进候选;解析不出版本的名字只记一行日志、原样留着。`--no-prune` 跳过整个步骤;`--dry-run` 会把「会删什么、会留什么」原样打印出来,并且什么都不删。这套判断在 `scripts/prune-feed.ts`——一个纯函数,由 `tests/prune-feed.spec.ts` 脱离服务器测试。

**发布成功之后会给所交付的 commit 打 tag。**等两个清单都回读到、清理步骤也跑完之后,本次发布被打上 `desktop-v<version>` ——带注解,消息就是这次的发布说明,于是 `git tag -n` 就能看到发布了什么——并把该 tag 推到 `origin`。这件事能不能成,在第一个字节上传之前就已判定:已跟踪文件有未提交改动、`desktop-v<version>` 在本地或 `origin` 上已经指向别的 commit、或者根本没有 `origin`,都会直接拒绝本次发布——此时产物还只在本地,重跑不花什么代价。未跟踪文件在这里不算未提交改动——发布运行自己会把日志写进工作树,被忽略的 `.env` 也长期躺在那里,两者都改不了构建所编译的东西。

**由哪一侧已经持有该 tag 来决定跑什么**,而 `origin` 是权威的一侧,因为其他每一个克隆读的都是它:两侧都没有,就在本地创建并推送;只有本仓库在 HEAD 上持有,就推送;只有 `origin` 在 HEAD 上持有,就把它 fetch 下来——因为为一个 `origin` 已经发布的名字在本地再造一个带注解的对象,推上去只会被 git 拒绝;两侧都在 HEAD 上持有,就一条 git 都不跑。后两种正是同一个仓库的多个工作树轮流发布时的常态。若打 tag 这一步在更新源已经开始下发之后失败,它会明说产物**已经**发布、只是 tag 没跟上,打印出手工补上的那一条命令,并以非零码退出。`--no-tag` 跳过该步骤连同它的前置校验;`--dry-run` 打印它会打什么 tag,不碰任何东西。这套判断在 `scripts/release-tag.ts`——一个纯函数,由 `tests/release-tag.spec.ts` 脱离仓库测试。

更新源在主机上的路径是 `/var/www/dsh-updates/{win,mac}`,由追加的单个带 `alias` 的 `location /dsh-updates/` 提供。那台 nginx 使用自定义前缀(`/data/third_party/nginx`),编译时不含 rewrite 模块,且 master 不归 systemd 管——重载请用 `nginx -s reload`,绝不要用 `systemctl`。该目录不套 BasicAuth,因为 electron-updater 不会带凭据。

## 信任与签名

**macOS 构建由本项目自己持有的一张自签名证书签署。**`scripts/sign-mac.cjs` 在 `afterPack` 钩子里直接跑 `codesign`,因为 electron-builder 自己的签名过程用 `security find-identity -v` 过滤身份,未信任的自签名证书永远过不了这道过滤。`codesign` 没有这条规则;它真正要求的是身份所在的钥匙串必须在用户的钥匙串搜索列表里,所以脚本每次构建新建一个钥匙串、加进列表、签名,再在 `finally` 里还原搜索列表。身份默认从 `~/Library/Application Support/dsh-desktop-signing/dsh-desktop-signing.p12` 读取,除非 `DSH_MAC_SIGNING_P12` 与 `DSH_MAC_SIGNING_P12_PASSWORD` 另行指定;缺失时**构建失败**,`DSH_MAC_SIGN=0` 是显式索要未签名构建的方式。更新路径校验的就是这张证书,所以它不能轮换:它的指纹就在每个已安装客户端校验的 designated requirement 里。

它不是 Developer ID 证书,应用也未公证,所以由**浏览器**下载的副本,Gatekeeper 仍要求右键打开(或 `xattr -dr com.apple.quarantine`);由 Squirrel 装上的更新不带隔离属性,两者都不需要。Windows 产物未签名,SmartScreen 会弹未知发布者提示。Windows 包只做了交叉构建与结构校验——交付前务必在真实 Windows 机器上冒烟。

这也框定了更新源能承诺什么。TLS 认证服务器,清单里的 sha512 把产物绑定到清单,所以传输途中无法被做手脚。产物带的是本项目自己做的签名,不是操作系统会背书的那种,所以对 `/var/www/dsh-updates` 的写权限仍然等于对每个客户端下一个安装程序的写权限——macOS 客户端会拒绝由别的证书签出的 bundle,但对「给它的是这张证书签出的哪一个构建」没有意见。补上这一环要靠 Windows 的 Authenticode 与 macOS 的 Developer ID 加公证。

## 内置插件

**十四个插件随安装包分发,并在首次启动时自行挂载**,所以全新安装无需 pnpm、无需联网、无需 `dsh plugin add` 就已就位:

| 包名 | 版本 | 提供什么 |
|---|---|---|
| `@haoran/dsh-screenshot` | `0.7.0`,来自提交进本仓库的 tarball | `screenshot` 工具:渲染任意页面,登录墙后的页面也包括在内——截回来的图是一堵登录墙时,它变成一个问题,你的回答要么打开一个由你自己完成登录的窗口,要么复用这台机器上已有的登录,随后在那个站点自己的分区里重新截一次。没有这个回答就什么都不复用,cookie 的值从不作为工具参数或返回值出现,已存的登录在设置页的一个小节和 `/screenshot-logout <域名>` 里管理。它把像素连同一份说明这次渲染做了什么的报告交给 agent,页面用尽时间时交回一张部分截图,并在要求时把 PNG 写进工作区内;配置决定 cookie 罐、user agent(默认是稳定版 Chrome 的字符串,不是壳自己的)与由哪个后端渲染 |
| `@haoran/dsh-llm-permission-gateway` | `0.6.0`,来自提交进本仓库的 tarball | 一个审查模型,判断操作系统沙箱管不到的那些有副作用的工具调用,并代你回答沙箱自己弹出的越权申请。它对一次调用做什么,是按头上的围墙与会话的审批策略折出来的,不是按访问方式的名字:在仅可查看与工作区内修改下,不打开审查就什么都不审;在本插件贡献的自动审查那一行下,除本机读取之外的每一次调用都审;在完全权限下它什么都不决定——那种方式不问任何人,它在那里提的每一个问题都会变成你从未见过的一次拒绝。设置页的**审查设置**就是这个开关,它只够得着上面那两种带围墙的方式;输入框里的 `/review auto` 与 `/review manual` 是同一个,同一个小节还决定用哪个模型来审查。这个开关出厂是关的,存在自己的键上,0.4.4 之前打开过审查的安装不会把旧选择带过来。同一个小节里的**审查前先想多久**只给出所选模型自己报出的那几档。判决只有 `allow` 与 `ask` 两种:`deny` 会降级成摆到你面前的一个问题,用中文写明这次调用跑起来的代价。每一次审查只提供 `submit_verdict` 一个工具并强制调用它,结论只从这次调用里读;适配器拒收强制调用的路由会只提供、不强制地再问一次,并按思考档位被记下不再强制。子任务没有人可以答复——内核把每个被委派的会话都钉在什么都不问上——所以那里拿不准就由网关自己写一句话拒掉。两条红线编译在插件里,它决定一次调用的地方一律成立,包括审查关着的那两种带围墙的方式——在同一次调用里读凭据库并把数据送出这台机器,以及任何指向本插件自己的包目录、`$DSH_HOME/profiles` 或 `$DSH_HOME/settings.yaml` 的参数。它贡献的自动审查那一行,在访问方式控件里带完全权限那枚盾形图标;两处访问方式菜单里画成危险色的只有完全权限那一行——自动审查不上色,它没有围墙但仍然会问你。0.4.7 起,回答结束但读不出结论时在同一期限内再问一次;每次审查固定以 temperature 0 发出。0.4.10 把 temperature 改成配置项(出厂 0),重问因别的原因失败时记录保留第一轮的回答。0.5.1 起,没选过模型时审查跑在 `deepseek-official` / `deepseek-flash` 上,设置页的模型选择器总是停在一个具体模型上。0.5.3 把应用自己的目录列进审查提示——安装目录、`$DSH_HOME`,以及壳在 `DSH_DESKTOP_INSTALL_DIR`、`DSH_DESKTOP_USER_DATA_DIR`、`DSH_DESKTOP_LOG_DIR`、`DSH_DESKTOP_UPDATE_CACHE_DIR` 里点名的设置、日志与更新下载文件夹——并指示审查模型:认出一次调用要写入、移动、改名、删除或覆盖其中任何一处时答 `ask`,于是凡是网关审查的地方——自动审查下,以及打开审查后的两种带围墙的方式——这样的调用会转给你确认。这是给审查模型的指令,不是网关强制的检查,完全权限下什么都不审;写进 `$DSH_HOME/skills` 不在这条规则之内。 |
| `@sumomok/dsh-quote-message` | `0.5.0`,来自提交进本仓库的 tarball | 把当前会话里更早的内容引进输入框:在任意消息里选中一段文字会出现 `Quote` 药丸,引用 chip 在你发送时展开成一段 markdown 引用块,而对话里它显示成你这条消息上方的一段引文——左侧一条细线,引用文字用次级墨色,超过三行折起 |
| `@sumomok/dsh-balance` | `0.8.0`,来自提交进本仓库的 tarball | 账户余额与花掉了多少。侧栏底部一个 chip 显示当前会话所选模型归属的那个供应商还剩多少额度。本会话的花费是输入框下方 Token 用量药丸文案开头的那一段——`$0.12`,某个模型的 token 价格表一条都没覆盖到时再跟一句 `· N tok 未计价`——而那枚药丸点开的弹层里会多出本会话合计一行、模型或档位多于一个时每个模型与每个档位各一行,以及价格表未覆盖的那些 token 一行;这两个位不存在时,同样这些数字就自己占输入框下方的一行。浮层里另有一个供应商选择器,列出本部署当下能查到余额的那些供应商,以及该供应商的今日 / 本月 / 累计花费与各价格档位各占多少、一个**刷新**按钮,和一个**充值**按钮——对插件收录了控制台页面的那些供应商可见,点开走系统浏览器。价格只读,取自插件维护者在 `https://lhr.ink/dsh-prices/v1/prices.json` 发布的价格表,启动时取一次、之后每天一次,不带 key、cookie 或任何 id,也不跟随重定向;取到之前用上次取到的表,一次都没取到时用包里随附的表,其中带着 DeepSeek 截至 2026-09-10 公布的 CNY 与 USD 价格,已下线的那两个 Flash id 按实际为它们提供服务的模型计价。订阅额度路由(`kimi-coding`)上的 token 从不计价,记作套餐内。设置页的**余额**里有一个开关,把 chip 上的数字换成圆点,给正在共享或录制的屏幕用;它在保存那一刻就到达 chip,不用等下一次轮询;浮层、余额偏低的染色与本会话花费都照旧显示 |
| `@haoran/dsh-connection-banner` | `0.4.0`,来自提交进本仓库的 tarball | 连接正在重连期间,页面顶部的一条横幅——短暂的抖动不出声,断线过了几秒才现身,一恢复就立刻消失 |
| `@haoran/dsh-clickable-refs` | `0.6.0`,来自提交进本仓库的 tarball | 让助手正文可点击:每一次命中——POSIX 或 Windows 路径、UNC 共享、localhost/loopback URL——都经由 referent/open 这道 waterfall 缝打开,对可执行/脚本扩展名有一份拒绝名单,过期路径则降级为「未找到」。`bash` 与 `web_fetch` 卡片是 harness 自己的:终端输出里的路径不可点击,web-fetch 卡片里的 URL 是 harness 自己的链接 |
| `@haoran/dsh-vision-switch` | `0.4.0`,来自提交进本仓库的 tarball | 在当前模型不支持图片时发送一条带图片的消息,会经由手动切换模型走的那条同一通道把会话切到一个支持图片的模型,而不是宿主那个走不下去的拒绝;前提是那个模型所在的服务配置了凭据。只有图片算数:动手之前先把草稿里每个附件的种类解析出来,所以「文字 + 非图片文件」的草稿——一个 `.pcap`、一个 `.csv`——原样发出。若组合里点名的目标不在目录里或它所在的服务没有配置凭据,而别的所在服务配置了凭据的支持图片的模型还在,就出一张与宿主自己那张提问卡同形的卡片把它们列出来,一个模型一行:同一时刻只有一行在 Tab 序列里,方向键让焦点与选中一起走、Home 与 End 到两端,Enter 或空格选中当前焦点那一行,「切换并发送」才发送,Escape 或「取消」放弃这次发送且草稿原样留着。Enter 永远不发送。若支持图片的模型所在的服务都没有配置凭据,就原样发送,由宿主用自己的提示拒绝,草稿留在输入框里 |
| `@haoran/dsh-default-model` | `0.3.2`,来自提交进本仓库的 tarball | 出厂默认模型,也是选择器里唯一的模型:`deepseek-flash`——DeepSeek-V4.1-Flash,文本与图片都收。DeepSeek 已下线 V4 Flash 系列并把 V4 Pro 的请求转到它,所以目录只列这一个。在此之前选过模型的用户仍保留那个选择,它在桌面 profile 自己的 patch 行里;若那是一个已下线的模型,文本照常——DeepSeek 用 V4.1 Flash 为那些名字提供服务——而发图片时 `@haoran/dsh-vision-switch` 会把会话切到 `deepseek-flash`,用的是在模型选择器里手动选择时的同一个调用。每一次发送都是如此,新对话的第一条消息也不例外:这次切换比对的是 composer 自己的选择器显示的那个模型,而对一个没有记过任何选择的对话,那正是这份存着的默认值 |
| `@haoran/dsh-btw` | `0.3.0`,来自提交进本仓库的 tarball | `/btw <问题>` 就当前对话问一个岔开的问题。答案落在它自己的一张卡片里,并且此后对话里的每一次请求都看不到它:问题与答案就是这个命令自己的 `command/run` 与 `command/done` 事件,而唯一构建模型请求消息列表的那个函数 `Session.deriveMessages()` 从不走这两类事件,所以这条保证是结构性的,不是约定。它是走对话自己那条路由的一次请求,按这个长度的一轮计价,带着对话作为上下文——其历史以 agent 自己的系统消息开头——也带着对话的工具定义,好让对话里此前的工具调用读得懂,而它自己的指令不许为这个回答调用工具;你发问时仍在执行的工具调用会被略去。答案是整段出现的,不是一个词一个词地流出来,因为要流式就得有一个这个插件刻意不声明的会话事件。带工具调用标记的回答会被拒成「模型要求调用工具」而不是把标记原样显示出来,卡片也会记住你有没有把它收起 |
| `@haoran/dsh-mcp-servers` | `0.3.0`,来自提交进本仓库的 tarball | 外部 MCP 工具服务器,在设置页的「MCP」小节里添加:本机上一个以完整路径指名的程序,或一个 Streamable HTTP 地址。保存即连上,而它实际提供的那一组工具会被记成受信的那一组。删除会先在该行里问一句,并在你回答之前扣住其余控件。只有当有什么与这份记录对不上了,这一行才重新显示「等待确认」——命令、参数、工作目录、环境变量、URL 或请求头被改过,或者服务器改了它提供的工具——而且只扣住其中变过的和新增的工具,已勾选、服务器没动过的工具照常可用。服务器提供的工具也要逐个勾中它当前的措辞才会被注册,服务器改写了描述或入参 schema,该工具就退回待勾列表,而不是进入下一次请求。请求头的值与环境变量条目都可以填一个已保存凭据的名字来代替密文本身,而那个值从不进入设置文档。一次调用超出插件自己的单次预算时,报的是「等不到回应」并写明这个预算,而不是说服务器什么都没回。「修改」在服务器自己的卡片里打开它的各项,「全选」勾上服务器当下提供的每个工具,连接失败时用平白的话说出原因,错误本身在「详细信息」下面 |
| `@haoran/dsh-desktop-update` | `0.3.0`,来自提交进本仓库的 tarball | 设置页里的「更新」一页:正在跑的版本、有没有发布出更新的版本、它改了什么、上次检查的时间、一个「立即检查」按钮,以及发现了新版本时的「下载新版本」按钮——下载进度条只在这一页上,别处不出现。一旦有一个版本落到盘上,设置那一行的右端就出现一个「更新到最新」按钮,按它即打开这一页;在那里按「重启并安装」就是同意,应用随即重启进新版本,不会再问第二遍。待更新的那个版本号哪里都不写——页面、那个按钮、它的无障碍名称都不写——这两处印出的版本号只有正在跑的这个构建自己的。它不取任何更新源、不校验签名、不写文件、也不重启任何东西——这四件都归桌面外壳,本插件只是向它发四个 loopback 请求,凭一个只有宿主那一半读得到的 token。没有这个服务的部署——比如服务器上的 `dsh web`——它一个页面一个按钮都不注册 |
| `@haoran/dsh-auto-compact` | `0.5.1`,来自提交进本仓库的 tarball | 在对话塞满之前按你选的点位压缩它:设置页「通用」下的一行,带一个开关和一个滑块,滑块读的是 40% 到 95%,量的正是输入框旁边那个用量圆环所报的同一个上下文窗口数字;旧版本保存的 20% 到 39% 按 40% 生效、也显示为 40%,因为低于这个比例时,后端保留原文的中文内容可能比比例还大,压不到比例以下。一个值管所有对话、所有模型。它在一轮的两步之间压缩——上一步的工具结果记下之后、下一次模型请求发出之前,只要那次请求会超过你设的比例——所以不会打断正在输出的回复或正在跑的工具,这一轮从摘要接着往下走;一轮最后一条回复之后不压。harness 自己的溢出兜底在请求实在装不下时仍会动手,那是这个插件开也好关也好都搬不动的地板。它的 `compactionPolicy` 服务答 `isEnabled(): false`,让压缩后端自己的步间监听让位,由插件在同一个时刻去问这个对话自己那台引擎的 `compactIfNeeded()`,所以一次失败不会在同一轮里重试:每个对话每轮最多失败一次。任务委派出去的子对话也会压,各自在自己的步与步之间压,各自退避。引擎在每一步之前按会话经 `agentPresets.serviceFor` 找,因为每个 preset 都把它装在自己的 realm 里,位子也只有在这次查找在某处成功之后才答 `false`。插件调用的是引擎本身而不是 `serviceFor` 交回的代理,所以 preset 里装在引擎旁边的工具结果裁剪器会生效。压掉什么、留多少归后端:先把每条超过 8,192 个字符的工具结果(最新那条也算)截成开头和结尾,再把保留尾(默认是消息预算的 16%)之前的历史压成一条摘要。压的过程中对话里显示一行**正在压缩…**,摘要落地后换成**上下文已压缩**并带条数与 token 数,按停止会取消摘要、这一轮以「已停止」结束 |
| `@haoran/dsh-office-preview-notice` | `0.3.0`,来自提交进本仓库的 tarball | 预览引擎还没装时,右侧边栏的文档标签页为 Word 或 PowerPoint 文件(`doc`、`docx`、`ppt`、`pptx`)显示的内容:两个按钮,一个用电脑上的默认程序(Office 或 WPS)打开文件,一个经本壳的 Office 引擎服务下载引擎,下载的确认、进度与失败都显示在同一处。引擎装好后它让位,由文档预览自带的 Office 渲染器预览文件。它的排序高于那个渲染器,不读取文件内容,也不提供纯文本视图;表格文件照旧在浏览器里预览。它的宿主那一半把引擎的 `NODE_PATH` 一项从服务端子进程继承的环境里删掉 |
| `@haoran/dsh-crash-resume` | `0.4.1`,来自提交进本仓库的 tarball | 崩溃恢复:服务端在一轮对话进行中意外退出后,下次启动把那一轮自动续上一次,并告诉模型当时在执行的工具调用已按结果未知关闭、重复可能只做了一半的操作之前先检查它现在的状态。当时在等你批准或回答的一轮、已经续过一次的一轮、会话有进行中目标的一轮,以及被壳主动停止打断的一轮不续跑,改在转录里留一行「已中断」,行末的「继续」文字按钮在你按下时续上那一轮;壳用「服务器环境」一节所述的哨兵文件标记这种主动停止。它是插件页上唯一不能停用、不能卸载的内置插件:开关置灰,提示**应用必需，不能停用或卸载** |

它们是 [apps/desktop-server](../desktop-server/README.zh.md) 的普通依赖,所以 `pnpm deploy` 会把它们和服务端闭包的其余部分一起放进载荷的 `server/node_modules`,版本由携带它们的那个安装包钉死——一次更新分发的就是该次构建声明的版本。

**这个网关随包挂载;有围墙的时候,你不开口它就什么都不审。**它对一次调用做什么,是从内核已有的两个旋钮折出来的——操作系统管不管得住文件副作用,以及这个会话的审批策略还能不能把问题递到你面前——而不是看访问方式叫什么名字。仅可查看与工作区内修改头上有围墙,所以审查出厂是关着的:在**审查设置**小节里打开,或者用 `/review auto` 与 `/review manual`,买到的是被围住的会话仍然伸到墙外的那些调用的审查。在插件自带的自动审查那一行下,既没有围墙,又还问得到你,所以除本机读取之外的每一次调用都审,这个开关也够不着它。在完全权限下这道门什么都不决定:那种方式的 `never` 策略会在任何答复者看到之前就把每一次审批申请判成拒绝,所以它在那里提出的问题,到你这里是什么都没有,到模型那里则是一次你从未做过的拒绝。编排出来的默认值仍是 `workspace-write` 加 `ask`,新会话被钉住的还是它。真审的时候,这道门只审沙箱管不到的东西:`run_code` 的程序体(它跑在 harness 进程内的一个 worker 线程上),以及 `web_fetch`、`screenshot` 这类能力工具。`bash`、`pwsh`、`write`、`edit`、`str_replace_editor`、`terminal_open`、`terminal_send` 在各自的操作系统围墙还立着时不经审查直接放行,围墙不在的地方则照审。它还会代你回答沙箱自己弹出的越权申请——越权申请只有被围住的会话才提得出,而且要上面那个开关打开才由它来答:某次被围住的调用因为伸到墙外而被拒、agent 请求解除这次拒绝时,由同一个模型来决定,拿不准就把问题交还给你。判决只有 `allow` 与 `ask` 两种——`deny` 会变成一个带着模型理由的问题——所以只要问得到你,审查就只会多出提示,不会有无声的拒绝;被委派的子对话被内核钉在什么都不问上,那里没有人可以答复,拿不准就由网关自己写一句话拒掉。两条红线编译在插件里,配置也关不掉——审查关着的那两种带围墙的方式下同样成立,自动审查下也成立,而在完全权限下这个插件一行都不跑:在同一次调用里读凭据库并把数据送出这台机器,以及任何指向本插件自己的包目录、`$DSH_HOME/profiles` 或 `$DSH_HOME/settings.yaml` 的参数——按解析后的路径算,也按字面文本算(比如插件自己的包名)。读和写一样被拒,所以 `ls ~/.dsh/profiles` 也过不去。访问方式控件里列的是仅可查看、工作区内修改、插件自带的自动审查,以及完全权限;第三行写在插件自己的 patch 层里,而不是写在你的 profile 里,所以它恰好在这个 bundle 挂载期间存在。

**每个内置插件都以一条 `file:` 标识符指向 `apps/desktop-server/vendor/` 下的一个 tarball**,与声明它的清单放在一起提交;那个归档就是渠道:这十四个插件没有一个是从注册表装来的。下文那第十七个 bundle 名字 `@deepseek-ai/dsh-desktop-app` 既不是插件也不是 tarball——它是本仓库的一个 workspace 包,以 `workspace:*` 声明。`@haoran` 那几个插件哪里都没发布。`@sumomok/dsh-balance` 与 `@sumomok/dsh-quote-message` 走在作者最新发布版之前。pnpm 为 `file:` tarball 记录 `integrity` 哈希,与注册表包完全一样,这正是 `pnpm deploy` 要求的东西,也是 GitHub 归档 URL 给不出的东西。升级其中一个意味着提交一个新的 tarball 并把它的标识符指过去。

**走在注册表之前,正是 profile 自己那份内置插件副本不只是重复、而是隐患的原因。**`dsh plugin add @sumomok/dsh-quote-message` 装到的是最新发布版,而它落后于这里分发的归档,于是一个 bundle 的两半会从不同地方解析——patch 层经 `resolveBundleDir` 安装目录优先,模块则按常规的逐级向上查找,先撞上 profile 自己的 `node_modules`。这一行来自一个版本,代码来自另一个版本;启动会如实报告而不去修它,见下文。

**十四个里有十三个带浏览器那一半。**包清单里的 `dsh.client` 才是让服务端为它组合出 `/plugins/<name>/client.js` 那一行的东西,`@haoran/dsh-screenshot`、`@sumomok/dsh-quote-message`、`@sumomok/dsh-balance`、`@haoran/dsh-connection-banner`、`@haoran/dsh-clickable-refs`、`@haoran/dsh-vision-switch`、`@haoran/dsh-mcp-servers`、`@haoran/dsh-llm-permission-gateway`、`@haoran/dsh-btw`、`@haoran/dsh-desktop-update`、`@haoran/dsh-auto-compact`、`@haoran/dsh-office-preview-notice` 与 `@haoran/dsh-crash-resume` 声明了它。没有的那一个是 `@haoran/dsh-default-model`:默认模型是 loader 去读的编排,页面从不加载。构建的启动闸从载荷自己的清单读这条声明,而不是从一份名单读:每个有浏览器那一半的内置插件都必须出现在所服务的 index 所列的客户端模块里。其余的这次启动证明不了:profile 列了名字而 Loader 解析不了的 bundle 会被跳过,服务端 stderr 上多一行 `skipping profile bundle "<name>": …`,启动照常继续,所以打印出 URL 行的服务端仍可能缺着 `@haoran/dsh-default-model`,或排在内置插件之后的那一层组合层。

**壳启动的是自己的 profile `desktop-shell`,并在启动服务端之前把它建出来。**`desktop-shell` 没有随附模板,所以没有谁会按需把它建出来,而服务端拒绝启动一个不存在的 profile;`src/profile-seed.ts` 先于服务端运行,写出 `initProfile` 会写的那三个文件——清单、`cordis.patch.yml`,以及 `pnpm-workspace.yaml`,后者的 `hoisted` linker 正是让日后安装的插件共用安装目录里那一份 cordis 的东西。清单列出 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、十四个内置插件与 `@deepseek-ai/dsh-desktop-app`,于是 `loadProfile` 会应用它们各自的 `cordis.patch.yml` 层;它的 `dsh.profile.shipped` 点名这十四个,插件页据此列出它们;每个内置插件还会被链接进 `$DSH_HOME/profiles/node_modules`,即 Loader 从它解析插件标识符所依据的 profile 目录逐级向上就能走到的扁平兜底目录。每一次写入都是幂等的:已列出的名字不会重复添加,正确的链接原样保留,已存在的文件不会被改写,而下面的 web profile 同步是唯一会写入依赖条目、或改写壳自己写过的文件的动作。清单以 rename 写入,所以启动中途被打断也只会留下原来那一份。某次启动确实改动了什么、或让某个内置插件保持关闭时,向 `dsh-server.log` 写一行,否则不写。

**这个 profile 在 0.1.0-rc.32 之前叫 `desktop`,已装客户端在本次构建的首次启动时会被改名。**上游自己的 Electron 应用保留了那个名字——`apps/cli` 现在会拒绝其他任何调用方的 `--profile desktop`——所以 `$DSH_HOME/profiles/desktop` 会被整体改名为 `$DSH_HOME/profiles/desktop-shell`,一次目录 rename 就把清单、你的 `cordis.patch.yml`、`web-migration.json` 以及这个 profile 里的每一个插件一并带过去;里面的链接写的都是绝对目标,所以换到新路径照样解析得到。清单的 `name` 随之改写,而这个字段也正是判断目录归谁的全部依据:这个壳往那里写的是 `dsh-profile-desktop`,上游的应用写的是 `@deepseek-ai/dsh-desktop-runtime`,所以带着任何别的名字的 `desktop` profile 都原样不动。改过名的那次启动会记下 `renamed the desktop profile into place`。改名做不成时——新路径上已经站着别的东西——旧目录原地不动,日志如实说明,并播种一个全新的 `desktop-shell`:你留在 `web` 里的插件会由下文那道同步再搬进来一次,而改过的 patch 层、以及只装在旧 profile 里的东西,会留在旧路径上。

**那份清单里的最后一个 bundle 是本产品自己的组合层。**`@deepseek-ai/dsh-desktop-app`（[apps/desktop-app](../desktop-app/README.zh.md)）就是一份 `cordis.patch.yml`,装着出厂的 `dsh-base` 与 `dsh-web-app` 留给部署方去定的那些行,外加它自己的 `desktop-server-log` 一行所挂载的那一个插件模块。把它排在每一个内置插件之后,是因为它的行指向那些插件插入的行,而一行只能改写排在它前面的层插入的行;这个位置也让这里的一行盖过其上的每一个 bundle 层。已有 profile 缺了某个 `dsh.profile.shipped` 记录里没有的内置插件时——新构建新增的,或是之前的构建还没写过这份记录的 profile 里缺的任何一个——这个名字插在本层之前,而不是追加到末尾;记录里有的则保持缺席,因为那是插件页关掉的,但必需的内置插件无论如何都放回去;一次启动若发现有内置插件排在本层之后,就把本层挪到那个插件之后。它也不是永远的末位:同一次启动会把它从 `web` profile 迁移过来的插件追加在它之后,插件页装上的 bundle 也追加在那里。每一个 bundle 层之后还依次生效着三个用户层——`$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`,然后是 `$DSH_HOME/cordis.patch.yml`,然后是任何 `--patch` overlay。下面按它所改的 id 逐行说明。`session-query-sqlite` 打开了对话正文的全文搜索:出厂组合包把它的 `openAt` 设为 `never`,所以侧栏搜索只匹配会话标题与工作区名;本层把它设为 `first-search`,索引落在 `~/.dsh/session-search/desktop.db` 这份持久文件上。启动时什么都不打开;一次运行里的首次搜索负责建立或对账索引,之后每次搜索只读发生过变化的部分。`llm-deepseek` 这一行把 `retryPolicy.backoff.maxDelayMs` 从出厂的十秒设为五分钟。这个数字是一个被限流的请求最长愿意等完的 `Retry-After`:`@deepseek-ai/dsh-llm-retry` 只在供应商给出的这段时长落在上限之内时才等下去续跑,而 `normal` 策略遇到超出上限的时长会转而让整回合带着限流错误失败——出厂的十秒对 DeepSeek 实际返回的 30 到 120 秒窗口就是这个结果。本地退避不随之改变,仍是五次重试、最长不到九秒,等待期间转录里逐秒倒数。想改动其中任何一行,都要在你自己的 patch 层里把整行重述一遍——以 id 为目标的 patch 会替换整个 `config`,所以重述搜索那一行必须把 `path` 一并带上,重述供应商那一行必须把内置 default-model 层加在它上面的模型目录一并带上。那份目录只有 `deepseek-flash` 一行,它把出厂适配器自己的同 id 行逐字段重述了一遍:名字与它下面那句是本部署自己的,其余——上下文窗口、输入模态、`systemPromptUpdate: in-history`(正是它让会话中途的提示词变化追加在缓存历史之后而不是改写第一条消息),以及 `toolUpdate: addition-only`(它让会话中途加入的工具作为追加项出现在缓存历史之后)——都取适配器自己的值,重复一遍是因为整表替换会丢掉它没有重复的那些。这一行不设图片预算,适配器自己那一行也没有设。`vision-switch` 这一行把 `target` 定为 `deepseek-official` / `deepseek-flash`,也就是 `agent-default-model` 让每个会话起步的那个模型,所以在不支持视觉的模型上发图片时,会话切到的是它本来起步的那个模型,而不是插件里编译进去的常量;它旁边重述了 `enabled: true`,这是该插件仅有的另一个字段。`llm-permission-gateway` 这一行重述权限网关的兜底路由 `provider: deepseek-official` 与 `model: deepseek-flash`,也就是这道门仅有的两个 required 字段:审查跑在网关的 `judgeProvider` / `judgeModel` 上,它们的 schema 默认值就是同一对,存下的路由没有适配器服务、或所选模型不提供那一档思考时,才回落到这一对。在网关设置页或 `/review` 里保存过判官选择,或从旧的 `settings.yaml` 导入过,都会把这一行的整份 config 写进 `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml`,此后本层这一行就到不了那台机器。同一行还把 `plugin_manager` 加进网关的 `alwaysAsk`,并在旁边重述网关自带的 `browser_auth` 一项,因为这个字段会整体替换网关的默认表。`plugin-manager` 这一行把 `pnpmCommand` 设为壳在 `DSH_DESKTOP_PNPM` 里点名的 pnpm 启动脚本,把 `requiredModules` 设为 `@haoran/dsh-crash-resume`,与 `src/profile-seed.ts` 的 `REQUIRED_WEB_BUNDLES` 是同一份清单,并保留 dsh-base 的 `disabled` 表达式,所以上游的插件安装器和它的侧栏页保持开启;完整安排见下文「插件管理」一节。`office-to-pdf` 没有行:出厂那一行保持开着,它的转换器用壳按需下载的引擎,见下面的「Office 引擎服务」。`ui-chat` 同样没有行:工作详情按对话设置表单自己的默认值起步,壳没有定义 `dshDesktop` 全局变量,所以是 `detailed`;在设置里保存过对话显示偏好的机器,照旧用 profile 自己的 patch 层里存下的值,`compact` 也在内。`desktop-product-telemetry` 与 `product-analytics` 是 dsh-web-app 的两行产品分析,它的表达式在 profile 名不是 `desktop` 时让它们保持关闭;本层直接设 `disabled: true`,于是无论那些表达式怎么改、profile 改成什么名字,都不会打开向 DeepSeek 的上报。本层还插入了 `desktop-server-log`,把服务端自己的 logger 记录——每个插件的 error、info 与 warn,`auto-compact` 这类命名 logger 也在内——以 `[server-log]` 开头的行追加进 `dsh-server.log`;壳在 `DSH_DESKTOP_SERVER_LOG` 里把这个文件告诉服务器子进程,没有这个变量时这一行保持关闭。

壳认不出的 profile 原样保留,启动照常继续,只是没有内置插件:解析不了的清单留给服务端自己的诊断,没有声明 bundle 列表的清单按手写编排对待,该放链接的位置上是真实目录则如实报告而不是删掉。profile 目录根本写不出来是启动唯一绕不过去的失败;日志那一行会说明,随后是服务端自己的诊断。

**本次构建撤下的内置插件,会从已经有它的 profile 里取回去。**服务端会跳过 `dsh.profile.bundles` 里解析不到的名字,并在每次启动时往自己的 stderr 写一行 `skipping profile bundle "<name>": …`;所以只是「不再随包分发某个包」的升级,会让旧构建播种过的每一个 profile 都留着那个名字、也留着那一行。`src/profile-seed.ts` 里的 `WITHDRAWN_WEB_BUNDLES` 列出这些包:一次启动会把这样的名字从清单里删掉,并移除它自己为它建的扁平兜底链接。只清理壳自己留下的东西:指向本次载荷以外任何位置的链接会保留,包只要仍能解析,它的 bundle 条目也会保留——你用 `dsh plugin --profile desktop-shell add` 装的副本原样留在那里,归属仍是把它放在那里的人。这样的副本是作者发布的那一版,不带本仓库为自己分发的 tarball 所打的改动。`@sumomok/dsh-edit-rerun` 是第一条:它出现在 0.1.0-rc.21 发布前的构建里,在该版本发布之前被撤下。`dsh-better-sidebar` 是第二条:它一直分发到 0.1.0-rc.32,0.1.0-rc.33 把它撤下,改用上游自己的 `ui-sidebar-right`。`dsh-at-file` 是第三条:它一直分发到 0.1.0-rc.33,0.1.0-rc.34 把它撤下,改用上游自己的 `@` 引用——输入框里的 `ui-reference` 菜单,由 `file-reference-local` 提供文件。

**你装进 CLI `web` profile 的插件,每次启动都会与桌面 profile 保持同步。**0.1.0-rc.17 之前的每一版启动的都是 `web`,而 rc.17 到 rc.22 的每一版建出的 desktop profile 里只有那一版的内置插件、没有你自己加过的东西;从这两类版本升上来,你自己的插件都还留在壳不再编排的那个 profile 里——此后你再装进 `web` 的插件,也会照同样的方式在下一次启动时抵达 `desktop-shell`。每次启动都会读 `~/.dsh/profiles/web/package.json`,取出它 `dsh.profile.bundles` 里每一个既不是那两个随附 bundle、也不是上面的内置插件、也不在撤下名单里、也还没被记过的名字:`~/.dsh/profiles/desktop-shell/node_modules/<name>` 会得到一条指向 web profile 自有副本的链接,只有在这个包能干净挂载的前提下,该名字才会被追加进桌面清单的 `dsh.profile.bundles`,web profile 为它声明的版本才会被抄进 `dependencies`。不安装、也不复制——包仍然只住在 web profile 那一处,所以 `dsh plugin --profile web add <包>@latest` 更新的仍是两个 profile 共同挂载的那一份,而一台没有包管理器的机器也不需要有。桌面 profile 里的 `web-migration.json` 是壳自己那份「同步了什么」的记录,`@haoran/dsh-plugin-updates` 读的正是这份跨组件契约:

```json
{
  "from": "web",
  "migrated": ["dsh-toolbox"],
  "defective": [{ "name": "dsh-broken", "kind": "entry-missing", "detail": "…", "at": 1756100000000 }],
  "removed": ["dsh-taken-off-desktop"],
  "permissionPatch": "removed"
}
```

只有 `from` 与 `migrated` 两个字段的旧版标记文件,读出来 `defective` 与 `removed` 就是空数组。只有一个 profile 迄今第一次跑同步——也就是完全找不到 `web-migration.json` 的那一次——才会把下面那段里的 `cordis.patch.yml` 与 `pnpm-workspace.yaml` 整份复制过来;此后每一次同步都对这两个文件原样不动,不会覆盖你此后做过的任何编辑。

**挂载不了的插件会被禁用,既不会被丢掉,也不会悄无声息地缺席。**一个还在开发中的包,可能是还没跑构建步骤的 git 安装、不再声明 `dsh.bundle` 的版本,或是服务端自己的 loader 在 import 时就直接抛错的东西——三种不同的现场情况。服务端会跳过这样的插件、照常运行,所以留在 `dsh.profile.bundles` 里的名字每次启动都会缺席,屏幕上却什么都不说。所以处在这类状态的名字会保留链接——可查看、可修复——但不进 `dsh.profile.bundles`,它的条目会挪进标记文件的 `defective` 列表,归为三种 kind 之一:`entry-missing`(清单的 `exports` 或 `main` 指的入口文件盘上没有——未构建的 git 安装就是这种)、`not-a-bundle`(装着的版本不再声明 `dsh.bundle`),或 `load-failed`(服务端没有加载它——从那次启动自己的输出里读出来,见下文)。日志那一行是 `disabled migrated <name>: <reason>`,一个名字一行,理由按 kind 各不相同。

**删掉桌面这一侧的链接是一次「移除」,不是丢失。**web profile 里那份副本还健康,而你把它在 `~/.dsh/profiles/desktop-shell/node_modules/` 下的链接删掉,这个名字就会挪进标记文件的 `removed` 列表——`removed <name>: no longer linked in the desktop profile; still installed in the web profile, so it will not return on its own`——并且留在那儿:一块墓碑,不会被自动重新同步回来。web 那份副本也没了的名字,则会被从标记文件里彻底删掉,不留任何记录。

**你的 `web` patch 层会在第一次同步时跟着一起过来,除非你已经写过自己的。**只要 `~/.dsh/profiles/desktop-shell/cordis.patch.yml` 还是壳写下的那份空模板,web profile 的那份就会逐字节替换它——注释、`!!js` 表达式,一并带过来——`pnpm-workspace.yaml` 同理。一旦你改过桌面这一份,两个文件都不会被动,日志会点名该手工搬哪些插件的行:`skipped cordis.patch.yml: the desktop copy is already edited; carry the web profile's rows for dsh-toolbox over by hand`。任何情况下都不会做合并——patch 层是只有 loader 自己那套 YAML schema 才读得懂的东西,把两份合起来等于把那套 schema 再实现一遍。

**老版本壳当年抄进来的 `yolo-access` 预设表会被取回去,只取一次。**那次首同步把 `web` 层里有什么就整份带了过来,而在这套配对出身的那台机器上,那份东西正是 `permission` 预设表与 `llm-permission-gateway` 那一行——自 0.1.3 起,这两行都由 `@haoran/dsh-llm-permission-gateway` 自己的 bundle 层声明。网关那一行,patch 层写它的两种形态都会被取走——包自己那份 `- insert:`,以及一份以 id 为目标的副本所取的顶层 `- id:`——前提是它里面每个字段仍是随包分发的那个值。以 id 为目标的那一种才是值得取走的,而不是一份无害的重复:这样一条 patch 会替换整行的 `config`,所以一份只带着 0.1.3 那两个字段的副本,会一直把那条裁判路由钉住,并丢掉此后某个版本在自己那一行上设的任何东西。把网关行与别的行一起插入的条目,无论如何都不会被你弄丢——日志里点它的名,人留在原处。每一个 bundle 层都在你的 patch 层之前生效,所以这份抄件会把随包分发的那张表整个盖掉:在一个插件已按另一套顺序声明四行的构建上,访问方式控件仍按 0.1.3 的顺序与文案给出 0.1.3 的那几行。一次启动只在这样一行仍是当年抄过来的那一行时把它拿掉——每个字段、每个取值,不论当初按什么顺序写下——并把紧写在它上面、中间没有空行的那段注释一并带走。别的每一条条目、别的每一段注释都留在原处,`!!js` 表达式在内;`retired the permission preset table from cordis.patch.yml` 说的就是这件事。任何一处被你改过的行,包括网关那一行的裁判路由,都是你的,会留下:`skipped cordis.patch.yml: the permission preset table is not the one this shell wrote; left exactly as it is`。这个决定——包括仍是空模板的一层不经解析就得出的 `absent`——作为 `permissionPatch` 记在 `web-migration.json` 里,此后任何一次启动都不会再读这个文件。从未同步过的 profile 没有记录可写,于是每次启动读一次。

**0.1.0-rc.33 客户端存在 `~/.dsh/settings.yaml` 里的设置,会为服务端那次一次性导入先整理一遍,只整理一次。**从 0.1.0-rc.34 起,服务端首次启动时把这个文件改名为 `settings.yaml.imported`,再把每一段写进 id 与段名相同的 profile 条目;没有这个条目的段,或者带着一个该条目不当作实时设置的键的段,会整段留在改名后的文件里,之后没有任何东西再读它。所以在那个服务端启动之前,`src/settings-migration.ts` 先把文件移动成 `settings.yaml.pre-rc34`,即未经改动的原件,再把改写后的副本写回为 `settings.yaml`。`agent-presets` 改成 `agent-preset-registry` 的 `selectedDefault`,`code` 改名为 `ptc`;关掉过模式选择的客户端除外:它的新会话一直用部署默认的 `standard`,之后也照旧。`ui-theme` 写进 profile 自己的 `ui-theme` 条目,启动页读的就是它。已撤下的 `at-file` 段:关掉过 @ 引用的,把 `ui-reference` 条目关掉;它的精确文件名接在 `file-reference-local` 条目默认排除的十五个目录之后,写进 `excludedDirectories`;新的 @ 引用里没有按文件名隐藏的设置,所以这样的名字只会隐藏同名的目录。审查网关、自动压缩、MCP 服务器和余额这四段只留下各自插件接受的设置,而且每个值都要是插件接受的值。余额段的 `prices` 价格表也一并删掉:插件按维护者的只读价格源计价,存着的价格表它不读,只会为它打一条警告。`api.deepseek.com` 上的 `llm-deepseek.baseURL` 是这一版适配器不再使用的 chat completions 地址,删掉后改用适配器自己的地址;其他地址保留,窗口在应用载入后提示,告诉你它可能需要更换;这条提示在你关掉它之前一直留在记录里,所以应用载入之前就停下的启动,会在下一次启动时再提示。之前某次启动因为改动过而保留下来的审查网关 `- insert:` 行,会改写成带同样 config 的按 id 定位的行,因为网关自己的 bundle 已经插入了这个 id;这一行,以及 `config` 里没有 `alwaysAsk` 的任何按 id 定位的网关行,都会补上桌面层的 `alwaysAsk` 表。`web-migration.json` 存在却没有 `permissionPatch` 时,网关这几行要等到某次启动的播种已经把复制进来的权限行从补丁层里取回去之后才处理,免得一份播种过的副本先被改写成那一步认不出来的行;没有这个文件的 profile 从没收到过那些行,它的网关行在同一次启动里就补齐。每一个被删掉的值都连同原因记在桌面 profile 的 `settings-migration.json` 里(这是一份独立的记录,和 `web-migration.json` 并列),最后 `state` 变成 `done`。迁移在移动之后停下的那次启动,服务端启动时没有 `settings.yaml`,于是什么也不导入,这一次按 profile 的条目和随包默认值运行;下一次启动从 `settings.yaml.pre-rc34` 写出整理好的副本,交给服务端导入。服务端从不导入 rc.33 客户端留下的原样文件。另一个 profile 的服务端先导入过这个文件的,壳把 `settings.yaml.imported` 复制成 `settings.yaml.pre-rc34` 一次并整理它,让这个 profile 也导入一遍;读不了的 `settings-migration.json` 不会触发这次复制。这一步写的每个文件都只有你自己能读,因为这些设置里有 MCP 服务器的环境变量值。

**迁移过来的插件一旦会被服务端拒收,就会照同一套办法从 bundle 列表里取出去。**那个包待在归你所有、而且你还会不断改动的目录里:清空或重装 `web` profile 会让链接悬空,而在那边升级这个包,可能把它换成一个根本不再是插件 bundle 的版本。所以每次启动都会拿 `migrated` 里的每一个名字对着同一个 `bundleDefect` 重新核对,并按核对结果把它禁用为 defective、立成墓碑归入 removed,或者彻底不再追踪——`dropped migrated dsh-toolbox: no longer resolves in the web profile` 是唯一没有任何东西可留的情形,因为桌面这边的链接与 web 那份副本都没了。你后来自己接管的名字会保留它的条目:无论那是 `dsh plugin --profile desktop-shell add` 装的副本、你自己在那个路径上建的链接,还是本次构建开始随包分发的包。不做检查的是「在更老的 harness 下装的插件是否配得上这一版」:它未满足的 peer 会逐级落到本安装修复的扁平兜底目录,所以它共用本次构建的那一份 cordis,但它的代码是否对得上本次构建的 API,这里没有任何东西答得上来。

**服务端没有加载的迁移插件,会从那次启动自己的输出里被记下来,之后一直关着。**准入能拦下未构建的安装和不再是 bundle 的包,却拦不住服务端拒绝一个插件的每一种方式——现场案例是一个提交了 `src/*.ts`、完全没有 `lib/` 的 git 安装,报错是 `Cannot find module '…/lib/index.js'`;兼容检查也会拒绝 `@deepseek-ai/dsh` peer 范围不含当前构建的包。服务端对这些情况都会报告,然后不带这个插件照常运行,报告落在三种 stderr 行之一:启动审计块里的一行 `<id> (<name>): failed to import`;`<bin>: skipping profile bundle "<name>": <reason>`;或者 `<bin>: disabling profile plugin row "<id>": <reason>`,它点的是行,所以壳会到每个迁移包自己的 bundle 层里按 id 反查。审计块可能在 URL 行之后才到,所以壳在服务端运行期间读两个流的每一行。这个壳迁移过的名字会带着 kind `load-failed` 挪进 `defective`、移出 `dsh.profile.bundles`,壳记下 `disabled migrated <name> after it failed to load (<detail>); it stays off from the next launch`;这次启动不带它运行,也不会重启。import 失败的 detail 只有 `failed to import`:真正的 import 错误进服务端自己的 logger,而 `desktop-server-log` 这一行会把它的记录追加进 `dsh-server.log`,在这一行挂载之前记下的 error 也在内。在打印 URL 行之前就退出、且输出里点了某个迁移插件名的启动,会再启动一次,日志是 `disabled migrated <name> after it failed to load; retrying startup`;输出里点不到名的模块,或者第二次仍然失败,都会走到原来那个启动失败页。

**没有任何界面显示 defective 或 removed 的插件。**`dsh-server.log` 里记下它的那一行是它唯一出现的地方。要把一个带回来,就从 `~/.dsh/profiles/desktop-shell/web-migration.json` 的 `defective` 或 `removed` 里删掉它的条目;下一次启动时它若能挂载,就会被重新接纳。

**桌面端的 profile 与 CLI 的是分开的,harness home 的其余部分不是。**会话、凭据与模型设置都在 `$DSH_HOME` 根上,所以终端里的 `dsh web` 与桌面窗口读到的是同一批。分开的是挂载了哪些插件:`dsh web` 编排的是 `$DSH_HOME/profiles/web/`,桌面端从不写它。要让 CLI 也有这几个插件,就在那边用 `dsh plugin --profile web add <包>` 自行安装。反过来,上面这十四个在桌面 profile 里已经有了,其余的也由上面那个同步持续搬过来;此后你再加进 `web` 的插件,要么在你下次启动时自然抵达 `desktop-shell`,要么用 `dsh plugin --profile desktop-shell add <包>` 立刻装进桌面 profile,它列在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里。

**如果你在这版之前自己装过其中某个插件**,profile 自己的 `node_modules` 里仍留着那一份,Loader 会先找到它,而 patch 层依旧来自载荷。启动会如实说明——`warning: profile copy @sumomok/dsh-quote-message@0.3.1 shadows the shipped 0.4.0 module`——但什么都不改,因为 profile 的依赖归安装它的人所有。`dsh plugin --profile desktop-shell remove <name>` 会去掉 profile 里那一份、留下分发的那一份,也就是全新安装本来的状态。

**要关掉其中一个,就用插件页上它的开关。**插件页在**已安装**下列出这十四个,带**内置**标签、整个插件的开关、版本,以及各自带开关的组件行,不提供卸载。每次启动都会把这十四个名字写进 `~/.dsh/profiles/desktop-shell/package.json` 的 `dsh.profile.shipped`,而开关只把名字从 `dsh.profile.bundles` 里删掉,所以之后的启动看到它在记录里,就让它保持关闭;看到它被重新打开,就让它保持打开。指向载荷的链接保留,所以关着的时候新构建的版本也会到达它。`@haoran/dsh-crash-resume` 是例外:桌面组合层把它写进 `plugin-manager` 行的 `requiredModules`,所以它的开关和它组件行的开关都置灰,没有卸载,页面提示**应用必需，不能停用或卸载**;之前把它关掉的 profile,下次启动会被重新打开。在下面这个 patch 层里停用它的 `crash-resume` 行仍会把它关掉,而插件页与 `plugin_manager` 工具都无法再把这一行打开;从文件里删掉这一行才行。在这个 patch 层里重述 `plugin-manager` 行的 `config` 而不带 `requiredModules`,同样会去掉这把锁,因为 patch 替换的是整个 `config`。只想关掉其中一个组件,就在 `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml` 里禁用它那一行——截图工具是 `screenshot`,引用是 `ui-quote-message`,余额 chip 是 `balance`:

```yaml
- id: screenshot
  disabled: true
```

`@` 提及文件与会话不是内置插件:那是上游的 `ui-reference` 一行,在同一个文件里用同样的办法禁用。

**网关是唯一一个不该单独禁用其行的内置插件。**它的 patch 层贡献了两行——门本身,以及那张加入自动审查的预设表——单独禁用门这一行,会让那一行留在控件里而背后空无一物:一个以审查命名的方式,做的却是把沙箱关掉而什么都不审,严格差于完全权限——后者至少还有 `never` 这条审批策略,把沙箱本会提出的申请直接拒掉。先把会话切到别的访问方式;若还想让它从控件里消失,就在你自己的 `cordis.patch.yml` 里重述 `permission` 行的 `presets` 而不带 `yolo-access`——以 id 为目标的 patch 会替换整个 `config`,所以那次重述必须把你要保留的预设一并写全。

## 渲染服务

**壳把自己的 Chromium 借给服务端**,所以截图不取决于这台机器上装没装 Chrome 或 Edge。在启动服务端之前,主进程在 `127.0.0.1` 与一个临时端口上打开一个 HTTP 监听、生成一个 32 字节的 token,并把两者放进那一个子进程的环境——`DSH_DESKTOP_RENDER_ENDPOINT` 与 `DSH_DESKTOP_RENDER_TOKEN`,绝不放进壳自己的 `process.env`,所以用户启动的任何别的进程都继承不到。`@haoran/dsh-screenshot` 每次调用都去读它们。两个都读不到的 harness 改用系统上的无头浏览器渲染,这也正是所有非桌面安装的做法;监听没能打开的那次启动会记一行日志并照常继续,它的截图走的是同一条退路。

渲染请求是 `POST /render`,带 `authorization: Bearer <token>`、`content-type: application/json`,以及请求体 `{ url, width, height, fullPage?, delayMs?, timeoutMs?, onTimeout?, blockHosts?, headers?, cookies?, userAgent?, partition? }`;下面那三条登录路由带同样的两个头,以及各自的 JSON 请求体。`POST /render` 可能得到的全部回答:

| 回答 | 何时 |
|---|---|
| `200 image/png` | 截图本身,PNG 字节,尺寸正好是请求的视口——或者,对一个发了 `onTimeout: "capture"` 的请求,是期限越过时页面已经画出来的那一帧 |
| `400` | 不是 JSON、不是对象、请求体超过 64 KB、某个字段类型不对、`width` 或 `height` 不在 16–4096 内、`delayMs` 不在 0–10000 内、`timeoutMs` 不在 1000–120000 内、`onTimeout` 不是 `fail` 或 `capture`、某个 `blockHosts` 条目不是主机模式或命中了页面自己的主机、`url` 不是绝对 URL、某个 `headers` 或 `cookies` 条目越界或不合它的文法,`userAgent` 为空、超过 512 个字符、不是一个头部值,或 `partition` 不是字符串、超过 278 个字符 |
| `401` | 缺少或写错 bearer token |
| `404` | 四条路由以外的任何路径或方法 |
| `422` | 格式正确但 scheme 不是 `http`、`https` 或 `file` 的 URL,在 `file:` URL 上带了 `headers`/`cookies`,`partition` 落在 `persist:dsh-render-login-<registrable-domain>` 之外,或在 `file:` URL 上、在 `cookies` 旁边带了 `partition` |
| `500` | 页面加载失败或截图失败;这一行带着 Chromium 的错误码 |
| `503` | 已经受理了四个请求 |
| `504` | 该请求越过了自己的期限且没有像素可答;这一行说出渲染当时在等什么 |

每个失败响应体都是一行 `text/plain`,因为读它的是一个工具,它会把这句话引进模型看到的消息里。

**每一个真的开始渲染过的回答都带着一份报告**,放在 `x-dsh-render-report` 上:整份记录以 JSON 形式、按「`decodeURIComponent` 能原样还原」的方式做百分号编码,出现在 200、拒绝一次失败渲染的 500,以及 504 上。而一个根本没有开始渲染的拒绝——校验的 400 或 422、401、404、503——不带它。之所以放在响应头而不是响应体里,是因为最需要它的那两个回答的响应体已经被占了;调用方无论渲染以哪种方式结束,都读同一个结构。

| 字段 | 它说什么 |
|---|---|
| `version` | `1`;不认识这个数字的读者应当忽略其余部分 |
| `outcome` | `complete`、`timeout`(504 与部分截图的 200 都是它)或 `failed` |
| `phase` | `queued`、`navigating`、`loaded`、`delaying`、`measuring`、`resizing`、`capturing` |
| `elapsedMs`、`deadlineMs` | 该请求被受理了多久,对照它当时运行在哪个期限之下 |
| `requestedUrl`、`mainDocument` | 请求的是什么,以及主框架最终落在哪里的 `{ url, status, redirected, title }`——在它报告导航之前是 `null` |
| `loadEventFired`、`firstPaint` | load 事件有没有触发,以及窗口有没有画出过一帧 |
| `requests` | `{ total, completed, failed, pending, blocked }`,统计真正上了线的请求,以及单独统计被 `blockHosts` 取消的那些 |
| `pending`、`failed` | 各至多 5 条:最旧的在前的 `{ url, type, ageMs }`,以及按失败顺序排的 `{ url, type, error, status }` |
| `hosts` | 至多 5 条 `{ host, pending, failed, blocked, maxAgeMs }`,在飞行中的最多的排在最前——这正是调用方该填进 `blockHosts` 的东西 |
| `console` | `{ errors, warnings, samples }`,其中至多引用 3 条错误消息 |
| `mainFrameError`、`renderer` | 来自 `did-fail-load` 的 `{ code, description }`,以及来自渲染进程的 `{ gone, unresponsive }` |
| `capture` | 这个回答所带像素的 `{ partial, width, height }`,不带像素时为 `null` |

**这套编码把 `%` 也转义掉**,这个响应头与 `x-dsh-render-landed-url` 都是如此,于是上线的东西正好是 `decodeURIComponent` 的逆:否则一个带 `%20` 的 URL 会带着一个空格回来,而一个带裸 `%zz` 的 URL 会让读取方的解码抛错、把整个值都赔进去。读这两个响应头的一方都要解码;别处不会,因为这两个头都不会被直接当作 URL 使用。

这个响应头是靠构造方式定死上界的,而不是截断到某个长度——被截断的头是谁也解析不了的 JSON:每个列表都限了条数,每个 URL、主机与标题限在编码后的 96 字节、每条消息限在 160 字节,每个被截的字符串都以省略号结尾。所有列表都填满时,这个头是 4.2 KB,在 6 KB 的天花板之下。上界数的是编码后的字节而不是字符,所以一个 URL 与标题是中文的页面、或者一个满是转义的页面,同样落在这个天花板之内——在那里,一个可见 ASCII 之外的字符要花三个字节,一个 `%` 也一样。

**期限属于请求自己。**`timeoutMs` 从受理时刻起算,取值 1000 到 120000;不给这个字段的请求拿到 25 秒,也就是这个字段存在之前写的每一个调用方拿到的数。越界的数会被拒绝而不是被悄悄挪动,因为一个要了三分钟、却被默默给了两分钟的调用方,会按它发出去的那个数装好自己的 abort,并在答案到达之前先放弃。给了这个字段的调用方则反过来持有这段关系:`@haoran/dsh-screenshot` 把自己的 fetch abort 装在 `timeoutMs + 5000` 上,所以壳的回答总是先到。

**`onTimeout: "capture"` 把一次越过的期限变成像素。**在期限那一刻,壳对窗口已经画出来的东西做一次 `capturePage()`,并以 200 回答这张图,同时带着 `outcome: "timeout"` 与 `capture.partial: true`——一个头像卡住的页面通常已经把其余部分排好版了,那张图加上这份报告,是比一句话更好的答案。只有主动要了它的请求才可能收到部分截图,所以把 200 读作「这就是加载完的页面」的调用方永远不会读错。这次截图上限 3 秒,而这次渲染无论如何都被放弃;它失败或超过上限时,回答就是那个照旧的 504 加它的报告。队列在期限越过的那一刻就往前走,而不是等截图结束,所以一次卡住的截图只耽误它自己。

**`blockHosts` 就是报告点名的那个补救办法。**它是至多 32 条主机模式的列表——精确主机,或匹配该后缀的子域(不含后缀本身)的 `*.suffix`,每条至多 253 个字符,匹配时不分大小写——命中的请求在 `onBeforeRequest` 里于发出之前被取消,并计入 `requests.blocked`。命中当前被渲染页面自己主机的模式会被一个点名它的 400 拒绝,因为一次把自己文档取消掉的渲染只会失败,且说不出任何理由。这是壳唯一注册的阻塞式 `webRequest` 钩子,而且只对真的带了这个字段的请求注册:没写 `blockHosts` 的渲染,时序与没有这个特性时完全一致。

**一个请求可以带上页面所需的会话。**`cookies` 是至多 32 条 `{ name, value, domain, path?, secure?, httpOnly?, expirationDate? }` 的数组——成员就是 Chromium 自己的那一套,所以调用方从浏览器里导出什么就发什么——在加载之前设到这次渲染自己的 session 上。它们不只覆盖文档,也覆盖页面的子资源,这正是要害:一个图片全部 401 的已登录页面,不是任何人想看的那个页面。`domain` 是必填的,每条 cookie 的作用域由它决定,所以一个请求可以带上页面要访问的每一台主机的 cookie;`path` 默认是 `/`,而不是 RFC 6265 的默认路径——那是 cookie 被存进来的那个目录,而不是整个站点:停在 `/app/issues/` 的 cookie,页面发往 `/api/…` 的请求一个也碰不到。`headers` 是 name→value 的映射,只挂在主框架那一次导航上,这正是 bearer token 或 Host 覆写需要的位置;`cookie` 头会被指名拒绝并指向 `cookies`,因为那样送进去的 cookie 只覆盖文档、覆盖不到文档里的任何东西。cookie 与头部合起来受同一组边界约束:最多 24 个条目、共 8 KB,名字必须是 HTTP token,头部值限于可见 ASCII 加空格与制表符(换行会凭空追加一个谁也没发过的头,因为 `loadURL` 把它们当作一整个以换行分隔的字符串),cookie 值限于 RFC 6265 的 cookie-octet。拒绝信息从不把 cookie 的值回引出来,因为那个值正是这个字段要携带的凭据。

**每次渲染各自持有一份 cookie 存储。**窗口的 partition 名字带一个新的 UUID,且没有 `persist:` 前缀,所以这个 session 随窗口创建、只活在内存里、随窗口销毁:凭据由调用方提供,壳自己一个也不留,上一次渲染的 cookie 下一次读不到,也没有任何东西落到磁盘上。后半句由 smoke 证明而不是假设——先带着会话 cookie 渲染一次,再对同一个 URL 不带 cookie 渲染一次,站点照旧用它的登录跳转来回答。唯一的例外是点名了登录 partition 的请求:它在那份持久存储里渲染,那是唯一会落到磁盘上的渲染会话。

**一个挡在登录墙后面的页面,要等用户登录过它之后才截得到。**从空的开始的 partition 只会把它渲染成未登录的样子,而它的 cookie 谁也没导出过、填不进 `cookies`。`POST /login-grant` 收 `{ url, partition }`,答 `{ nonce, expiresInMs }`,它自己不开任何窗口。url 的主机必须是这个 partition 的可注册域或它的子域,否则这次授权会被拒绝,因为一对对不上的组合会把一个站点的 cookie 记在另一个站点的名下。nonce 一次性、可花 30 秒,同时最多有 8 个未花掉——再要就是 503。

**`POST /login` 收 `{ nonce }`,并在用户关掉窗口时答 `{ landedUrl, sameSite }`。**页面与 partition 在铸出 nonce 的那一刻就定死了,所以这个请求体里没有任何东西能选它们。同一时刻只开一扇窗,第二个调用得到 503,而且这一步在花掉 nonce 之前检查,所以重试的调用方手里那个 nonce 还在。不认识的、已经花掉的或者已经过期的 nonce 得到 403;504 说的是十分钟的登录期限过了,或者壳正在退出。

**`DELETE /login-sessions` 就是退出登录。**它收 `{ partition }`,对它调用 `clearStorageData()`——cookie、缓存,以及 Chromium 为一个 partition 保存的每一种存储后端——并答 `{ partition, cleared: true }`。这四条路由接受的 partition 只有 `persist:dsh-render-login-<registrable-domain>` 一种,域名小写、由调用方自己算出,所以调用方既读不到也抹不掉用户自己那扇窗所在的 partition。

**登录窗口是可见的,并且说出正在问你的是哪个站点。**它的标题被锁在当前源上,`did-navigate`、`did-redirect-navigation`、`did-navigate-in-page` 与 `page-title-updated` 每一个都重新锁一次,最后那个的默认行为被取消,于是页面写不了自己的标题;它是 `resizable: false`,这也正是壳用来把应用自己那扇窗与其余每一扇分开的东西。权限请求、权限检查、下载与声音照渲染窗口那样一律拒绝,devtools 保持关闭,`sandbox`、`contextIsolation` 与「没有 Node 集成」原样不动。放松的只有两处:页面要开的窗口变成这同一扇窗的一次导航,而不是被丢掉,于是一次 OAuth 交接能走完全程、始终没有第二扇窗打开;以及对话框是可用的,因为真实的登录页要靠 `alert()` 与 `confirm()` 报出密码错了,而这扇窗用户正看着。

**登录 partition 是这个服务唯一允许留存的东西。**它的值躺在应用 userData 目录下、Chromium 自己那份加密的 profile 存储里;壳里没有任何东西去读其中的 cookie 值,也没有任何一条路由把它返回出来。点名了 partition 的渲染不带自己的 `cookies`,因为把调用方自己的 cookie 罐写进一个活得比这次请求更久的存储,等于替它保存一份凭据。

**`userAgent` 决定这次渲染自称是谁。**Electron 自己的默认值是 `…Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36`,它等于告诉 agent 看的每一个页面:看你的是这个壳——有些站点还会因此回一个不一样的页面。写了这个字段的请求会在加载之前把它同时设到 session 与 web contents 上,于是文档、它的子资源以及 `navigator.userAgent` 报的都是它;没写的请求保持默认值。它必须是一个非空、至多 512 个字符的头部值。

**当主框架最终落在请求所指之外时,`200` 会说出它落在哪里**,放在 `x-dsh-render-landed-url` 上,与报告用同一套百分号编码,并截到 96 个字符。一张登录页的截图是「正确地渲染了错误的页面」,而像素本身说不出它是哪一种;插件把这个响应头变成工具结果里的一句话,点名 `cookies` 与 `headers`。主框架停在原地时不发这个头,比较的是归一化之后的 URL,所以 Chromium 给源地址补上的那个斜杠不算重定向。

**截图的尺寸就是请求的尺寸。**`capturePage` 返回的位图带着显示器的缩放系数——Retina Mac 上是 2,多数 Windows 机器上是 1——所以同一个 1440x900 的请求本会在两边给出不同的图像。窗口保留它原本的缩放系数,因为强制指定是一个进程级开关,会波及用户自己那个窗口;截图则在编码之前被缩放到请求的 CSS 像素:整页截图缩放到请求的宽度与它测得的高度。把一张 2x 的截图降采样,不会损失 1x 渲染本来就有的任何东西。

**504 会说出页面当时在等什么**,好让调用方分得清是一张卡住的图、一个死掉的代理,还是一个卡死的渲染进程。这一行说出渲染当时处在哪个阶段——在排队、在加载页面,还是已经越过 load 事件、正在等 `delayMs`、测量、调整窗口大小或截图——而在页面还没加载完时,它还会说出主文档的 HTTP 状态码、主框架最终落在哪里(当那不是请求所指的地址时),以及最多三个仍在飞行中的请求及其 Chromium 资源类型:`render timed out after 25000ms: main document 200, load event not fired, 7 requests pending: [image] https://www.gravatar.com/avatar/…, [image] …, [script] … (+4 more)`。每个 URL 截到 96 个字符,整行截到 500 个字符,后者正是 `@haoran/dsh-screenshot` 引进模型消息里的长度;报告响应头以结构的形式说同一件事。渲染本身不因这一切改变:壳是从主进程事件——`did-navigate`、`did-redirect-navigation`、`page-title-updated`、`ready-to-show`、`did-fail-load`、`console-message`、`render-process-gone`、`unresponsive`——与 session 上那几个非阻塞 `webRequest` 钩子读到这些的,它们只观察请求,不扣住请求。

**每次渲染都拿到一个与应用自己那扇窗毫无共享的隐藏窗口。**它的 session 没有 `persist:` 前缀,所以只活在内存里、随窗口一起消失:被渲染的页面读不到也写不了用户正在用的那扇窗的 cookie、存储与缓存,它存下的东西也活不过这一个请求。点名了登录 partition 的请求改在那份持久存储里运行,而这张清单上的其余每一条对它照旧成立。没有 Node 集成、没有 `webview`、没有 devtools;每一个权限请求都被拒绝,页面试图发起的每一次下载与每一次开窗也都被拒绝。对话框被禁用,于是 `alert()`、`confirm()`、`prompt()` 既不会在一扇用户看不见的窗口上弹出原生模态框,也不会把它背后的页面线程堵住;窗口是静音的,于是自动播放的 `<audio>` 元素传不到扬声器。窗口在响应时、加载失败时与期限到时都会被销毁。

**边界在哪**:同一时刻只渲染一个,同时最多受理四个请求(一个在渲染、三个在等),期限从受理时刻起算而不是从渲染开始时算——用的是请求自己的 `timeoutMs`,默认 25 秒、至多 120 秒——以及在那个期限上给部分截图的 3 秒。`fullPage` 截图会测量 `document.documentElement.scrollHeight` 并把窗口调到那个高度,夹到 8192 px 为止,因为无限滚动的文档报出的高度会在测量过程中一直变大。

**三条机制框定了谁够得着这个服务。**监听绑在 loopback 上,机器外的东西根本连不上。token 以常数时间比较,所以扫到端口的本地进程没有 token 也用不了这个服务。从不发送任何 CORS 头,同时四条路由以外的任何路径与方法一律答 404,于是 `authorization` 头与 JSON content type 逼浏览器发出的预检被拒绝——这正是把用户自己浏览器里的页面挡在外面的东西。

构建之后,这条命令检查单元测试够不着的那一半——隐藏窗口到底画不画:

```sh
pnpm --filter @deepseek-ai/dsh-desktop-shell run build:ts
pnpm --filter @deepseek-ai/dsh-desktop-shell run render-smoke
```

它在真实的 Electron 里渲染一个本地文件,检查截图尺寸无论显示器缩放系数是多少都正好是请求的视口、整页截图确实比它更高,以及 401、422 与 500 三种回答。有一个用例起一个站点:任何没有会话的访问都被重定向到它的登录页,并在真实 Chromium 上核对三种结果——不带会话时回答里有落点响应头,带 cookie 与带 header 时都没有。下一个用例把页面放在 `/app/issues/` 下,一张图在它旁边、另一张在 `/api/` 下,断言的是这个站点收到了什么,而不是回来的像素:cookie 出现在全部三个请求上,而额外的 header 只出现在那次导航上、两张图都没有。一个调用 `console.error` 的页面证明 `console-message` 与页面标题确实进到了报告里。其余用例让页面去请求一个本地监听——它接受连接却从不回答——这正是任何注入渲染器都替代不了的部分:在 `onTimeout: "capture"` 之下回答是一个 200,它的 PNG 解出来正好是请求的尺寸,报告写着 `outcome: "timeout"` 并点名那个卡住的主机;用 `blockHosts` 点名同一个主机,它会在不到十分之一秒内完成、`requests.blocked` 为 1;什么都不做时,504 在它那一行与它的报告里都点出那张图。

## 插件管理

**安装、启用、停用、移除插件,都由上游的插件管理器来做。**桌面组合层让 dsh-base 的 `plugin-manager` Host 行与 dsh-web-app 的侧栏**插件**页保持开启,所以这个页面对 `desktop-shell` profile 的 bundle 的操作,与它在任何基于 profile 的 `dsh web` 上一样;web 应用的 cordis 预设也在同一个服务上挂上 `plugin_manager` 这个 agent 工具。这个页面没有逐包更新的操作,也没有撤回。内置插件是播种进去的、不是装进去的,随应用更新而变。

**安装跑的是安装包自带的 pnpm,经由一个启动脚本。**`scripts/package.ts` 用 `npm pack` 把仓库自己的 `packageManager` 钉住的那个 `pnpm` 版本暂存到 `staging/pnpm`,并把 `src/pnpm-launcher.ts` 里两个平台的启动脚本暂存到 `staging/pnpm-launchers`;`verifyStaging` 要求两个脚本都在,且 macOS 那个带可执行位。`scripts/after-pack.cjs` 把 pnpm 复制到 `resources/runtime/pnpm`——extraResources 带不了它,因为 pnpm 自己的目录树里有 `node_modules`,而打包器的复制器硬性排除这类目录——并把目标平台的脚本复制为 `resources/runtime/dsh-pnpm` 或 `resources/runtime/dsh-pnpm.cmd`。脚本用 `runtime/node` 运行 `runtime/pnpm/bin/pnpm.mjs`,并把 `runtime/` 放到 `PATH` 最前面,因为 `pnpm.mjs` 以 `#!/usr/bin/env node` 开头而机器上没有 Node,而插件管理器的 `pnpmCommand` 只指一个可执行文件、不带它自己的参数。壳只给服务端子进程设 `DSH_DESKTOP_PNPM=<脚本路径>`,桌面层的 `plugin-manager` 行把它读成 `pnpmCommand: !!js process.env.DSH_DESKTOP_PNPM ?? 'pnpm'`。开发启动什么都不设,用的是 `PATH` 上的 `pnpm`。

**即使插件页装上了上游的 auto-review,它也保持关闭。**载荷有意不带 `@deepseek-ai/dsh-experimental-auto-review`,但注册表仍能提供它;它的层会在权限网关旁边挂上上游的 Auto,两者读同一对旋钮,同一次调用会被审两遍。每次启动都在 `$DSH_HOME/profiles/desktop-shell/cordis.patch.yml` 里保留下面这一行,上方有一段注释写明用途;这个文件在所有 bundle 层之后生效:

```yaml
- id: auto-review
  disabled: true
```

那里的 `auto-review` 行只要写着别的内容——插件页的启用会在这一行上写 `disabled: false`——就原样保留,启动日志里记一行。删掉这一行只管到下一次启动。这个包没装时,`dsh --profile desktop-shell --dump-config` 会为这一行打印 `patch: entry "auto-review" not found`,服务端照常运行。

**每次 `plugin_manager` 调用都交给人。**一次调用就能装上在工作区沙箱之外运行的代码,或者停用某一行——包括权限网关自己那一行。所以桌面层的 `llm-permission-gateway` 行把 `plugin_manager` 加进网关的 `alwaysAsk`,与它重述的网关自带的 `browser_auth` 并列。在「自动审查」与两个有围墙的档位下,网关在任何审查模型看到这次调用之前先问你,附一句说明它能改动什么的话。在「完全权限」下,什么都不问。

## 语音输入

**语音输入出厂关闭,与上游的出厂状态一致。**`@deepseek-ai/dsh-experimental-voice-input-bundle` 是上游 `OPTIONAL_BUNDLES` 之一:载荷带着它,没有任何 bundle 选中它,上游的**插件**页把它列出来,由人打开。它的层加上语音转文字服务、本地 SenseVoice 识别器、HTTP API,以及输入框里的麦克风按钮。打开它不会下载任何东西。

**识别模型在人要求时才下载,不随包。**模型还没准备好时点麦克风,会弹出提示把人带到语音输入的插件详情,那里的**下载并准备**按钮下载 INT8 SenseVoice 模型(约 239 MB)、它的 `tokens.txt`(约 0.3 MB)和 Silero VAD 模型(约 1.8 MB),每个都钉在一个固定版本上,并核对 sha256。来源是 `huggingface.co` 与 `hf-mirror.com`:默认情况下识别器向两者各发一个 `HEAD` 请求,先试先应答的那个,失败再换另一个;在卡片上选定的来源则只用它一个。文件落在 `$DSH_HOME/speech-to-text/sensevoice/models/` 下。两个来源都连不上的机器用不了语音输入。

**每份载荷带着自己平台的识别运行时。**识别在服务端用随包 Node 运行时启动的 worker 里进行,它加载 `sherpa-onnx-node` 和旁边的平台成员:macOS 载荷里是 `sherpa-onnx-darwin-arm64`(约 34 MB,含 `libonnxruntime.dylib`),Windows 载荷里是 `sherpa-onnx-win-x64`(约 23 MB)。成员是按相对路径加载的,可达性遍历看不见,所以 `scripts/bundle-closure.ts` 的 `NATIVE` 点了两个平台的名字,`scripts/platform-dir-rules.ts` 的顶层规则只留目标平台自己的那个。macOS 上这些库凭 `disable-library-validation` entitlement 加载,与 sharp、koffi 一样。

**麦克风由应用窗口录音,而且只有窗口里嵌入服务端提供的页面能打开它。**页面通过 `getUserMedia` 录音。`src/microphone-permissions.ts` 在应用窗口的 session 上回答 `media` 请求:只允许应用窗口里嵌入服务端页面的主 frame、只限音频,其他 frame 与来源一律拒绝;其余权限保持 Electron 的默认。macOS 上一个被允许的请求会先问系统,系统弹窗显示 `electron-builder.yml` 里的 `NSMicrophoneUsageDescription` 那句话;签名后的应用带着 `com.apple.security.device.audio-input` entitlement,没有它,hardened runtime 会不问就拒绝麦克风。Windows 不需要声明;系统隐私设置里允许桌面应用使用麦克风的开关要开着。

## 更新服务

**更新通道归壳所有,而设置窗口是嵌入服务端画的**,所以用户能看见更新、并对它动手的那一处,落在一条本机监听的另一侧。这是渲染服务之外的第二个,打开的方式与传递的方式完全一样:在 `127.0.0.1` 与一个临时端口上的 HTTP 监听、一个 32 字节的 token,两者都只放进服务端那一个子进程的环境——`DSH_DESKTOP_UPDATE_ENDPOINT` 与 `DSH_DESKTOP_UPDATE_TOKEN`,绝不放进壳自己的 `process.env`。两个都读不到的 harness 会报告该能力不可用,并且根本不放出更新入口,这正是服务器上所有 `dsh web` 的做法。两个服务分开,是因为它们借出的权力不同,而这一个借出的更重:`/install` 会替换掉整个应用。

四条路由:一条 `GET /state` 与三条 `POST`,都不读请求体,四条都带 `authorization: Bearer <token>`。

| 路由 | 回答 |
|---|---|
| `GET /state` | `200 application/json` —— 下面那份快照 |
| `POST /check` | `202 application/json` —— 快照;检查在后台跑,查到什么就下什么 |
| `POST /download` | `202 application/json` —— 快照;已查到那个版本的传输被开始或重启,一个版本都不知道时先跑一次检查 |
| `POST /install` | `202 application/json` —— `{ "ok": true }`,在任何东西停下之前就写出;服务端与安装器的接手排在下一个 tick。phase 不是 `ready` 时答 `409` |
| 其它任何路径或方法 | `404`,而且这一判定在看 token 之前就做完,所以一个没有凭据的调用方对这里提供什么一无所知 |
| 缺少或写错 token | `401` |

快照是一个 JSON 对象。`phase` 与 `currentVersion` 总在;其余每个字段在不适用时**直接省略,而不是发一个 null**,于是读的人靠「在不在」就能把「没有值」和「值是 0」分开。

| 字段 | 类型 | 何时 |
|---|---|---|
| `phase` | `"idle" \| "checking" \| "downloading" \| "ready" \| "failed"` | 总在 |
| `currentVersion` | string | 总在 —— 正在运行的构建 |
| `latestVersion` | string | 某次检查看到了比运行版本更新的版本时 |
| `releaseNotes` | string | 清单为 `latestVersion` 带了发布说明时 |
| `percent` | number,0–100 | 仅 `downloading` |
| `transferredBytes` | number | 仅 `downloading` |
| `totalBytes` | number | 仅 `downloading`,且传输已经知道产物大小之后 |
| `reason` | string | 仅 `failed` —— 一行壳自己措辞的诊断,不是本地化文案 |
| `checkedAt` | string | 上一次跑完的检查的 ISO 8601 时间戳 |

**值得显眼呈现的只有 `ready` 一个 phase。**它是唯一那种「更新已下载、已对着清单的 sha512 校验通过、点一下就能装」的状态;`downloading` 同时带上 `percent` 与两个字节数,是给主动点进设置去看的人用的,它不该出现在侧栏或角标上。`ready` 还会熬过此后的每一次检查,所以定时检查不会把一个已经就绪的更新从屏幕上收回去。`failed` 覆盖两种情形,由 `reason` 分辨:一种是被网络打败的检查或传输,下一次检查会从头再来;另一种是这个构建根本装不上更新——从源码启动的实例,或者原地安装路径已经失败的 macOS 构建——本次运行里没有任何东西能改变它。壳发出的 phase 就是这五个;一个还需要「这套部署根本没有更新通道」这一状态的读方,自己拥有那个值,因为壳只为它确实有的通道作答。

**`POST /install` 不弹任何对话框,而且先答再做。**设置窗口里的那次点击就是同意,再来一个原生确认框只是把那次点击已经回答过的问题重问一遍;这条路由在 `ready` 之外一律被拒,所以它唯一能装上的东西,是校验和已经与清单对上的那个产物。`{ "ok": true }` 先上线,安装排在下一个 tick——因为安装会停掉嵌入服务端,并把机器交给一个要替换掉本进程的安装器,而一个还等在响应上的调用方,会把那次断开的连接读成一次失败的安装。

**`/install` 的 token,服务端里跑的每个插件都够得着。**它注入的是服务端子进程的环境,所以那个进程里的任何代码——包括第三方插件,而它们自己不声明任何审批闸——都能调这条路由。它买到的东西是有上限的:退出应用,并装上一个 sha512 已被 electron-updater 逐字节对着更新源清单核对过的更新(`DownloadedUpdateHelper.getValidCachedUpdateFile`),macOS 上还必须满足运行中那个 bundle 的 designated requirement。它不是一条执行任意代码的路;最坏的代价是一次没人要求的重启。它不弹原生确认,因为它只装更新源发布的那一个产物,从不装调用方指名的包。所以审计一个第三方插件时,要一并看它有没有读 `DSH_DESKTOP_UPDATE_TOKEN`。

## Office 引擎服务

**载荷里不带 LibreOffice 引擎;用户要的时候,壳去下载随包 kit 声明的那一个。** `@deepseek-ai/dsh-office-to-pdf` 借 `@deepseek-ai/libreoffice-kit` 把 Word 与 PowerPoint 文件转换给右侧边栏的文档标签页看,而 `platformDirRules` 把 kit 的每一个引擎都从两个载荷里剔掉:`@deepseek-ai/libreoffice-kit-darwin-arm64` 下载 64 MB、解压 145 MB,`-win32-x64` 是 68 MB 与 182 MB。`src/office-engine.ts` 从随包 kit 自己的 `optionalDependencies` 里读出引擎的名字与精确版本,路径是 `@deepseek-ai/dsh` → `dsh-web-app` → `dsh-office-to-pdf` → kit,所以 kit 一升级,要下载的东西也跟着变,前提是 `ENGINE_DOWNLOADS` 登记了新 kit 声明的引擎版本。`ENGINE_DOWNLOADS` 记着两个桌面目标已发布压缩包的大小(确认框按整 MiB 报它)和 sha512 完整性值(即 registry 的 `dist.integrity`),桌面构建会带上的每个 kit 版本各记一份:工作区按 `pnpm-lock.yaml` 钉的版本装 kit(0.1.1),打包的服务端闭包则来自 legacy hoisted `pnpm deploy`,它不认这个钉住的版本,把 kit 的 `^0.1.1` 范围解析到部署那一刻已发布满 pnpm `minimumReleaseAge`(不另行配置时为一天)的最高版本,所以之后再部署可能暂存到更新的 kit;2026-10-01 部署的暂存里是 0.1.3,而 2026-10-02 01:18 UTC(0.1.5 发布满一天)之后部署的会暂存 0.1.5。表里没有的版本不提供下载:`/state` 读作 `unsupported`,日志里说这个版本还没有登记。工作区的 kit 一旦声明了表里没有的引擎版本,就有一条测试失败;暂存的 kit 为 `darwin-arm64` 或 `win32-x64` 声明了表里没有的版本时,打包在 `verifyStaging` 之后停下(`scripts/office-engine-gate.ts`),打印声明的版本和缺的 `<package>@<version>` 条目;kit 从暂存树之外解析出来时,打包同样停下。

**引擎放在哪。** 数据目录下的 `engines/office/`,每个版本一个目录。数据目录眼下是 `$DSH_HOME`(默认 `~/.dsh`);由 `main.ts` 把它交给 `officeEngineRoot`,而不是模块自己去读,所以数据目录搬走时引擎跟着走。kit 从它自己所在的目录解析引擎,不从配置读任何路径,所以壳从启动起就把 `<root>/<version>/node_modules` 放在服务端子进程 `NODE_PATH` 的第一位,不管引擎装没装。Node 只在启动时读一次 `NODE_PATH`,只缓存解析成功的结果,`office-to-pdf` 又会丢掉创建失败的转换器,所以下载完之后的第一次转换就能找到引擎,不用重启。同一个路径也放进 `DSH_DESKTOP_OFFICE_ENGINE_MODULES`;`@haoran/dsh-office-preview-notice` 的宿主那一半在 apply 时把这一项从 `process.env.NODE_PATH` 里删掉,于是服务端启动的进程不再继承它,服务端自己照样经它解析。每次启动、在服务端起来之前,壳删掉 root 下除 kit 声明的那个版本(不论是否已登记)以外的每个版本目录,以及中断的下载留下的每个暂存目录,这次启动不提供引擎时也照删;kit 没给本机声明精确版本或读不出来时,一个版本也不留。root 下别的东西一概不碰。

**它怎么来。** 壳在 root 里新建的暂存目录中运行随包的 pnpm:`runtime/node runtime/pnpm/bin/pnpm.mjs add <engine>@<version> --ignore-workspace --ignore-scripts --reporter=ndjson --config.node-linker=hoisted --store-dir=<staging>/.pnpm-store`,`runtime/` 放在 `PATH` 最前;开发启动用 `PATH` 上的 `pnpm`。它用随包的 Node 直接跑 `pnpm.mjs`,不经过 `dsh-pnpm.cmd`——Windows 上 Node 不借 shell 就起不了 `.cmd`——所以取消停下的就是 pnpm 本身。pnpm 按 registry 元数据列出的完整性值校验压缩包、按 `os` 与 `cpu` 过滤、保留 kit 要检查的可执行位,并且读用户自己的 `.npmrc`,那里配的镜像或代理照样生效;`--config.lockfile=true` 让那份文件关不掉锁文件。下载从不经过 Electron 的 session,否则 macOS 会给它写下的每个文件打上隔离属性。之后壳拿这次运行的 `pnpm-lock.yaml` 给引擎记下的完整性值,去比 `ENGINE_DOWNLOADS` 固定的那个;记录缺失或不一致就拒绝安装并删掉暂存目录,所以元数据指向别的压缩包时装不进来。壳再核对引擎的版本、它的 `prebuilds.json`,以及这份清单点名的可执行文件(必须是文件,Windows 以外还要有执行位),删掉这次运行自己的包仓库,让引擎在盘上只有一份,再把暂存目录改名到位。改名不跨卷,所以版本目录要么不存在,要么装着完整的引擎;被实时扫描占着的改名(`EPERM`、`EBUSY`、`EACCES`)每隔 500 毫秒重试,共九次,约 4.5 秒。进度来自 pnpm 的 `pnpm:fetching-progress` 记录。一次下载最多跑 30 分钟。

**这条本机服务是渲染服务、更新服务之外的第三个监听**,打开与传递的方式一样,token 是它自己的:`DSH_DESKTOP_OFFICE_ENGINE_ENDPOINT` 与 `DSH_DESKTOP_OFFICE_ENGINE_TOKEN` 只进服务端那一个子进程的环境。没有哪条路由读请求体。

| 路由 | 回答 |
|---|---|
| `GET /state` | `200 application/json` —— 下面那份快照 |
| `POST /install` | `202 application/json` —— 快照,此时是 `confirming`。一个挂在主窗口上的原生确认框弹出来,只有点了它的 **下载** 才开始下载;默认按钮是 **取消**,按 Esc 也是取消。`409` 的 `code` 是 `unsupported`、`installed`、`confirming`、`installing` 或 `declined-recently`——用户取消后 30 秒内(`DECLINE_COOLDOWN_MS`)直接这样答,不再弹框 |
| `POST /cancel` | `202 application/json` —— 快照;pnpm 被停下,暂存目录被删掉。没有下载在跑时答 `409`,`code` 为 `not-running` |
| 其它任何路径或方法 | `404`,在看 token 之前就判定 |
| 缺少或写错 token | `401` |

`409` 的响应体是 `application/json` 的 `{ code, message }`:调用方按 `code` 分支,`message` 是给日志看的一句话。快照总带 `phase`,`version`、`downloadBytes`、`transferredBytes`、`totalBytes` 与 `reason` 在适用时才带。`phase` 是 `unsupported`(kit 没给这台主机构建原生引擎、一个都没声明,或声明的版本还没登记;`reason` 说是哪种)、`absent`、`confirming`、`installing`、`installed`(每次请求都从盘上读;可执行文件没了或不可执行的引擎读作 `absent`)或 `failed`(`reason` 是壳自己的话;可以再要一次下载)。取消的下载读作 `absent`。调用方什么都不指定:包和版本都是 kit 的,所以任何请求都装不了别的东西,没有确认也什么都装不了。退出会中止正在跑的下载,它留下的暂存目录由下一次启动删掉。

## 数据位置服务

**搬数据的入口在设置窗口，搬本身由壳来做**，中间是第四个本机监听，打开和传递的方式与更新服务相同：`DSH_DESKTOP_DATA_ENDPOINT` 与 `DSH_DESKTOP_DATA_TOKEN` 只进服务端子进程的环境，token 是它自己的（`src/data-location-service.ts`）。两个都读不到的 harness 不显示搬迁入口。回答只带种类和路径，不带句子，由设置窗口组织文字。

| 路由 | 回答 |
|---|---|
| `GET /state` | `200` —— 正在用的数据目录、盘上是否记着一次搬迁、搬完后的旧数据此刻是否正在删（`cleanupRunning`）或在等下次启动、`/retry-cleanup` 再删（`cleanupWaiting`）——两者只在日志处于清理阶段时可能为真，其他阶段（包括已请求、尚未开始的搬迁）都为 false、上一次搬迁的结果（`lastResult`，搬迁失败的原因在 `failure` 里；回滚没能把终端设置改回去时，`terminalNotRestored` 写着终端可能还在用的新位置）、上一次已接受的搬迁请求为什么又被撤回、写终端设置的结果（`terminal`：这次启动自己写过时是这次的结果；否则在检查某次搬迁的切换或接着做它的清理的启动上，以及那次搬迁在检查没通过、但用户选择保留的新位置上完成后的第一次启动上，是那次搬迁写入的结果），以及——搬完后删旧数据连续三次都有删不掉的文件时——`cleanup: { leftoverBytes }` |
| `POST /choose` | `200` —— 应用窗口上原生文件夹选择框选中的 `{ "path": … }`，取消时是 `{}`；已经有一个选择框开着时回 `409` —— `{ "reason": "choosing" }` |
| `POST /preflight` | `200` —— 对 `{ "target", "workspaces" }` 的检查结论，列出每一条拒绝原因；不写任何东西 |
| `POST /start` | `202` —— 重新检查通过并写好日志后回 `{ "ok": true }`；`409` —— 没有开始的原因，另一个 `/start` 还在检查时是 `{ "kind": "in-progress" }`。回答之后停掉服务端和它启动的所有进程，在搬迁窗口里搬；到那时才出现的拒绝（服务端的进程没能确认停下）由下一次 `/state` 的 `lastRefusal` 报出 |
| `POST /retry-cleanup` | 已完成搬迁的清理重新执行一次时回 `202`；否则回 `409` —— `{ "reason" }`：`none-waiting`（没有等着清理的搬迁）、`running`（已经有一次清理在跑，启动时自己的或之前的重试）、`no-window`（应用窗口没开着） |
| 其它任何路径或方法 | `404`，在看 token 之前判定 |
| 缺少或写错 token | `401` |

请求体超过 256 KB 回 `413`，不是 `{ "target": string, "workspaces": string[] }` 回 `400`。工作区文件夹是数据不能去的地方，它们的个数是健康检查的基准。系统的临时文件夹同样拒绝（`inside-temp`）：进程自己的临时文件夹，macOS 上的 `/tmp`、`/private/tmp`、`/private/var/folders`，Windows 上的 `%TEMP%`、`%TMP%`，都按真实路径比较。

**搬迁失败的原因以种类给出。**`lastResult.failure` 是 `{ "kind", "also"? }`，出现在每个 `failed` 结果上，也出现在这样的 `moved` 结果上：用户选了保留新位置，而新位置没有通过检查。`kind` 是 `source-changed`（数据文件夹已不在原处，或丢了身份标记）、`target-occupied`（新位置上是别的东西，不是这次搬迁的副本）、`copy-mismatch`、`copy-gone`、`no-space`、`no-permission`、`lock-lost`（搬迁丢了锁，用户放弃了它或把它撤回）、在新位置首次启动的失败之一（`not-started`、`unreadable`、`fewer-sessions`、`plugin-quarantined`、`workspaces-differ`），或 `other`；`also` 列出同一次健康检查发现的其余问题。还没有任何失败、用户就选择撤回的搬迁，按挡住搬迁的原因取上面的种类，都不合适时是 `other`。`detail` 仍是给日志看的英文。旧版本写的结果没有 `failure`，这一版不认识的种类读作 `other`。

**每样同时只有一个。**一个 `/start` 还在检查时，第二个回 `in-progress`，所以两个请求不会都通过日志检查、抢同一把锁；拿到锁之后再查一次日志，开始失败时只在锁的内容仍与这次写入的完全一样时才删掉它。已完成搬迁的清理同时只跑一个，启动时自己的清理和重试共用一个位置；文件夹选择框同时也只开一个。

**数据服务的 token，服务端里跑的每个插件都够得着**，和更新服务的 token 一样：服务端进程里的任何代码，包括第三方插件，都能读到 `DSH_DESKTOP_DATA_TOKEN` 并调这些路由。这不会让插件得到它原本没有的东西。它以同一个用户运行，数据目录里的全部内容本来就对它敞开；这些路由只会把这份数据搬到一个壳像检查用户自己所选位置那样检查过的文件夹，除了搬迁自己的清理之外从不删除它，而且每次搬迁都会停掉服务端并显示搬运进度窗口，不可能悄悄发生。调用方能造成的，是一次用户没有要求、目标又通过了全部检查的搬迁。所以审计第三方插件时，要一并看它有没有读 `DSH_DESKTOP_DATA_TOKEN`。

## 数据放在哪里

**Harness 主目录在搬走之前是 `~/.dsh`,搬走之后由一个指针指明。**应用用户数据目录里的 `data-location.json` 记下数据目录、它的身份,以及应用上一次看到的 `DSH_HOME` 值;数据目录里的 `.dsh-data-id` 存着同一个身份,两边一致才认定这个目录就是数据。`src/data-location-boot.ts` 在启动页上、任何启动步骤读主目录之前把它定下来,并以 `DSH_HOME` 导出,服务端子进程继承这个值。没有指针时什么都不变:应用自身环境里有 `DSH_HOME` 就用它,否则用 `~/.dsh`,唯一的写入是给主目录补一个身份标记;全新安装时,主目录由同一次启动稍后的配置播种创建,标记在那之后补上,所以第一次启动就能发起搬迁。数据的搬迁见下文；开始搬迁的设置页入口不在这个版本里。数据搬迁留下的文件夹一律不当主目录用，不管是指针、`DSH_HOME`、`~/.dsh` 还是用户选的文件夹指向它：带 `.dsh-move-state` 或 `.dsh-data-retired` 的文件夹，以及用户数据目录下 `data-move/abandoned-copies.json` 里记下的文件夹（按真实路径比较，macOS 和 Windows 上不分大小写），或带着同一份数据的身份、`.dsh-data-generation` 里的编号比正在用的数据小的文件夹——每次搬迁都给切换过去的文件夹编一个更大的号，每次回滚反过来，并把这个号写进它放回的指针，所以一块盘换了名字接回来，留在上面的副本仍会被拒绝。只因编号被拒的文件夹，提示说它可能是你数据的一份旧副本，而不说它是搬运时留下的。被拒页面对只因记录或编号被拒的文件夹提供「这就是我要用的数据，改用它」（只因编号被拒时，确认框会提醒：更新的那一份以后不再使用，它里面最近的对话会看不到，但不会被删除）：确认后给它编一个比所有副本都大的号，并删掉它的记录。这份记录读不出来时，启动页给出它的路径，提供「在访达中显示」（Windows 上是「在资源管理器中显示」）、「移开这个文件并继续」和「退出」，不会自行启动；移开要先确认，确认后把它改名为同一目录下的 `abandoned-copies.corrupt-<时间>.json` 再继续，此后留下的副本只能靠编号认出，大多数仍会被拒绝，但不保证全部。

**数据搬迁在自己的窗口里、在 worker 线程上进行，结束时重启应用。**用户数据目录下的 `data-move/journal.json` 记着一次搬迁；每次启动都在确定数据位置之前先读它（`src/move-boot.ts`），阶段不是「已切换」或「清理」时服务端不启动：搬迁窗口（`src/move-window.ts`，与启动页一样是静态页面）接着搬，结束后重启应用，重启前把 `DSH_HOME` 和壳自己的导出标记都设成搬迁的去向——切换之后是新位置，取消或回滚之后是原位置——因为 `app.relaunch()` 会把当前进程的环境传下去。已经发起、还没开始复制的搬迁在启动时撤回而不是接着搬，因为崩溃前服务端启动的进程可能还在写这份数据；之后服务端照常启动，并提示这次搬迁没有开始。整个执行器（复制、校验、改名、标记、删除）都在 worker 线程上跑（`src/move/executor.ts`），只有终端同步与还原在主进程执行。终端同步把结果连同这次搬迁的标识记在用户数据目录下的 `terminal-sync.json` 里。确定的数据位置正是记录里那个位置的启动，把它作为 `/state` 的 `terminal` 报出：检查这次搬迁的切换或接着做它的清理的启动报出后留着记录；盘上没有搬迁、而这次搬迁在一个检查没通过但用户选择保留的新位置上完成时，报出后删掉记录，因为做检查的那次启动显示完说明页就退出了。确定数据位置时自己写过终端的启动改报自己的结果，它和其他启动都把记录删掉、不报。两分钟里没有任何文件操作就算卡住，放弃这次运行，日志留给下次启动。搬迁因出错停下时，退出前有一页说明是磁盘满了、修改被拒绝还是别的错误，以及接下来怎么做；错误的英文原文只写进 `dsh-server.log`。窗口里的按钮是窗口拦下、从不加载的 `dsh-move://` 链接：副本还不完整时有「取消搬运」（关窗或退出也一样）；搬运停在一半时只给当前可选的选项，在过期页面上点的选项会让页面重画。切换之后服务端在新位置启动，界面显示之前先做健康检查（会话目录不少于搬迁前、没有新被隔离的插件）；检查不通过、服务端在那里起不来（到打出 URL 行为止；播种和设置迁移自己记下失败后继续，所以只有服务端随后起不来时才算）、会话目录读不出来，都会停掉服务端和它启动的、还找得到的进程，记下失败（回滚等它们停下之后才取新位置的指纹），在搬迁窗口里回滚，下次启动就回到原位置。搬运停在一半时选择了保留新位置的，这样的失败不回滚：搬迁在新位置上完成，原来的数据在另一块磁盘上时，改名为原位置旁边一个看得见的文件夹保留下来，应用退出前有一页用平常的话说明哪里没通过、写明这个文件夹；下次启动仍从新位置开始。检查通过后，界面显示出来再在后台删掉旧的那份。回滚按开始时记下的快照还原终端设置（`src/terminal-restore.ts`）：块外没人改过的 shell 配置文件整份写回，改过就只还原那一块，搬迁时新建的配置文件连同备份一起删掉，Windows 用户变量按原来的注册表类型写回。改回失败时，回滚不等它照样完成：指针随后指向原位置，并把新位置记为已经见过的 `DSH_HOME`，所以之后继承这个设置的启动（Windows 上是从开始菜单启动的应用继承的用户变量，macOS 上是登录 shell 读到的值）仍留在原位置；结果在 `terminalNotRestored` 里写明新位置：不经应用、直接在终端里启动的 DSH 可能还在用它。数据目录里的 `.dsh-move.lock` 记着正在搬这份数据的安装、它的进程和进程启动时间，以及每 30 秒刷新一次的心跳；只要这个文件在，共用同一份数据的另一个安装就不在这份数据上启动，不管那个进程还在跑还是已经停在半路（本机上找不到的进程——比如另一台电脑通过共享盘在搬——要等心跳过了两分钟才算已停下，所以本机上已停下的进程也可能要两分钟后才显示为已停下），页面会请用户先打开正在搬这份数据的那个安装。那个进程已经停下时，页面还会显示锁文件，并提供放弃那个安装的搬迁：确认之后只删掉锁文件，而且只在它仍是页面显示的那个锁时才删；数据一点不动，应用随后重新启动。搬迁在发起之后的每一步之前都核对原数据里的锁仍是自己的（本安装的、由当前进程或日志记录的进程写下）；锁不见了或换了主人，搬迁就停在原处，不藏起也不删除任何东西。页面会说明是锁读不出、锁不见了或归了别的安装，还是被这个安装的另一个窗口拿着，并提供重试；原数据还没动过时另外提供放弃这次搬迁：只删掉新位置上的那一份，然后照常打开原来位置的数据；开始藏起原数据之后另外提供撤回这次搬迁，也就是走一遍回滚。本安装先前运行留下的锁（包括一次中途被关掉的重启留下的）都算这次搬迁的，除非写下它的进程还在运行。撤销搬迁（取消、放弃、回滚）不做这项核对，因为它只删除这次搬迁自己的副本或把原数据放回原处；健康检查通过时交还新位置上的锁。设置页发起的搬迁接手数据之前，服务端和它启动的所有进程（在服务端运行时找出，之后按进程号和启动时间核对）都必须已经停下；否则在复制任何东西之前撤回这次搬迁，并重新启动服务端，原来的端口空闲时仍用它。Office 引擎服务在停服务端之前先关掉，正在进行的引擎下载随之停止。日志读不出来时应用不启动，页面给出文件位置。

**数据目录不见了就停下启动,绝不回退到 `~/.dsh`。**指针指的目录打不开,或者身份对不上时,启动窗口会问:重试 再检查一次,选择数据所在的文件夹… 只接受标记与指针一致的文件夹,退出 就退出。指针读不出来时问文件夹,接受任何带标记的文件夹;它的 `data-location.json.bak` 副本读得出来时,提示还会用 使用这个位置 提出副本里的位置,因为它可能指着上次改动之前数据所在的地方,且只有那个文件夹带着副本记下的身份才接受。这样选中的文件夹也会写进终端的 `DSH_HOME`,见下文。这些提示按 `app.getLocale()` 在中英之间选择。

**更新的 `DSH_HOME` 覆盖指针。**有指针时,每次启动都读一次 `DSH_HOME`:从终端启动的应用读自身环境,否则 macOS 问登录 shell(`$SHELL -ilc`,最多五秒,只取这一个变量),Windows 读用户环境变量(`HKCU\Environment`,经 PowerShell)。与上次看到的值不同,就是在应用之外改过:文件夹带标记或本身是 Harness 主目录时,指针跟过去;否则启动窗口会问是用这个新位置(从空白开始)还是保持原位置。文件、指向不存在位置的链接,或标记读不出来的文件夹,做不成数据文件夹,这时只给保持原位置与退出;选了新位置却建不起来(磁盘没接上,或者你在那里没有写权限)时,会用同样的两个选项再问一次。两种回答都会记下,同一个值不会再问,保持原位置会把当前位置写回终端;读不到的值什么都不改。值为 `~/.dsh` 时,指的是这个链接指向的文件夹。`src/terminal-env.ts` 负责反方向的写入:Windows 写用户环境变量,改动会广播给正在运行的程序;macOS 在 `~/.zshrc`(或 `$ZDOTDIR/.zshrc`)里,bash 则在 `~/.bash_profile`、`~/.bash_login`、`~/.profile` 中第一个存在的文件里(跟随链接判断,也就是登录 bash 唯一会读的那个文件;目标不存在的链接像 bash 一样跳过,三个都不存在而其中有这样的链接时什么都不写,因为新建的文件会顶替磁盘没接上的那个;悬空的 `~/.zshrc` 同样处理),维护 `# >>> DSH data location >>>` 与 `# <<< DSH data location <<<` 之间的一段。先逐字节备份到 `<文件>.dsh-backup`,再原子写入,块外的每个字节原样不变;这一段的行尾一律是 LF,CRLF 的文件里也一样,所以 shell 读到的值不带回车符;应用追加的这一段仍是文件最后一段时,删掉它后文件逐字节恢复原样。写完后应用会再问一次终端,记下它报出的值,所以仍压过这一段的值会在日志里记为未同步,而不会在下次启动被当成改动。你自己在这段之外写的赋值永远不改,而且会让这次写入作罢,日志记下它的文件与行号;fish 与其他 shell 不写。不用 `launchctl setenv`,因为它的值会比这段配置活得久,直到下次重启。

**`~/.dsh` 变成指向数据目录的链接,终端里的 `dsh` 于是看到同一份数据。**指针指向别处时,每次启动都会在 `~/.dsh` 不存在或是指向别处的链接时,把它做成指向数据目录的符号链接(Windows 上是目录联接);旧链接只删链接本身,从不跟随。那里的链接即使是你自己建的也会被改指向。`~/.dsh` 是真实目录或文件时原样保留并记进日志,因为替换它就等于删掉它。数据在没接上的磁盘上时,链接悬空,终端里的 `dsh` 在主目录下第一次写入时以 `ENOENT` 失败,什么都不创建。

## 服务器环境

服务器在用户主目录启动,环境为 GUI 继承环境加标准 shell PATH 条目(macOS GUI 应用以 launchd 的极简 PATH 启动)。`DEEPSEEK_API_KEY` 走常规凭据链(环境变量 → 托管存储 → `.env`),首启无 key 也能进 UI,在模型设置页补录。服务器输出追加到应用日志目录的 `dsh-server.log`,由 **帮助 → 查看日志** 打开;启动页只报告启动阶段,不再显示路径。主进程的异常与未处理拒绝也追加到同一个文件:`src/crash-log.ts` 在该文件打开后、更新器与服务器启动前就注册好处理器,而异常仍会弹框——是 `Error` 时,标题与正文与 Electron 拼出的完全一致;不是 `Error` 时按 `String(value)` 渲染,而 Electron 会打印 `undefined: undefined`。启动链跑在 `whenReady` 里,因此它自己的失败是以拒绝而不是异常的形式到来,同样被捕获并以同样的方式上报、同样弹框;在日志文件打开之前,这条上报记录写到 stderr。启动过程没有任何一处是沉默的,崩溃在屏幕上的样子也没有任何变化。

**打包后的启动会把安装目录告诉服务器。**`src/install-dir.ts` 把 `DSH_DESKTOP_INSTALL_DIR` 加进服务器子进程的环境,别处都不加:macOS 上是 `.app` 包,即 `process.resourcesPath`(`Contents/Resources`)往上两级;Windows 和 Linux 上是 `resources/` 所在的目录。它是为权限网关设的:内置的 0.6.0 把这个目录列进审查提示里应用自己的那几个目录:凡是网关审查调用的地方,审查模型被告知,认出一次调用要写入、移动或删除其中的内容时,把它转成问你。这是给审查模型的指令,不是网关强制的检查,完全权限下什么都不审。开发启动没有安装目录,什么都不设,绝不设成空值。`dsh-server.log` 用一行 `install dir:` 记下这个值。桌面组合层在模型的系统提示词里点名同一个目录。

**每次启动都把壳自己的目录告诉服务器。**`src/app-dirs.ts` 把三个变量加进服务器子进程的环境,别处都不加:`DSH_DESKTOP_USER_DATA_DIR`,即 Electron 的 `userData`(偏好设置、cookie、登录分区、`desktop-state.json`);`DSH_DESKTOP_LOG_DIR`,即 `dsh-server.log` 与崩溃报告写入的目录,macOS 上是 `~/Library/Logs/@deepseek-ai/dsh-desktop`,在 `userData` 之外;`DSH_DESKTOP_UPDATE_CACHE_DIR`,即 `updaterCacheDir()` 给出的 electron-updater 下载缓存,位于 `~/Library/Caches`、`%LOCALAPPDATA%` 或 `~/.cache` 之下。路径为空时不设变量。`dsh-server.log` 为每个变量记一行,行名就是变量名。桌面组合层(`@deepseek-ai/dsh-desktop-app`)在模型的系统提示词里把它们列为不要修改、移动或删除的目录,权限网关的审查提示把它们与安装目录列在一起;`tests/app-dirs.spec.ts` 钉住这些变量以及带上它们的服务器启动。

**服务器死掉时留下它最后写的几行,致命错误时还留下一份报告。**壳在服务器那个 Node 进程自己的命令行上加 `--report-on-fatalerror --report-uncaught-exception --report-directory=<日志目录> --report-exclude-env --report-exclude-network`,所以 V8 致命错误——首先是内存耗尽——会在 `dsh-server.log` 旁边写一份 `report.<日期>.<时间>.<pid>.<序号>.json`,不含环境变量(提供方的 key 就在那里),也不含网络接口。这些参数只属于这一个进程,不放进 `NODE_OPTIONS`,因为 agent 运行的每个 Node 程序都会继承它。异常只有在 CLI 装上自己的处理器之前才会产生报告;之后,处理器写进 `dsh-server.log` 的那行 stderr 就是记录。绕过 V8 的原生崩溃(例如 Windows 的退出码 `0xC0000409`)不写报告。`server exited unexpectedly` 这一行等死掉的服务器的两条输出管道都关闭后才写;若它启动的某个进程还占着管道,则在退出后 2 秒写,所以尾部带着服务器最后写的内容。在打出 URL 行之前就退出的启动按同样的条件上报,所以「内置插件」一节里的隔离扫描读到的是完整输出。

**加载不出服务出来的 UI 的窗口会说出来,屏幕上和日志里都有。**每个应用窗口都为自己的页面往 `dsh-server.log` 写行:`did-finish-load` 时写 `window loaded <源与路径>`——若主框架自上次开始导航以来失败过,则写 `window showed the error page for <源与路径>`,因为 Chromium 那时会提交一张错误页并同样报加载完成——`did-fail-load` 时写 `window load failed: <错误码> <描述> (<源与路径>, main frame|subframe)`,`render-process-gone`(带原因与退出码)、`unresponsive`、`responsive` 各写一行。URL 只记源与路径,因为服务出来的 UI 的 URL 带着启动令牌。服务出来的 UI 的每一次加载——第一次、重开窗口的那次、服务器换绑后的重新指向——都经过 `src/window-load.ts`:对该 UI 所在源的主框架加载失败时,1 秒后用同一个 URL 重试一次;再失败就重新加载启动页,把最后一个阶段「连接界面」标为失败,下面写 `界面没有加载出来:<描述> (<错误码>)`。只有新的一次加载——壳交给窗口的下一个 URL——才恢复重试机会;加载完成不算,因为 Chromium 对失败的加载也会报加载完成,针对的是它在同一 URL 下提交的错误页。`ERR_ABORTED`(-3)是被另一次导航替换掉的加载,只记日志、不重试。`did-fail-load` 只报网络层的失败——连接被拒或被重置、DNS、证书——HTTP 错误状态码会作为页面加载完成,所以那种情况只表现为一行 `window loaded`,之后再没有别的行。

**服务器监听上一次启动时服务器用的端口,所以服务出来的 UI 保持同一个源。**web 客户端存在浏览器里的一切都属于源 `http://127.0.0.1:<端口>`:自定义快捷键(localStorage 里的 `dsh.keybindings.v1`)、对话区宽度、右侧栏布局,以及登录 cookie。壳把正在运行的服务器的端口记为 `desktop-state.json` 里的 `serverPort`(`src/desktop-state.ts` 的 `setServerPort`),下一次启动在清理遗留服务器之后、渲染服务、更新服务、数据位置服务与 Office 引擎服务绑定各自端口之后,经 `src/server-port.ts` 把它作为 `--port` 传入。只有在 `127.0.0.1`、`0.0.0.0` 和 `::` 上都能监听成功,端口才算空闲(机器没有的地址族跳过),因为在 macOS 上,通配地址上的监听不妨碍在 `127.0.0.1` 上监听。记住的端口不空闲,或在服务器绑定之前被别的进程抢走(服务器这时以 `listen EADDRINUSE` 退出),就退回 `--port 0`:那一次启动从一个新的空源开始,和以前每次启动一样,它的端口留给下一次。壳不把浏览器存储复制到新源,因为 Electron 没有在主进程里把一个源的 localStorage 复制到另一个源的 API。服务器意外退出时会忘掉记住的端口,崩溃换绑用系统挑的端口并改记它;原因见下一段。状态文件的写入先把临时文件刷到磁盘再改名覆盖旧文件,文件被别的进程占着时(Windows 上的杀毒软件与索引服务会这样)短暂重试,仍失败就记日志。`dsh-server.log` 用一行 `server port:` 记下这次选择([Agent Note](../../.agents/notes/implemented/feature/2026-09-27-desktop-shell-stable-origin.zh.md))。

**壳在每次启动的服务器起来之前、服务器意外退出时、以及应用退出时,删掉自己的浏览器会话 cookie。**服务出来的 UI 每登录一个服务器就留一条持久 cookie `dsh-auth-<主机加端口的哈希>`,换到新端口的启动或崩溃换绑都会多出一条新名字的;浏览器按主机而不按端口发送 cookie,于是它们全部随每个发往 `127.0.0.1` 的请求一起发出。大约六十条之后,请求头超过 Node 的 16 KB 上限,服务器对插件包请求回 431,窗口报 `Failed to load plugins`。这条 cookie 也不绑定签发它的进程:它用 Harness home 保存的密钥签名,写明主机与端口,所以在过期之前,对同一端口上后来的服务器一直有效,而下一次启动请求的正是这个端口。本机进程要拿到一份副本,只能在服务器已经没了、窗口还在往那个端口发请求时去监听它;只要窗口开着,web 客户端就会一直重连。所以 `src/server-lifecycle.ts` 规定了步骤顺序:服务器意外退出时先忘掉记住的端口、删掉 cookie,然后才进入恢复阶梯,于是换绑、整个应用重启和停止对话框都从「没有记住的死端口、没有可发的 cookie」开始;崩溃换绑用系统挑的端口;退出时先删 cookie 再停服务器,删除最多等 500 ms,停止信号无论如何都会发出;退出一旦开始,把应用带到前台(Dock、托盘、通知、第二次启动)什么也不做,所以不会给一个即将消失的服务器签发新 cookie。删除之前被拿走的副本不会因删除而失效。`src/auth-cookies.ts` 删掉 `127.0.0.1` 上全部 `dsh-auth-*` cookie,每条按它自己的路径删;主机上别的 cookie 保留。删除失败只往 `dsh-server.log` 写一行,启动、恢复或退出照常继续。

**壳主动停掉服务器时,会给崩溃续跑插件留一个哨兵文件。**服务端插件 `@haoran/dsh-crash-resume` 会续跑被服务器崩溃打断的 turn,而被停止请求打断的 turn 则挂起;光看会话日志分不出这两种情况。所以壳在为退出、为安装更新、为搬数据、或因强制更新拦住启动而停服之前(只有最后这种 `reason` 是 `update`),由 `src/crash-resume-sentinel.ts` 写 `<Harness home>/crash-resume/intentional-stop.json`,内容是一行 `{"version":1,"at":<毫秒时间戳>,"by":"shell","reason":"quit"|"update"|"shutdown"}`;系统宣布关机、重启或注销时也写(`shutdown`;`src/session-end.ts` 在 Windows 上听窗口的 `session-end`,那时不会走退出流程,在 macOS 和 Linux 上听 `powerMonitor` 的 `shutdown`);Harness home 按壳自己的 `DSH_HOME` 解析,服务器继承的也是它。写入是同步、原子的——在同一目录写临时文件,fsync 后 rename 覆盖哨兵——所以停服指令发出前文件已经落盘。Windows 上只有壳会写,因为 `taskkill /T /F` 不让服务端代码运行;macOS 上插件收到 SIGTERM 时也写同一个文件,哪个 rename 最后落地,留下的都是一份完整内容。只有服务器子进程还在运行时才写:壳在恢复阶梯和停止对话框期间一直留着已崩溃服务器的句柄,所以崩溃之后的退出、更新安装或关机都不写;意外退出本身、多次崩溃后的整应用重启、启动超时、孤儿清扫,也都不写。写入失败时在 `dsh-server.log` 记一行 `[desktop] crash-resume sentinel:`,退出照常进行;代价是下次启动可能把本该挂起的一个 turn 续跑了。下一个服务器读取后删除这个文件;没装这个插件时文件会留着,只有一行,没有谁读它。更新安装失败后重启的服务器,会读到安装前那次停服留下的哨兵,把那次停服打断的 turn 挂起([Agent Note](../../.agents/notes/implemented/feature/2026-09-27-desktop-shell-crash-resume-sentinel.zh.md))。

**启动页与安装提示窗跟随应用主题。**两套色板都取自 web UI 自己的 token,所以无论哪一种模式,启动页与它交接给的应用都是同两种颜色。外观在窗口存在之前就定下——`backgroundColor` 决定页面加载期间画什么——顺序是:持久的 `ui-theme` 偏好,当它是显式的 `light` 或 `dark` 时优先;否则跟随系统(`nativeTheme.shouldUseDarkColors`),这也正是它默认值 `system` 的含义。这个偏好是 `~/.dsh/profiles/desktop-shell/cordis.patch.yml` 里的 `ui-theme` 条目;还没有这个条目的 profile(从 0.1.0-rc.33 升级后的第一次启动,设置迁移还没跑)改读 `~/.dsh/settings.yaml` 里的 `ui-theme.preference`。**显式设置优先于系统。****帮助 → 关于** 给出版本与更新源地址。菜单栏文案与数据位置的提示按 `app.getLocale()` 在中英之间选择;其余对话框保持中文。

**服务出来的 UI 自己的加载页说应用的语言,并写产品名。**在启动页与第一个渲染出来的视图之间,窗口显示的是 web 客户端在语言加载之前的加载页(`packages/client/web/src/boot-page.ts`),上面的 `HARNESS`、`Loading plugins…` 和 `Failed to load plugins` 固定是英文。`src/app-boot-text.ts` 在应用窗口的每个页面上,于 `did-navigate` 时插入一份样式表、`dom-ready` 时再插一次,把这三段文字画成零字号,在原位置画出 `北冥`、`正在加载插件…` 和 `插件加载失败`,或 `Beiming` 与英文原文。语言取设置里选的那种——桌面 profile 补丁层的 `locale` 行,没有则 `settings.yaml`,读法与主题偏好相同——没有存选择时取 `app.getLocale()`。每次页面加载都重新读取,所以在设置里改了语言,从下一次重新加载或启动起生效。样式表按页面的 `data-dsh-boot`、`data-dsh-boot-spinner` 属性和子元素顺序选择,不依赖生成的类名,在其他页面上什么也匹配不到;`tests/app-boot-text.client.spec.ts` 用 web 客户端自己的 `BootPage` 检验这些选择器,那个页面的结构一变,那里就失败。窗口仍然没有 preload。

## Known Limitations and Deferred Work

- 通知打不开它所说的那个会话:web UI 把选中的会话放在内存里、URL 里什么都不放,壳没有地址可加载。补上这一点需要 web 客户端接受 URL 里的会话;届时壳这边只是 `loadURL` 的一个参数。
- macOS 已签名但未公证,所以由浏览器下载的副本首次运行仍需右键打开。公证需要 Apple 开发者账号;更新路径不需要。
- Windows arm64 与 Linux 桌面目标未构建;node-pty 预编译已覆盖 win32-arm64,缺口只是打包工作。
- 开发启动(`pnpm --filter @deepseek-ai/dsh-desktop-shell exec electron lib/main.js`)用的是检出目录的已构建 CLI 和 PATH 里的 Node,不是暂存资源。它还要求先跑 `pnpm --filter @deepseek-ai/dsh-desktop-app run bundle`,因为 `desktop-brand` 与 `desktop-server-log` 两行导入的是那个包的 `lib/`,而仓库构建不产出它。
- 日志只在启动时轮转:超过 10 MiB 的 `dsh-server.log` 改名为 `dsh-server.log.1`,覆盖上一份;诊断报告只保留最新五份(`src/log-retention.ts`)。一次长时间运行可以让文件在下次启动前超过 10 MiB,而现在服务端的 logger 记录也和服务端输出一起进这个文件。
- 渲染服务按次启动、串行工作。同时受理四个请求、只渲染一个,所以一个把自己的期限用满才加载完的页面会占住这个位置,排在它后面的请求只拿得到自己那份期限剩下的部分——把 `timeoutMs` 提到 120 秒天花板的调用方,花掉的也是排在它后面那些请求的时间。
- 部分截图就是合成器当时画出来的那一帧:一个还在取样式表的页面,得到的是没有样式的文档,而不是画了一半的页面。有没有画出过任何东西(`firstPaint`)、load 事件有没有触发,由报告说出来;像素本身说不出。
- 壳的视口下限是每边 16 px,而 `@haoran/dsh-screenshot` 自己允许到 1。要求更小视口的 `screenshot` 调用在桌面端会被答以 400,在别处则由系统浏览器渲染。
- 只有壳的渲染服务能带上 `headers` 与 `cookies`。插件的另一个后端是一次性的 `--screenshot` 浏览器命令行,没有任何设置它们的办法,所以在没有这个服务的安装上,这样的调用会被拒绝,而不是以未登录状态渲染出来。
- 同一时刻只开一扇登录窗口。第二个 `POST /login` 会被答以 503 而不是排队,需要登两次的调用方只能一次一次来。
- 登录 partition 不会被壳过期或回收。用户登录留下的东西一直躺在磁盘上,直到有谁对那个 partition 调用 `DELETE /login-sessions`。
- 内置插件无法从 profile 侧钉到另一个版本。用 `dsh plugin --profile desktop-shell add` 安装同名包会在 profile 自己的 `node_modules` 里放一份,Loader 会先找到它,而 `resolveBundleDir` 仍从安装目录读取 patch 层——那样这一行来自一个版本、代码来自另一个版本。
- 上游的插件页没有逐包更新的操作,也没有撤回。经 `web` profile 来的插件用 `dsh plugin --profile web add <包>@latest` 更新,借同步维护的那条链接到达桌面。
- 壳停用或打了墓碑的迁移插件,只在 `dsh-server.log` 里被点名一次,界面上哪里都没有。
- 只有网关组合出来的 `config` 里带着桌面层的 `alwaysAsk` 时,`plugin_manager` 才会交给人。profile 自己的补丁层里 `config` 自带 `alwaysAsk` 的网关行会替换这张表,`src/settings-migration.ts` 对这样的行原样不动。
- 关掉的内置插件保持关闭,依赖核心补丁 `launcher-shipped-bundles` 让插件页列出内置插件。没有这个补丁的构建不列任何内置插件,而 `plugin_manager` 的 `set_bundle` 带 `enabled: false` 仍能关掉一个,那个内置插件随后一直关着,界面上没有入口能再打开;两者必须一起发。
- 在插件页重新打开的内置插件会追加在组合层之后,所以组合层针对它的那些行要到下一次启动把组合层挪到它之后才生效。
- 某个构建没带某个内置插件时,它会从 `dsh.profile.shipped` 里掉出去;之后重新带上它的构建会把它以打开状态加回来,即使用户之前关掉过它。
- Windows 的语音输入运行时只打了包、核对了在不在。`sherpa-onnx.node` 能不能在 `sherpa-onnx-win-x64` 里找到它的 DLL,要在真实 Windows 机器上录一次音才知道。
- 自带的 pnpm 是构建时钉住的版本,只有仓库自己的 `packageManager` 变了才会跟着变。它给每个平台的载荷增加约 19 MB,其中包含它全部四个平台的原生模块,因为它以单个 tarball 发布。
- 数据位置的提示是盖在启动页上的消息框,因为启动页收不了输入。开始搬迁的设置页由数据位置插件画出,这个版本还没有内置它,所以数据位置服务还没有调用方;在那之前只有启动窗口里的选择和已经记下的搬迁会写 `data-location.json`。
- 搬迁的健康检查数的是磁盘上的会话目录而不是服务端列出的会话,比较被隔离的插件,不回读最近的几个会话;开始时记下的工作区条数不比较,因为检查时没有任何一方报这个数。
- 服务端在已切换搬迁的新位置上起不来时，应用手里没有它的句柄。还在运行的（比如到了 180 秒启动时限）会按自带 Node 可执行文件的路径在应用自己的子进程里找到，连同整棵进程树一起停掉；已经退出的找不到，它启动的进程会在回滚期间继续运行，除非它们跑的是自带的 Node 可执行文件——清理先前运行留下的服务端时会把这些杀掉。
- 搬迁窗口要等服务端和它启动的全部进程都停下才打开,而不是一确认就打开;在那之前应用窗口显示的是正在停掉的网页界面。实测约 0.6 秒,服务端停得慢时会更久:停止在 macOS 上最多等 10 秒、Windows 上 4 秒,之后最多再有三轮间隔半秒的强杀。
- 搬迁要两分钟里一次文件操作都没有才算卡住;取新位置指纹时走一整棵很大的目录树只算一次操作。
- 因服务端的进程无法确认已停下而撤回搬迁时,重新启动的服务端仍指向搬迁关掉的 Office 引擎服务,所以下一次启动之前无法下载引擎。
- 数据搬迁还没在 Windows 真机上跑过,所以它在那里停掉服务端进程树的做法(经系统自带 `powershell.exe` 列进程、经它的 `taskkill.exe` 结束进程)还没验证。
- 在 Windows 上，服务端的进程树经 `taskkill.exe` 停掉。它启动不了、Node 以 error 事件报出时，只会结束服务端本身，它启动的进程继续运行；Node 以抛错报出时，什么都不会结束，到 180 秒启动时限时这只记进日志。下次启动清理先前运行留下的服务端时，能找到其中跑自带 Node 可执行文件的那些，但也是经 `taskkill.exe` 结束它们，所以它仍启动不了时，这些进程会继续运行。
- 位置改变之前就导出了 `DSH_HOME` 的终端会一直带着旧值,直到重新打开;从这样的终端启动的应用会把这个值当成更新的值。
- 这一段之后又加了内容、不再是文件最后一段时,删除只删它本身,不保证文件逐字节恢复原样。
- 在 rename 之前崩溃,会在配置文件旁(`<文件>.<pid>.tmp`)或指针旁(`<文件>.<pid>.<8 位十六进制>.tmp`)留下临时文件,之后没有任何步骤会删掉它。
- `<文件>.dsh-backup` 与 `data-location.json.bak` 每次写入都会被覆盖,只保留上一次写入之前的那一版。
- 写配置文件时只有应用自身环境里有 `$ZDOTDIR` 才认它;从访达打开的应用看不到 `~/.zshenv` 里设的值,会写 `~/.zshrc`。这种情况,以及在 `~/.zlogin` 这类 shell 之后才读的文件里赋值的 `DSH_HOME`,会让终端继续用它们自己的值;应用在 `dsh-server.log` 里把它们报为未同步,也不会跟回那个值。
- 有指针时,你自己在 `~/.dsh` 建的链接会被改指向数据文件夹;它原来指向的文件夹原样不动。
- 拒绝启动本应用的终端导出的 `DSH_HOME` 后,一旦配置文件写入得到确认,记下的是新开的终端看到的值,所以之后再从同一个终端启动还会就它的值再问一次。
- `~/.dsh` 悬空时,终端里的 `dsh` 报出的是一段原始的 `ENOENT` 调用栈,而不是一句说明磁盘没接上的话。
- 渲染进程崩溃或无响应只记日志,别的什么都不做:窗口不重新加载,因为内存耗尽的渲染进程重新加载只会重演同一次加载。
- 自定义快捷键只接受浏览器那一套组合,其余一律以「此浏览器暂不支持该组合」拒绝,因为服务出来的 UI 运行在 web 客户端的 `web` 快捷键运行时里。`desktop` 运行时需要文档上的 `data-platform`,加上 `dshDesktop` 桥和原生按键拦截;而 `dshDesktop` 同时也是关掉模型页首启凭据引导与欢迎须知、打开账号插件的那个标记;[Agent Note](../../.agents/notes/implemented/feature/2026-09-27-desktop-shell-stable-origin.zh.md)的「快捷键组合」一节记下了设计以及为什么没有采用。
- 读屏软件可能把服务出来的 UI 的加载页读两遍:被替换的英文仍在文档里,只是画成零字号,而替换文字是 `::after` 内容,无障碍树同样会暴露它。样式表设不了 `aria-hidden`,而那个页面属于 `packages/client/web`。
- 在 macOS 的 App Translocation 下——带隔离标记的副本直接从「下载」里第一次启动时——`DSH_DESKTOP_INSTALL_DIR` 给出的是 macOS 实际运行应用的那个临时转移路径,而不是用户看到的那个 `.app`;第一次启动前先把应用移到「应用程序」里就不会这样。
- `@haoran/dsh-office-preview-notice` 没加载时——被移除、被停用或加载失败——服务端启动的进程会继承引擎的 `NODE_PATH` 一项。
- Windows 上的下载还没在真机上跑过:Defender 扫描解压后的引擎、kit 0.1.5 对应的 `win32-x64` 引擎能否转换、hoisted 布局下的路径长度,都没验证。
