# Agent Note: The installer's app-running check matched every process

Status: implemented

[English](2026-08-19-installer-app-running-check.md) | 中文

## Problem

[桌面客户端](../feature/2026-08-18-desktop-update-channel.zh.md)的一次 Windows 更新停在「DSH Desktop 无法关闭。请手动关闭它,然后单击重试以继续」——也就是 NSIS 的 `appCannotBeClosed`——而那个「重试」按钮回到的正是产出它的那个循环,于是安装既进不去,也只剩取消一条出路。

真机上的三条观察把它收敛到一件事。失败当刻用管理员 PowerShell 查,安装目录 `D:\soft\DSH Desktop` 下**一个进程也没有**,全机匹配 `*DSH*` 的进程只有一个:安装器自己,跑在 `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\` 下。它在手动双击、右键**以管理员身份运行**的安装里同样复现,而那条路径全程没有 `elevate.exe`。而这句提示是 `appCannotBeClosed`,模板只有在自己的检查已经判定「应用在跑」、随后又没能把它停掉之后才会走到。

所以安装器盯着的不是某个卡住的进程,而是一个错的进程集合。

最后这一步并不成立,后来在机器上定了案:以 250ms 采样盯完一次失败安装,记录到五次 `old-uninstaller.exe`,以及一次进程检查都没有,而 `$INSTDIR` 从向导里直接读出来是 `D:\soft\DSH Desktop`。`CHECK_APP_RUNNING` 在安装器这一侧根本不会执行——`installSection.nsh` 里的 `${ifNot} ${UAC_IsInnerInstance}`,对上 section 跑在 inner 实例里的 `perMachine` 安装——所以 `appCannotBeClosed` 是从 `uninstallOldVersion` 的重试上限来的。[卸载暂存路径越过 MAX_PATH](2026-08-19-windows-update-max-path-uninstall-loop.zh.md) 拥有那条链条及其修复。下面描述的过度匹配是真实的、可达的、值得拒绝的;但它不是产生这个对话框的原因。

## Decision

`build/installer.nsh` 定义 `customCheckAppRunning`,`CHECK_APP_RUNNING`(`include/allowOnlyOneInstallerInstance.nsh:32-43`)会用它替换掉整个内置步骤。这也是唯一有用的粒度:底下那几块——`FIND_PROCESS`、`KILL_PROCESS`、`_CHECK_APP_RUNNING`——各自错得都不是一层包装能修的。

替换版做的正是内置步骤本该做的事。`elevate.exe` 第一个被停,单独停,而且**不带** `/T`:安装器是它的子进程,树杀会把安装本身杀掉;先停它也把本进程从应用的子孙链里摘了出来,之后再用 `/T` 杀别的才安全。然后给应用与它的 `node.exe` 服务端 10 秒自行退出,超时后对残留连子进程一起杀——服务端自己的子进程(shell、语言服务器)占着同一批文件。整个过程在一个 PowerShell 进程里跑完,而不是一轮起一个:那条查询比两轮之间的 500 毫秒还贵,所以轮数不是时间预算。

三条硬约束框住它,而这三条才是真正的修复:

1. **不信任 `$INSTDIR`。**只有当它是绝对盘符路径、长过卷根、目录存在、且目录里有 `${APP_EXECUTABLE_FILENAME}` 时,才拿来当路径前缀;用时必补分隔符,这样一个名字同前缀的同级目录就匹配不上。其余情况一律降级为精确映像名。
2. **本进程永远不是匹配项。**pid 取自 `kernel32::GetCurrentProcessId`,从每个匹配集里排除;而它用来匹配的两个映像名,既不是安装器的(`… Setup <版本>.exe`),也不是卸载器的(`Uninstall ….exe`)。
3. **杀进程有上界,绝不是「匹配到什么杀什么」。**一个进程要合格,映像名必须精确命中;有可信前缀时还要额外命中路径。于是降级路径也够得着 `elevate.exe`——沿本进程自己的祖先链找到,那条链上只可能有启动我们的那个启动器——以及连树杀掉的应用;而绝不碰裸的 `node.exe`,那名字在任何机器上都属于别人。

**一个钩子,不是两个。**原先的 `customInit` 被删掉,而不是与新钩子并存。`.onInit` 跑在目录页定下 `$INSTDIR` 之前,在那里清扫等于拿一个还没定的值去匹配——正是产出这个 bug 的那类输入;而 `customCheckAppRunning` 只在真正要紧的两处跑:安装段里、`uninstallOldVersion` 之前,静默与否都走(`installSection.nsh:35-37`);以及卸载器开始搬文件之前,从它的静默 `un.onInit` 路径或它的段里进来(`uninstaller.nsh:19,150`)。两次编译都会拿到 `build/installer.nsh`——卸载器就是同一份 `installer.nsi` 加 `-DBUILD_UNINSTALLER` 编出来的——所以卸载器那侧不需要第二份定义;也因此文件里的一切都必须在 `un.` 函数里合法:不用 `Call`,不定义函数,只用插件调用与内联 LogicLib。

## `$INSTDIR` 从哪来,解析不出来又要付什么代价

`initMultiUser` → `setInstallModePerAllUsers`(`multiUser.nsh:62-99`)从 `HKLM\SOFTWARE\<APP_GUID>` 读 `InstallLocation`——键名是 `Software\${APP_GUID}`,GUID 为 `UUID.v5(appId, …)`,对 `dev.dsh.desktop` 即 `e36966b0-1805-5ec4-9648-404e09da7db1`——该值缺席时退回 `%ProgramFiles%\DSH Desktop`。`registryAddInstallInfo`(`include/installer.nsh:103-106`)是唯一的写入方,而它只写这一个键:**旁边那个 `Uninstall` 项带的是 `DisplayName` 与 `UninstallString`,本来就没有 `InstallLocation`**,所以在那儿看到空值是设计如此,并不说明任何问题。

这个值缺失的代价不止本笔记谈的那句提示。`uninstallOldVersion` 会为**旧**卸载器把正确目录找回来——有 `InstallLocation` 时用它,否则取 `UninstallString` 的父目录——并作为 `_?=` 交过去。而卸载器的 `un.onInit` 随后走到 `initMultiUser`(`uninstaller.nsh:31`),它重读同一个空键,并在卸载段开始前**覆盖掉 `$INSTDIR`**,换成 `%ProgramFiles%` 兜底值。于是旧版本没被卸掉,新版本却装进了兜底目录:应用被悄悄搬了家,旧的那份留在原地。

## 两处上游缺陷

两处都在 app-builder-lib 26.15.3 的 NSIS 模板里,都值得报给上游;两处都还没提。

**`FIND_PROCESS` 忽略自己的 `_FILE` 参数,改按 `$INSTDIR` 前缀匹配**(`include/allowOnlyOneInstallerInstance.nsh:64-79`)。它的 PowerShell 分支(`:66`)是 `Get-CimInstance Win32_Process | ? {$_.Path -and $_.Path.StartsWith('$INSTDIR','CurrentCultureIgnoreCase')}` 加一个 `.Count -gt 0` 判定,于是每个调用方传进来的文件名被丢掉,安装目录下的任何进程都能代表应用作答。前缀不补尾部分隔符,所以 `C:\Program Files\App` 也匹配 `C:\Program Files\App Server\…`。而 `String.StartsWith("")` 对任何字符串都为真,于是一个没解析出来的 `$INSTDIR` 会匹配整台机器——到这一步 `KILL_PROCESS`(`:81-103`)照同一个集合逐个 `Stop-Process -Force`,其中大多数落在安装器根本无权碰的进程上而失败,`_CHECK_APP_RUNNING`(`:105-166`)在第二轮发现残留(`$R1 > 1`),整轮就死在 `appCannotBeClosed`,而它的「重试」只是重来一遍。最小复现:一个 assisted 的 `perMachine` NSIS 构建,让 `$INSTDIR` 解析不出来(清掉 `HKLM\SOFTWARE\<guid>\InstallLocation`,或传一个解析成卷根的 `/D=`),在机器上有任意无关进程运行时启动它。

**卸载器把自己的 `_?=` 目录丢掉了。**`un.onInit`(`uninstaller.nsh:31`)在 NSIS 已经用 `_?=` 设好 `$INSTDIR` 之后才插入 `initMultiUser`,而 `setInstallModePerAllUsers` 会无条件用注册表值或其默认值重新赋值 `$INSTDIR`。安装器的 `uninstallOldVersion`(`include/installUtil.nsh:169-176`)费劲把正确目录推导出来并作为 `_?=` 递过去,卸载器转手就扔了。最小复现:装一份 per-machine,删掉 `HKLM\SOFTWARE\<guid>`,再跑一个更新版本的安装器,可见旧目录原封不动,新版本落到 `%ProgramFiles%`。

失败那一轮 `$INSTDIR` 究竟是什么,事后已无法从机器上取回。空串是与所见最相符的值——只有它既能匹配到安装目录之外的进程,又能解释原先那段 `customInit` 为何毫无动静:它的 `('$INSTDIR').TrimEnd('\')+'\'` 会变成 `\`,而没有任何绝对路径以反斜杠开头,于是它什么也没扫到,还成功退出——但一个仅仅过宽的前缀(卷根,或某个上级目录)同样符合这些观察。上面第一条约束否掉的是整整一类值,所以修复并不依赖把它坐实。有一个诱人的解释可以排除:这份 NSIS 是按 `NSIS_MAX_STRLEN=8192` 构建的(对着 electron-builder 附带的 `x86-unicode` stub 验过),所以那条约 1040 字符的清扫命令从来没有被截断过。

## Verification

没编进去的钩子是静默失效的——`!ifmacrodef` 干脆不触发——所以 `customCheckAppRunning` 用往宏体里注入 `!error` 再读编译器的回话来证明:

```
Command line defined: "BUILD_UNINSTALLER"
!error: DSH-HOOK-COMPILED-IN
Error in macro customCheckAppRunning on macroline 1
Error in macro CHECK_APP_RUNNING on macroline 6
!include: error in script: "uninstaller.nsh" on line 2
```

整个论断都在这五行里:钩子被走到了,走到它的是 `CHECK_APP_RUNNING`,而报出它的这次编译是**卸载器**那次——`uninstaller.nsh:2` 正是 `un.checkAppRunning` 里唯一那条语句——所以卸载器那侧由这一份定义覆盖。`build/installer.nsh` 被改名、挪动或新增忽略规则时,要重跑的就是这一项。

生成出来的命令针对两件会让 `nsExec` 单行命令静默失效的事做了检查:整条命令不含双引号(PowerShell 主体全用单引号,所以没有东西会提前终止 `-Command` 参数),展开后约 1220 字符,对应上限 8192。

编译器之后的一切都需要真 Windows。`pnpm run test:snapshot` 到不了 NSIS,而 macOS 宿主上没有 PowerShell 可以拿来解析这段清扫命令。

## Alternatives considered

**保留 `customInit`,再在旁边加 `customCheckAppRunning`。**否掉,因为两者会隔着几秒对两个不同的 `$INSTDIR` 值跑同一段清扫,而先跑的那个恰恰更不可信:`.onInit` 在目录页之前。为了赌哪个值对而把逻辑复制一份,正是两份实现开始漂移的方式。

**包一层而不是替换——先自己清扫,再让 `_CHECK_APP_RUNNING` 复核。**否掉,因为那道复核本身就是缺陷。`$INSTDIR` 解析不出来的机器,无论目录多干净都过不了内置检查,而 `CHECK_APP_RUNNING` 与其内部之间没有任何钩子可以纠正它。

**给上游模板打补丁。**否掉:app-builder-lib 是 npm 依赖而非 vendored 源码,打过补丁的 `node_modules` 对其他每一个检出与 CI 都不可见。`customCheckAppRunning` 正是上游为此提供的扩展点。

**去掉 `packElevateHelper`,不留 `elevate.exe` 给它误判。**否掉,因为这修不了误判——没有任何 `elevate.exe` 时故障照样复现——而且要付出 per-machine 卸旧真正需要的那次提权:`isAdminRightsRequired` 只有在设了该选项时才会写进清单,而 `CreateProcess` 无法提权一个清单要求管理员的安装器。

**由应用在启动时写回 `InstallLocation`,让这个键自我修复。**否掉,归属不对。那个值由安装器在自己的安装段里写;应用要写 `HKLM` 得要一次它本来从不索取的提权。一个拿到坏值就会出事的检查,才是该修的东西。

## Consequences

安装器不再请用户去关一个应用:它等 10 秒,然后停掉它能证明属于本产品的那些进程。于是在应用开着时手动安装会直接把应用带走,没有内置步骤那道确认框——这是「绝不弹一个用户满足不了的框」所要付的、经过权衡的代价。

清扫验证不了的安装目录会降级为按映像名处理而不是失败,所以应用与更新的启动器仍然会被清掉,只剩内置的 `node.exe` 服务端交给旧卸载器自己应付。在恰好产出这个 bug 的那类机器上,这是一处真实的缺口,而它可读的信号只有一行 `DetailPrint`。

卸载器从同一份文件继承同一套检查,所以带上本修复的构建在手动卸载时不会像安装器那样走死。但从早于本修复的构建**往外**更新时,跑的仍是那个构建的旧卸载器与内置检查——之所以安全,只是因为安装器在调用它之前已经清扫过了。
