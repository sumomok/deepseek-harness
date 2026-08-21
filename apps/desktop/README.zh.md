# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

桌面客户端:Electron 壳,主进程启动内嵌的 `dsh web` 服务器——即 [apps/desktop-server](../desktop-server/README.zh.md) 经 pnpm deploy 物化的闭包,跑在随包捆绑的真实 Node 运行时上(绝不用 Electron 内建 Node,服务端因此保持在被测试的 engines 线上,`node:sqlite` 与原装 N-API 预编译产物照常工作)——传入 `--no-open` 使服务端不把地址交给系统浏览器,等到 `dsh web:` URL 行后在原生窗口里打开所服务的 UI。窗口是纯浏览器面:无 preload、无 Node 集成;外部链接交给系统浏览器。退出时拆除整棵服务器进程树(SIGTERM + 超时升级;Windows 走 `taskkill /T`)。

## 构建安装包

```sh
pnpm exec tsx apps/desktop/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

产物落在 `apps/desktop/dist-app/`。流水线按 python/sdk-runtime 配方暂存服务端(legacy hoisted `pnpm deploy`、恢复 hoist、物化符号链接),删掉本机编译的原生 `build/` 树以强制走多平台预编译产物,补齐 macOS 安装时跳过的平台分包可选依赖的 win32-x64 成员,再按平台暂存 Node 运行时(`--skip-repo-build` / `--skip-deploy` 复用既有产物)。每份载荷冒烟测试之前先过一道载荷门禁:每条平台规则至少丢弃一个目录,每个平台分包目录都要对得上它所在的 target,活下来的模块不得按名解析已被裁掉的包。

## 关掉窗口,以及被叫回来

**Windows 上关闭按钮会问一次它该是什么意思**:「最小化到托盘」还是「退出应用」,配一个「记住我的选择」。不勾,答案只管这一次;勾上,答案作为 `closeAction` 写进 `desktop-state.json`,此后每次关闭都照办、不再问,直到托盘菜单的「关闭时询问」把它清掉。最小化按钮原样不动——它仍然是普通的任务栏最小化。托盘图标从启动起就在,于是「最小化到托盘」指的是屏幕上已有的东西,窗口隐藏期间 **检查更新** / **退出** 也仍然够得着;菜单是 打开 / 检查更新 / 关闭时询问 / 退出,和菜单栏一样本地化。每一次退出——托盘的、记住的、更新触发的——都走同一条停服务器的 `before-quit` 拆除链;更新对话框会先把窗口显示出来再挂上去,因为挂在隐藏窗口上的窗口模态对话框既看不见也找不到。macOS 保留自己的习惯:关窗把应用留在 Dock 里,`activate` 重开窗口,所以没有菜单栏图标。

**客户端会说哪个会话在等你。**够格的时刻有两个——会话跑完了,以及会话在等批准或等回答——窗口有焦点时两者都不打扰。两者都从壳自己启动的那个服务器上读,走 `/api/events.host` 与 `/api/events.mux`,也就是浏览器 UI 在消费的那两条下行 WebSocket;为此上游没有新增任何东西,而这两条流在重开时会重放仍然挂着的请求,所以每个请求只报一次。Windows 弹系统 toast,点击把窗口抬起来。macOS 显示 Dock 角标并弹跳一次,不往通知中心投任何东西——十来个跑完的 turn 会变成十来条要一一划掉的横幅,而角标只说有几条,并在窗口获得焦点时清零。

**通知打开的是应用,不是会话。**Web UI 没有 URL 路由,壳无处可导航;是侧边栏自己的待交互与已完成标记指认出那个发问的会话。

## 更新机制

已安装的客户端读一个静态更新源——一个 electron-builder `generic` provider 目录,里面是清单与它们点名的产物:

```
https://lhr.ink/dsh-updates/win/     latest.yml  + the NSIS installer + its blockmap
https://lhr.ink/dsh-updates/mac/     latest-mac.yml + the zipped app
```

这里没有更新服务:清单**本身**就是判断过程,所以 nginx 发一个目录已经把它整个实现了。更新源地址存在于两处——生成清单与打包内 `app-update.yml` 的 `electron-builder.yml`,以及运行时读取它们的 `src/updater.ts`——迁移更新源要同时改这两处。`channel: latest` 在两端都显式写出;默认行为会拿运行版本的预发布段给渠道命名,那会让渠道名随发布周期的每个阶段改名。

**Windows 原地安装,分三步。**静默检查(启动后 15 秒、此后每四小时,以及 **帮助 → 检查更新**)先征询下载。同意后在后台下载,配一个可以随手关掉、关掉也不会中断下载的小进度窗。下载完成后再征询重启安装。**没有用户的决定就不会发生安装**,退出时或别的任何时候都一样:`autoInstallOnAppQuit` 关闭,应用只在有人点了「重启安装」之后的几秒里替换自己。被拒绝的安装留在盘上,只会在下次启动与菜单手动检查时再被提起——别处没有。在 Windows 上这些对话框全部挂在应用自己的窗口上,因为没有 parent 的对话框可以被系统排到用户正在用的东西后面,更新提示就这样存在却没人看见;在 macOS 上它们刻意不挂 parent,因为那里带 parent 的对话框是 sheet,任何抬起父窗口的动作——比如点一下 Dock 图标——都会像按下它第一个按钮那样把它结束掉。两边都一样:应用不在前台时会先请求注意,Windows 闪任务栏按钮,macOS 弹一次 Dock 图标。

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

**如果连这条路也停在「无法关闭」**,说明本产品记录的安装目录丢了,把它写回去就足以放行一个旧版安装器:

```
reg add "HKLM\SOFTWARE\e36966b0-1805-5ec4-9648-404e09da7db1" /v InstallLocation /t REG_SZ /d "D:\soft\DSH Desktop" /f /reg:64
```

键名是 electron-builder 由 `appId` 推出的 GUID,也是安装器读取目录的唯一出处——旁边那个 `Uninstall` 项只带 `DisplayName` 与 `UninstallString`,本来就没有 `InstallLocation`,在那儿看到空值并不说明任何问题。这个值缺失的代价不止那句提示:`uninstallOldVersion` 会把从 `UninstallString` 推出的正确目录当作 `_?=` 交给旧卸载器,而旧卸载器自己的 `initMultiUser` 又在卸载段开始前用同一个空键覆盖掉 `$INSTDIR`——于是它什么也没卸,新版本却装进 `%ProgramFiles%\DSH Desktop` 这个兜底目录,应用被悄悄搬了家,旧的那份留在原地。

**macOS 同样原地安装,前提是构建已签名。**Squirrel.Mac 只在替换件满足当前运行应用的 designated requirement 时才暂存更新,这正是发布构建要签名的原因(见下方「信任与签名」一节)。三个阶段、几个对话框、以及「重启安装」的规则都与 Windows 一致;不同的是安装本身。它要十五秒上下,其中大部分时间屏幕是空的——Squirrel 在解压与验签,而 ShipIt 要等本应用的所有进程退出才能开始换包——所以那次点击会立起一个常驻的「正在安装 vX」提示把这件事说清楚,并隐藏主窗口,因为它的服务马上就没了。

**没有**签名的构建保持旧行为:自己比对版本,用系统浏览器打开下载,只在启动时或手动检查时,绝不在会话中途。走哪一条由每次检查现场判断:看 `Contents/_CodeSignature/CodeResources` 在不在——签名会写出它,ad-hoc 链接器签名不会。已签名的构建若在运行期失败,本次运行剩余时间降到同一条下载路径,并留下一行日志,而不是让这次检查以错误框收场。

**下载中断会先重试,再谈放弃。**electron-updater 不保留失败传输的任何部分:全量下载不发 `Range` 头,而任何错误都会删掉半截文件并清空 pending 目录。因此 `src/download-retry.ts` 在失败前面放了三次完整重试——间隔 2 秒、6 秒、18 秒——进度窗不关,并写明正在等待第几次。会重试的是网络:连接被切断或被拒绝、DNS 失败、请求超时、任何 `net::ERR_…`,以及更新源返回的 5xx、408、425、429。不重试的是判定:`ERR_UPDATER_*` 拒绝、签名不符、校验和不匹配、4xx——以及分类器不认识的任何失败,它们默认按致命处理,这样一个不认识的错误不会再赔上三次整包传输。重试用尽后,这次下载只记日志并就地放弃:层级不变,**macOS 不降级**,下一次定时检查从头再传一遍,手动检查会收到一个对话框说明此事。致命失败仍按上面那套层级规则走——macOS 在本次运行剩余时间降到下载页,并在那一层重跑这次检查。重试并不会让更新变成可续传:差量下载需要缓存目录里存在上一版的 `update.zip`,所以全新安装之后的第一次更新,每次尝试都是整包传输。每次重试与结束它的那个结论都写进 `dsh-server.log`。

### 强制更新

清单里带一个本产品自有的字段 `minimumVersion`:低于它的客户端必须更新才能继续使用。

| | Windows | macOS |
|---|---|---|
| **启动时** | 不展示 UI,服务端拆除,下载不经征询直接开始。下载失败时给出重试与退出两条路。 | 阻断对话框给下载或退出;两种选择都不会进入应用。 |
| **会话中** | 立即下载并弹一次对话框告知;下载完成后仍可推迟安装。 | 提示一次;下次启动阻断。 |

连不上的更新源会**放行**而不是关门——网络故障绝不能把人锁在自己的机器外面。这条线在发布时显式设定,此后自行延续,所以忘记加参数不会把它悄悄丢掉。

### 发布

```sh
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt             # ship the built version
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --dry-run   # verify without uploading
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --minimum-version 0.1.0-rc.8
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --republish  # repair a cut-off upload
```

脚本会拒绝与 `package.json` 对不上的 `dist-app`,重新校验安装程序的 NSIS 完整性 CRC,并断言本次构建盖过更新源在提供的版本。上传顺序是**先产物、两端校验、清单最后**,因此发布途中轮询的客户端读到的是旧清单指向旧产物,绝不会读到一份指着还在上传的文件的清单。它还会剔除本次不上传的产物在清单里的条目:macOS 构建会在 zip 旁边列出 dmg,而只有 zip 会发布,留着那条就等于在更新源里放了一个 404。

更新源在主机上的路径是 `/var/www/dsh-updates/{win,mac}`,由追加的单个带 `alias` 的 `location /dsh-updates/` 提供。那台 nginx 使用自定义前缀(`/data/third_party/nginx`),编译时不含 rewrite 模块,且 master 不归 systemd 管——重载请用 `nginx -s reload`,绝不要用 `systemctl`。该目录不套 BasicAuth,因为 electron-updater 不会带凭据。

## 信任与签名

**macOS 构建由本项目自己持有的一张自签名证书签署。**`scripts/sign-mac.cjs` 在 `afterPack` 钩子里直接跑 `codesign`,因为 electron-builder 自己的签名过程用 `security find-identity -v` 过滤身份,未信任的自签名证书永远过不了这道过滤。`codesign` 没有这条规则;它真正要求的是身份所在的钥匙串必须在用户的钥匙串搜索列表里,所以脚本每次构建新建一个钥匙串、加进列表、签名,再在 `finally` 里还原搜索列表。身份默认从 `~/Library/Application Support/dsh-desktop-signing/dsh-desktop-signing.p12` 读取,除非 `DSH_MAC_SIGNING_P12` 与 `DSH_MAC_SIGNING_P12_PASSWORD` 另行指定;缺失时**构建失败**,`DSH_MAC_SIGN=0` 是显式索要未签名构建的方式。更新路径校验的就是这张证书,所以它不能轮换:它的指纹就在每个已安装客户端校验的 designated requirement 里。

它不是 Developer ID 证书,应用也未公证,所以由**浏览器**下载的副本,Gatekeeper 仍要求右键打开(或 `xattr -dr com.apple.quarantine`);由 Squirrel 装上的更新不带隔离属性,两者都不需要。Windows 产物未签名,SmartScreen 会弹未知发布者提示。Windows 包只做了交叉构建与结构校验——交付前务必在真实 Windows 机器上冒烟。

这也框定了更新源能承诺什么。TLS 认证服务器,清单里的 sha512 把产物绑定到清单,所以传输途中无法被做手脚。产物带的是本项目自己做的签名,不是操作系统会背书的那种,所以对 `/var/www/dsh-updates` 的写权限仍然等于对每个客户端下一个安装程序的写权限——macOS 客户端会拒绝由别的证书签出的 bundle,但对「给它的是这张证书签出的哪一个构建」没有意见。补上这一环要靠 Windows 的 Authenticode 与 macOS 的 Developer ID 加公证。

## 服务器环境

服务器在用户主目录启动,环境为 GUI 继承环境加标准 shell PATH 条目(macOS GUI 应用以 launchd 的极简 PATH 启动)。`DEEPSEEK_API_KEY` 走常规凭据链(环境变量 → 托管存储 → `.env`),首启无 key 也能进 UI,在模型设置页补录。服务器输出追加到应用日志目录的 `dsh-server.log`,由 **帮助 → 查看日志** 打开;启动页只报告启动阶段,不再显示路径。

**启动页与下载窗跟随应用主题。**两套色板都取自 web UI 自己的 token,所以无论哪一种模式,启动页与它交接给的应用都是同两种颜色。外观在窗口存在之前就定下——`backgroundColor` 决定页面加载期间画什么——顺序是:`~/.dsh/settings.yaml` 里的持久 `ui-theme.preference`,当它是显式的 `light` 或 `dark` 时优先;否则跟随系统(`nativeTheme.shouldUseDarkColors`),这也正是它默认值 `system` 的含义。**显式设置优先于系统。****帮助 → 关于** 给出版本与更新源地址。菜单栏文案按 `app.getLocale()` 在中英之间选择;对话框保持中文。

## Known Limitations and Deferred Work

- 通知打不开它所说的那个会话:web UI 把选中的会话放在内存里、URL 里什么都不放,壳没有地址可加载。补上这一点需要 web 客户端接受 URL 里的会话;届时壳这边只是 `loadURL` 的一个参数。
- macOS 已签名但未公证,所以由浏览器下载的副本首次运行仍需右键打开。公证需要 Apple 开发者账号;更新路径不需要。
- Windows arm64 与 Linux 桌面目标未构建;node-pty 预编译已覆盖 win32-arm64,缺口只是打包工作。
- 开发启动(`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`)用的是检出目录的已构建 CLI 和 PATH 里的 Node,不是暂存资源。
