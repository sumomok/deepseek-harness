# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

桌面客户端:Electron 壳,主进程启动内嵌的 web 服务器——即 [apps/desktop-server](../desktop-server/README.zh.md) 经 pnpm deploy 物化的闭包,跑在随包捆绑的真实 Node 运行时上(绝不用 Electron 内建 Node,服务端因此保持在被测试的 engines 线上,`node:sqlite` 与原装 N-API 预编译产物照常工作)——传入 `--no-open` 使服务端不把地址交给系统浏览器,等到 `dsh web:` URL 行后在原生窗口里打开所服务的 UI。窗口是纯浏览器面:无 preload、无 Node 集成;外部链接交给系统浏览器。退出时拆除整棵服务器进程树(SIGTERM + 超时升级;Windows 走 `taskkill /T`)。

## 构建安装包

```sh
pnpm exec tsx apps/desktop/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

产物落在 `apps/desktop/dist-app/`。流水线按 python/sdk-runtime 配方暂存服务端(legacy hoisted `pnpm deploy`、恢复 hoist、物化符号链接),删掉本机编译的原生 `build/` 树以强制走多平台预编译产物,补齐 macOS 安装时跳过的平台分包可选依赖的 win32-x64 成员,再按平台暂存 Node 运行时(`--skip-repo-build` / `--skip-deploy` 复用既有产物)。每份载荷冒烟测试之前先过一道载荷门禁:每条平台规则至少丢弃一个目录,每个平台分包目录都要对得上它所在的 target,活下来的模块不得按名解析已被裁掉的包。

**整个构建跑在自己创建、结束即删的一次性 `$DSH_HOME` 上**,于是它启动的任何服务端都不会改动这台机器自己的 harness 状态——`prepareProfile` 会重写 profile 的根配置,`healProfilesModuleFallback` 会把每一条扁平兜底符号链接重指到这次构建随后就要删掉的暂存树上。启动门禁按壳播种真实 home 的同样方式播种那个临时 home,再要求两个内置插件都出现在所服务 index 点名的 client 模块里,于是它证明的是载荷的性质,而不是构建机自己 profile 的性质。

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

**没有**签名的构建保持旧行为:自己比对版本,用系统浏览器打开下载,只在启动时或手动检查时,绝不在会话中途。走哪一条由每次检查现场判断:看 `Contents/_CodeSignature/CodeResources` 在不在——签名会写出它,ad-hoc 链接器签名不会。已签名的构建若在运行期以重试修不好的方式失败,本次运行剩余时间降到同一条下载路径,并留下一行日志,而不是让这次检查以错误框收场。

**下载中断会先重试,再谈放弃。**electron-updater 不保留失败传输的任何部分:全量下载不发 `Range` 头,而任何错误都会删掉半截文件并清空 pending 目录。因此 `src/download-retry.ts` 在失败前面放了三次完整重试——间隔 2 秒、6 秒、18 秒——进度窗不关,并写明正在等待第几次。会重试的是网络:连接被切断或被拒绝、DNS 失败、请求超时、任何 `net::ERR_…`,以及更新源返回的 5xx、408、425、429。不重试的是判定:`ERR_UPDATER_*` 拒绝、签名不符、校验和不匹配、4xx——以及分类器不认识的任何失败,它们默认按致命处理,这样一个不认识的错误不会再赔上三次整包传输。重试用尽后,这次下载只记日志并就地放弃:层级不变,**macOS 不降级**,下一次定时检查从头再传一遍,手动检查会收到一个对话框说明此事。致命失败仍按上面那套层级规则走——macOS 在本次运行剩余时间降到下载页,并在那一层重跑这次检查。重试并不会让更新变成可续传:差量下载需要缓存目录里存在上一版的 `update.zip`,所以全新安装之后的第一次更新,每次尝试都是整包传输。每次重试与结束它的那个结论都写进 `dsh-server.log`。

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
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt             # ship the built version
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --dry-run   # verify without uploading
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --minimum-version 0.1.0-rc.8
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --republish  # repair a cut-off upload
pnpm exec tsx apps/desktop/scripts/publish-update.ts --notes notes.txt --no-prune   # leave every old version in place
```

脚本会拒绝与 `package.json` 对不上的 `dist-app`,重新校验安装程序的 NSIS 完整性 CRC,并断言本次构建盖过更新源在提供的版本。上传顺序是**先产物、两端校验、清单最后**,因此发布途中轮询的客户端读到的是旧清单指向旧产物,绝不会读到一份指着还在上传的文件的清单。它还会剔除本次不上传的产物在清单里的条目:macOS 构建会在 zip 旁边列出 dmg,而只有 zip 会发布,留着那条就等于在更新源里放了一个 404。

**更新源自己会清理,而且两类文件留的深度不同。**等两个清单都从更新源回读到新版本之后,脚本会列出各渠道目录,按两条规则裁掉多余的:**最新的两个版本留产物,最新的十个版本留 `.blockmap`**。更新过程中真正会从更新源取的只有其中一类——electron-updater 会下载新版本的 blockmap,但旧版本的那份先读客户端自己的缓存,只有缓存里没有了才回落到更新源;而旧**产物**它同样只从那个缓存里打开,从不走网络。所以留在服务器上的旧产物(138–174 MB 一个)是给回滚和手动下载用的,旧 blockmap(145–181 KB 一个)则是给缓存丢了的客户端兜底;两者留同样深,等于用前者的价钱买后者的好处。发布成功之前不删任何东西;版本按 semver 优先级排序而不是按名字排(`0.1.0-rc.9` 比 `0.1.0-rc.10` 旧);清单以及本次发布上传的一切永远不进候选;解析不出版本的名字只记一行日志、原样留着。`--no-prune` 跳过整个步骤;`--dry-run` 会把「会删什么、会留什么」原样打印出来,并且什么都不删。这套判断在 `scripts/prune-feed.ts`——一个纯函数,由 `tests/prune-feed.spec.ts` 脱离服务器测试。

更新源在主机上的路径是 `/var/www/dsh-updates/{win,mac}`,由追加的单个带 `alias` 的 `location /dsh-updates/` 提供。那台 nginx 使用自定义前缀(`/data/third_party/nginx`),编译时不含 rewrite 模块,且 master 不归 systemd 管——重载请用 `nginx -s reload`,绝不要用 `systemctl`。该目录不套 BasicAuth,因为 electron-updater 不会带凭据。

## 信任与签名

**macOS 构建由本项目自己持有的一张自签名证书签署。**`scripts/sign-mac.cjs` 在 `afterPack` 钩子里直接跑 `codesign`,因为 electron-builder 自己的签名过程用 `security find-identity -v` 过滤身份,未信任的自签名证书永远过不了这道过滤。`codesign` 没有这条规则;它真正要求的是身份所在的钥匙串必须在用户的钥匙串搜索列表里,所以脚本每次构建新建一个钥匙串、加进列表、签名,再在 `finally` 里还原搜索列表。身份默认从 `~/Library/Application Support/dsh-desktop-signing/dsh-desktop-signing.p12` 读取,除非 `DSH_MAC_SIGNING_P12` 与 `DSH_MAC_SIGNING_P12_PASSWORD` 另行指定;缺失时**构建失败**,`DSH_MAC_SIGN=0` 是显式索要未签名构建的方式。更新路径校验的就是这张证书,所以它不能轮换:它的指纹就在每个已安装客户端校验的 designated requirement 里。

它不是 Developer ID 证书,应用也未公证,所以由**浏览器**下载的副本,Gatekeeper 仍要求右键打开(或 `xattr -dr com.apple.quarantine`);由 Squirrel 装上的更新不带隔离属性,两者都不需要。Windows 产物未签名,SmartScreen 会弹未知发布者提示。Windows 包只做了交叉构建与结构校验——交付前务必在真实 Windows 机器上冒烟。

这也框定了更新源能承诺什么。TLS 认证服务器,清单里的 sha512 把产物绑定到清单,所以传输途中无法被做手脚。产物带的是本项目自己做的签名,不是操作系统会背书的那种,所以对 `/var/www/dsh-updates` 的写权限仍然等于对每个客户端下一个安装程序的写权限——macOS 客户端会拒绝由别的证书签出的 bundle,但对「给它的是这张证书签出的哪一个构建」没有意见。补上这一环要靠 Windows 的 Authenticode 与 macOS 的 Developer ID 加公证。

## 内置插件

**四个插件随安装包分发,并在首次启动时自行挂载**,所以全新安装无需 pnpm、无需联网、无需 `dsh plugin add` 就已就位:

| 包名 | 版本 | 提供什么 |
|---|---|---|
| `dsh-better-sidebar` | `0.14.0`,来自 npm | 右侧栏:文件树、编辑器、终端标签页与任务列表 |
| `dsh-at-file` | `v0.6.5`,来自作者仓库该 tag 所指的提交 | 输入框里的 `@` 文件提及 |
| `@haoran/dsh-screenshot` | `0.1.4`,来自提交进本仓库的 tarball | `screenshot` 工具:渲染任意页面——带 `cookies` 或 `headers` 时也包括登录墙后的页面——把像素交给 agent,并在要求时把 PNG 写成文件 |
| `@haoran/dsh-llm-permission-gateway` | `0.1.3`,来自提交进本仓库的 tarball | 自动审查这个权限预设,以及在它被选中期间逐个判断每次有副作用的工具调用的审查模型 |

它们是 [apps/desktop-server](../desktop-server/README.zh.md) 的普通依赖,所以 `pnpm deploy` 会把它们和服务端闭包的其余部分一起放进载荷的 `server/node_modules`,版本由携带它们的那个安装包钉死——一次更新分发的就是该次构建声明的版本。`dsh-better-sidebar` 的 `node-pty` 通过 `pnpm-workspace.yaml` 的 override 钉到 harness 内核自己那一份,因为插件自己写明两半必须解析到同一个物理包,而载荷的平台裁剪规则只够得着顶层那一份。

**这个网关随包挂载,但自动审查不是默认值。**插件自带它的权限预设,所以预设控件里会在 `read-only`、`workspace-write`、`danger-full-access` 旁边多出一项自动审查。没有任何东西会替你选中它:编排出来的默认值是 `workspace-write` 加 `ask`,新会话被钉住的仍然是它。选中自动审查会把操作系统沙箱关掉——文件系统与命令不再有操作系统层面的围墙——并把一个审查模型放到那个位置上,由它逐个判断有副作用的工具调用,只在自己拿不准或审查失败时才弹审批框。此后安全性取决于那个模型的判断质量,而不再取决于沙箱。这个预设写在插件自己的 patch 层里,而不是写在你的 profile 里,所以它恰好在这个 bundle 挂载期间存在,两者同来同去。两条红线——凭据外泄,以及对权限系统自身的改动——编译在插件里,配置关不掉。

**`dsh-at-file` 取自 tag 而非注册表**,因为作者在 npm 上只发到 `0.6.3`,而 tag 已经到 `v0.6.5`。分发 `0.6.3` 会与自行装了 `v0.6.5` 的 profile 配不上:一个 bundle 的两半从不同地方解析——patch 层经 `resolveBundleDir` 安装目录优先,模块则按常规的逐级向上查找,先撞上 profile 自己的 `node_modules`——于是这一行来自 `0.6.3`,代码来自 `v0.6.5`。这条依赖写的是该 tag 所指的**提交**,而不是它的归档 URL:pnpm 不为 GitHub 归档记录完整性哈希,因为那些字节并不保证稳定,而 `pnpm deploy` 拒绝没有完整性字段的 lockfile 条目。提交本身就是它的哈希,于是 lockfile 钉住的是内容。该仓库把构建好的 `lib/` 提交了进去,也没有声明 `prepare` 脚本,所以安装期什么都不构建。

**两个 `@haoran/` 插件都没有发布**,所以它们各自的依赖都是一条 `file:` 标识符,指向与声明它们的清单放在一起的 `apps/desktop-server/vendor/` 下的 tarball。pnpm 为 `file:` tarball 记录 `integrity` 哈希,与注册表包完全一样,这正是 `pnpm deploy` 要求的东西,也是 GitHub 归档 URL 给不出的东西。升级其中一个意味着提交一个新的 tarball 并把它的标识符指过去;没有别的渠道,因为两个都不在任何注册表上。

**它们两个都没有浏览器那一半。**包清单里的 `dsh.client` 才是让服务端为它组合出 `/plugins/<name>/client.js` 那一行的东西,而工具是 agent 去调用的,不是页面去加载的。构建的启动闸从载荷自己的清单读这条声明,而不是从一份名单读:每个有浏览器那一半的内置插件都必须出现在所服务的 index 所列的客户端模块里,其余的则由这次启动本身来证明——profile 列了名字而 Loader 解析不了的 bundle 是硬性启动失败,所以打印出 URL 行的服务端已经把四个都解析了。

**`dsh-better-sidebar` 在本宿主上必须是 `0.14.0` 或更高。**`0.1.0-rc.8` 起不再暴露 `window.__DSH_MODULES__` 页面全局,模块访问改由 `ctx.modules` 服务提供,这让每个懒加载 chunk 解析外部依赖的方式全面失效——`0.13.1` 会报 `[dsh-better-sidebar] chunk "terminal": client module system unavailable`,终端、编辑器与 Mermaid 面板一起跟着挂掉。`0.14.0` 注入 `@deepseek-ai/dsh-client-modules`,并把插件自有的全局共享给它的 chunk 副本,同时移除了随 rc.8 消失的 `dsh-client-web-react` 与 `dsh-client-schema-form` 两个 peer。

**壳启动的是自己的 profile `desktop`,并在启动服务端之前把它建出来。**`desktop` 没有随附模板,所以没有谁会按需把它建出来,而服务端拒绝启动一个不存在的 profile;`src/profile-seed.ts` 先于服务端运行,写出 `initProfile` 会写的那三个文件——清单、`cordis.patch.yml`,以及 `pnpm-workspace.yaml`,后者的 `hoisted` linker 正是让日后安装的插件共用安装目录里那一份 cordis 的东西。清单列出 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与四个内置插件,于是 `loadProfile` 会应用每个插件的 `cordis.patch.yml` 层;每个内置插件还会被链接进 `$DSH_HOME/profiles/node_modules`,即 Loader 从它解析插件标识符所依据的 profile 目录逐级向上就能走到的扁平兜底目录。每一次写入都是追加式且幂等的:已列出的名字不会重复添加,正确的链接原样保留,已存在的文件不会被改写,任何 bundle 条目、依赖或清单里的其他字段都不会被删除。清单以 rename 写入,所以启动中途被打断也只会留下原来那一份。某次启动确实改动了什么时向 `dsh-server.log` 写一行,没改动则不写。

壳认不出的 profile 原样保留,启动照常继续,只是没有内置插件:解析不了的清单留给服务端自己的诊断,没有声明 bundle 列表的清单按手写编排对待,该放链接的位置上是真实目录则如实报告而不是删掉。profile 目录根本写不出来是启动唯一绕不过去的失败;日志那一行会说明,随后是服务端自己的诊断。

**桌面端的 profile 与 CLI 的是分开的,harness home 的其余部分不是。**会话、凭据与模型设置都在 `$DSH_HOME` 根上,所以终端里的 `dsh web` 与桌面窗口读到的是同一批。分开的是挂载了哪些插件:`dsh web` 编排的是 `$DSH_HOME/profiles/web/`,桌面端从不写它。要让 CLI 也有这几个插件,就在那边用 `dsh plugin --profile web add <包>` 自行安装。反过来,上面这四个在桌面 profile 里已经有了;你此前额外加进 `web` 的插件列在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里,用 `dsh plugin --profile desktop add <包>` 把其中一个装进桌面 profile。

**如果你在这版之前自己装过其中某个插件**,profile 自己的 `node_modules` 里仍留着那一份,Loader 会先找到它,而 patch 层依旧来自载荷。启动会如实说明——`warning: profile copy dsh-at-file@0.6.3 shadows the shipped 0.6.5 module`——但什么都不改,因为 profile 的依赖归安装它的人所有。`dsh plugin --profile desktop remove <name>` 会去掉 profile 里那一份、留下分发的那一份,也就是全新安装本来的状态。

**要关掉其中一个,就在** `$DSH_HOME/profiles/desktop/cordis.patch.yml` **里禁用它那一行**——提及功能是 `dsh-at-file`,侧栏是 `better-sidebar`,截图工具是 `screenshot`:

```yaml
- id: better-sidebar
  disabled: true
```

改为从 `dsh.profile.bundles` 里删掉名字则只能维持到下次启动,届时会被重新播种。

**网关是唯一一个不该单独禁用其行的内置插件。**它的 patch 层贡献了两行——门本身,以及那张加入自动审查的预设表——单独禁用门这一行,会让预设留在控件里而背后空无一物:此时再选中它,就是把沙箱关掉而不放任何审查进去,严格差于 `danger-full-access`。先把会话切到别的预设;若还想让它从控件里消失,就在你自己的 `cordis.patch.yml` 里重述 `permission` 行的 `presets` 而不带 `yolo-access`——以 id 为目标的 patch 会替换整个 `config`,所以那次重述必须把你要保留的预设一并写全。

## 渲染服务

**壳把自己的 Chromium 借给服务端**,所以截图不取决于这台机器上装没装 Chrome 或 Edge。在启动服务端之前,主进程在 `127.0.0.1` 与一个临时端口上打开一个 HTTP 监听、生成一个 32 字节的 token,并把两者放进那一个子进程的环境——`DSH_DESKTOP_RENDER_ENDPOINT` 与 `DSH_DESKTOP_RENDER_TOKEN`,绝不放进壳自己的 `process.env`,所以用户启动的任何别的进程都继承不到。`@haoran/dsh-screenshot` 每次调用都去读它们。两个都读不到的 harness 改用系统上的无头浏览器渲染,这也正是所有非桌面安装的做法;监听没能打开的那次启动会记一行日志并照常继续,它的截图走的是同一条退路。

请求是 `POST /render`,带 `authorization: Bearer <token>`、`content-type: application/json`,以及请求体 `{ url, width, height, fullPage?, delayMs?, headers?, cookies? }`。它可能得到的全部回答:

| 回答 | 何时 |
|---|---|
| `200 image/png` | 截图本身,PNG 字节,尺寸正好是请求的视口 |
| `400` | 不是 JSON、不是对象、请求体超过 64 KB、某个字段类型不对、`width` 或 `height` 不在 16–4096 内、`delayMs` 不在 0–10000 内、`url` 不是绝对 URL,或某个 `headers`/`cookies` 条目越界或不合它的文法 |
| `401` | 缺少或写错 bearer token |
| `404` | 其他任何路径或方法 |
| `422` | 格式正确但 scheme 不是 `http`、`https` 或 `file` 的 URL,或在 `file:` URL 上带了 `headers`/`cookies` |
| `500` | 页面加载失败或截图失败;这一行带着 Chromium 的错误码 |
| `503` | 已经受理了四个请求 |
| `504` | 该请求越过了 25 秒的期限;这一行说出渲染当时在等什么 |

每个失败响应体都是一行 `text/plain`,因为读它的是一个工具,它会把这句话引进模型看到的消息里。

**一个请求可以带上页面所需的会话。**`cookies` 是 name→value 的映射,在加载之前设到这次渲染自己的 session 上,因此它不只覆盖文档,也覆盖页面的子资源——一个图片全部 401 的已登录页面,不是任何人想看的那个页面。`headers` 是 name→value 的映射,只挂在主框架那一次导航上,这正是 bearer token 或 Host 覆写需要的位置;`cookie` 头会被指名拒绝并指向 `cookies`,因为那样送进去的 cookie 只覆盖文档、覆盖不到文档里的任何东西。两者合起来受同一组边界约束:最多 24 个条目、共 8 KB,名字必须是 HTTP token,头部值限于可见 ASCII 加空格与制表符(换行会凭空追加一个谁也没发过的头,因为 `loadURL` 把它们当作一整个以换行分隔的字符串),cookie 值限于 RFC 6265 的 cookie-octet。凭据由调用方提供,壳自己一个也不留:它们活在随窗口一起消亡的 session 上。

**当主框架最终落在请求所指之外时,`200` 会说出它落在哪里**,放在 `x-dsh-render-landed-url` 上,可见 ASCII 之外的部分做百分号编码,并截到 96 个字符。一张登录页的截图是「正确地渲染了错误的页面」,而像素本身说不出它是哪一种;插件把这个响应头变成工具结果里的一句话,点名 `cookies` 与 `headers`。主框架停在原地时不发这个头,比较的是归一化之后的 URL,所以 Chromium 给源地址补上的那个斜杠不算重定向。

**截图的尺寸就是请求的尺寸。**`capturePage` 返回的位图带着显示器的缩放系数——Retina Mac 上是 2,多数 Windows 机器上是 1——所以同一个 1440x900 的请求本会在两边给出不同的图像。窗口保留它原本的缩放系数,因为强制指定是一个进程级开关,会波及用户自己那个窗口;截图则在编码之前被缩放到请求的 CSS 像素:整页截图缩放到请求的宽度与它测得的高度。把一张 2x 的截图降采样,不会损失 1x 渲染本来就有的任何东西。

**504 会说出页面当时在等什么**,好让调用方分得清是一张卡住的图、一个死掉的代理,还是一个卡死的渲染进程。这一行说出渲染当时处在哪个阶段——在排队、在加载页面,还是已经越过 load 事件、正在等 `delayMs`、测量、调整窗口大小或截图——而在页面还没加载完时,它还会说出主文档的 HTTP 状态码、主框架最终落在哪里(当那不是请求所指的地址时),以及最多三个仍在飞行中的请求及其 Chromium 资源类型:`render timed out after 25000ms: main document 200, load event not fired, 7 requests pending: [image] https://www.gravatar.com/avatar/…, [image] …, [script] … (+4 more)`。每个 URL 截到 96 个字符,整行截到 500 个字符,后者正是 `@haoran/dsh-screenshot` 引进模型消息里的长度。渲染本身不因此改变:壳是从 `did-navigate` 与 session 上那几个非阻塞 `webRequest` 钩子读到这些的,它们只观察请求,不扣住请求。

**每次渲染都拿到一个与应用自己那扇窗毫无共享的隐藏窗口。**它的 session 没有 `persist:` 前缀,所以只活在内存里、随窗口一起消失:被渲染的页面读不到也写不了用户正在用的那扇窗的 cookie、存储与缓存,它存下的东西也活不过这一个请求。没有 Node 集成、没有 `webview`、没有 devtools;每一个权限请求都被拒绝,页面试图发起的每一次下载与每一次开窗也都被拒绝。对话框被禁用,于是 `alert()`、`confirm()`、`prompt()` 既不会在一扇用户看不见的窗口上弹出原生模态框,也不会把它背后的页面线程堵住;窗口是静音的,于是自动播放的 `<audio>` 元素传不到扬声器。窗口在响应时、加载失败时与期限到时都会被销毁。

**边界在哪**:同一时刻只渲染一个,同时最多受理四个请求(一个在渲染、三个在等),期限 25 秒且从受理时刻起算,而不是从渲染开始时算。这个数必须小于 `@haoran/dsh-screenshot` 自己的 30 秒预算:插件的 `AbortSignal.timeout` 从 fetch 调用那一刻起算,而本服务的期限在受理之后才开始,所以两边取同一个数就会是插件先放弃,上面那些回答一个也到不了模型手里。`fullPage` 截图会测量 `document.documentElement.scrollHeight` 并把窗口调到那个高度,夹到 8192 px 为止,因为无限滚动的文档报出的高度会在测量过程中一直变大。

**三条机制框定了谁够得着这个服务。**监听绑在 loopback 上,机器外的东西根本连不上。token 以常数时间比较,所以扫到端口的本地进程没有 token 也用不了这个服务。从不发送任何 CORS 头,同时除 `POST /render` 以外的方法一律答 404,于是 `authorization` 头与 JSON content type 逼浏览器发出的预检被拒绝——这正是把用户自己浏览器里的页面挡在外面的东西。

构建之后,这条命令检查单元测试够不着的那一半——隐藏窗口到底画不画:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run build:ts
pnpm --filter @deepseek-ai/dsh-desktop run render-smoke
```

它在真实的 Electron 里渲染一个本地文件,检查截图尺寸无论显示器缩放系数是多少都正好是请求的视口、整页截图确实比它更高,以及 401、422 与 500 三种回答。有一个用例起一个站点:任何没有会话的访问都被重定向到它的登录页,并在真实 Chromium 上核对三种结果——不带会话时回答里有落点响应头,带 cookie 与带 header 时都没有。最后一个用例让页面去请求一个本地监听——它接受连接却从不回答——这正是证明 `webRequest` 钩子确实通到超时那一行的地方:504 会点出那张图。

## 服务器环境

服务器在用户主目录启动,环境为 GUI 继承环境加标准 shell PATH 条目(macOS GUI 应用以 launchd 的极简 PATH 启动)。`DEEPSEEK_API_KEY` 走常规凭据链(环境变量 → 托管存储 → `.env`),首启无 key 也能进 UI,在模型设置页补录。服务器输出追加到应用日志目录的 `dsh-server.log`,由 **帮助 → 查看日志** 打开;启动页只报告启动阶段,不再显示路径。

**启动页与下载窗跟随应用主题。**两套色板都取自 web UI 自己的 token,所以无论哪一种模式,启动页与它交接给的应用都是同两种颜色。外观在窗口存在之前就定下——`backgroundColor` 决定页面加载期间画什么——顺序是:`~/.dsh/settings.yaml` 里的持久 `ui-theme.preference`,当它是显式的 `light` 或 `dark` 时优先;否则跟随系统(`nativeTheme.shouldUseDarkColors`),这也正是它默认值 `system` 的含义。**显式设置优先于系统。****帮助 → 关于** 给出版本与更新源地址。菜单栏文案按 `app.getLocale()` 在中英之间选择;对话框保持中文。

## Known Limitations and Deferred Work

- 通知打不开它所说的那个会话:web UI 把选中的会话放在内存里、URL 里什么都不放,壳没有地址可加载。补上这一点需要 web 客户端接受 URL 里的会话;届时壳这边只是 `loadURL` 的一个参数。
- macOS 已签名但未公证,所以由浏览器下载的副本首次运行仍需右键打开。公证需要 Apple 开发者账号;更新路径不需要。
- Windows arm64 与 Linux 桌面目标未构建;node-pty 预编译已覆盖 win32-arm64,缺口只是打包工作。
- 开发启动(`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`)用的是检出目录的已构建 CLI 和 PATH 里的 Node,不是暂存资源。
- 渲染服务按次启动、串行工作。同时受理四个请求、只渲染一个,所以一个把 25 秒期限用满才加载完的页面会占住这个位置,排在它后面的请求只拿得到自己那份期限剩下的部分。
- 壳的视口下限是每边 16 px,而 `@haoran/dsh-screenshot` 自己允许到 1。要求更小视口的 `screenshot` 调用在桌面端会被答以 400,在别处则由系统浏览器渲染。
- 只有壳的渲染服务能带上 `headers` 与 `cookies`。插件的另一个后端是一次性的 `--screenshot` 浏览器命令行,没有任何设置它们的办法,所以在没有这个服务的安装上,这样的调用会被拒绝,而不是以未登录状态渲染出来。
- 内置插件无法从 profile 侧钉到另一个版本。用 `dsh plugin --profile desktop add` 安装同名包会在 profile 自己的 `node_modules` 里放一份,Loader 会先找到它,而 `resolveBundleDir` 仍从安装目录读取 patch 层——那样这一行来自一个版本、代码来自另一个版本。
- `dsh-better-sidebar` 用壳自己的环境启动终端:两处 `pty.spawn` 传的都是 `env: { ...process.env }`,而不是所有 harness spawner 都会走的 `packages/subprocess/subprocess/src/index.ts` 里的 `scrubbedParentEnv()`,后者会剥掉所有 `DSH_` 前缀的变量以及名字匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量。该插件注册了八个模型可以调用的终端工具(`terminal_create`、`terminal_send`、`terminal_read` 等),所以模型可以经由其中之一读到那份未经过滤的环境。Windows 的 GUI 进程继承用户级环境变量,因此用 `setx` 设过的 `DEEPSEEK_API_KEY` 会出现在那个终端里;macOS 的 GUI 进程拿到的是 launchd 的环境,通常不含它。
