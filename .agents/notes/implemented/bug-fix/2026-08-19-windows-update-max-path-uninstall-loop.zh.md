# Agent Note：Windows 更新改为整目录改名来移除旧安装

Status: implemented

[English](2026-08-19-windows-update-max-path-uninstall-loop.md) | 中文

## 问题

在 Windows 上把新版 DSH Desktop 装到已有的 per-machine 安装之上，最后会停在一个用户无法通过的对话框上：

> DSH Desktop 无法关闭。请手动关闭它，然后单击重试以继续。

点「重试」只会回到同一个对话框，永远过不去。双击安装器、以管理员身份运行、以及让应用内更新去跑它，三条路复现得一模一样，而且全程没有任何 DSH 进程在运行。

这句提示说的是"有程序在运行"，而 app-builder-lib 的 NSIS 模板里有三处都会弹出同一个 `$(appCannotBeClosed)` 字符串（`include/allowOnlyOneInstallerInstance.nsh`、 `include/extractAppPackage.nsh`、`include/installUtil.nsh`）。只凭文案推理会指向第一处——进程检查——而那是错的，代价是好几轮根本不可能生效的修复。

在故障机器上的观测才定了案。安装过程中以 250ms 采样进程表，记录到正好五次 `old-uninstaller.exe` 启动，间隔十秒，随后弹窗，中间没有任何 `powershell.exe` 进程检查：

```
04:09:41  PROC old-uninstaller.exe  ppid=22712
04:09:51  PROC old-uninstaller.exe  ppid=22712
04:10:02  PROC old-uninstaller.exe  ppid=22712
04:10:12  PROC old-uninstaller.exe  ppid=22712
04:10:22  PROC old-uninstaller.exe  ppid=22712
04:10:32  WIN  [DSH Desktop 安装] | 重试(&R) | 取消 | DSH Desktop 无法关闭。
```

弹窗来自 `uninstallOldVersion`（`include/installUtil.nsh`）的重试上限，和进程检查毫无关系。

### 老卸载器为什么失败

`--updated` 卸载会先把 `$INSTDIR` 下的每个文件搬到 `$PLUGINSDIR\old-install`，然后才删除（`uninstaller.nsh`，`un.atomicRMDir`）。`$PLUGINSDIR` 位于 `%TEMP%`，所以每个暂存路径都是临时目录前缀加上该文件相对 `$INSTDIR` 的路径。对于装到 `D:\soft\DSH Desktop` 的安装，这个前缀比它替换掉的那个长 34 个字符，而载荷里最深的文件位于 `$INSTDIR` 之下 208 个字符处：

| 路径 | 前缀长度 | 最深文件全长 |
|---|---|---|
| `$INSTDIR` = `D:\soft\DSH Desktop` | 19 | 227 |
| `$PLUGINSDIR\old-install`（卸载暂存） | 53 | **261** |
| `$PLUGINSDIR\7z-out`（安装解压） | 48 | 256 |

261 比 MAX_PATH 多一个字符。NSIS 不支持长路径，所以那次搬移背后的 `Rename` 就是一个普通的 `MoveFileW`，它失败了。用同一个 API、同一个源文件直接测量：

```
dest 261 chars → MoveFileW FAIL win32err=3 (ERROR_PATH_NOT_FOUND)
dest 249 chars → MoveFileW OK
```

没有任何进程占用这个文件：在失败的那一刻对全部 8848 个已安装文件逐个做独占打开，占用数为零。 `un.atomicRMDir` 把搬不动的那个名字回传，卸载段打印 `File is busy, aborting:`——这句话是错的，也正是它把排查带偏的——接着还原已经搬走的文件并 `Abort`，卸载器以 2 退出。 `uninstallOldVersion` 把任何非零退出都当成暂时性故障，重试五次后弹出对话框，而「重试」执行的又是同一次尝试。因为超长的那条路径每次都是同一条，这个循环在数学上不可能收敛。同一个 `Abort` 在对话框被点「取消」时，就表现为 「Failed to uninstall old application files…: 2」。

## 决定

`apps/desktop/build/installer.nsh` 定义 `customRemoveFiles`——模板自己为替换这一段准备的钩子（`uninstaller.nsh`，`!ifmacrodef customRemoveFiles`）。在更新路径上，它把 `$INSTDIR` **作为一个整目录**重命名为它自己的同级兄弟目录（旁边的 `~dsh-old<n>`）再删除，而不是把整棵树逐文件搬进 `%TEMP%`。

重命名目录而不是搬动它的内容，正是修好这个缺陷的关键：目录下每条路径的长度都和原来完全一样，所以无论载荷变得多深，都不会有文件被推过 MAX_PATH。暂存名取同级兄弟而不是在 `$INSTDIR` 后面加后缀，也是同一个理由——`…\DSH Desktop.old` 会让它下面的每条路径都变长，而那正是本次要消除的缺陷。

随之而来还有两个性质。重命名留在安装所在的卷上，因此是一次元数据操作，而不是逐文件搬移做的那 322 MB 跨卷拷贝——在弹窗出现之前，那件事做了五遍，每遍十秒。而且它依然是原子的，并且比它替换掉的更原子：一次重命名要么带走整棵树，要么每个文件都留在原地，不存在需要回滚的半成品。NTFS 允许重命名一个内含运行中映像的目录，这一点是逐文件搬移撑不过去的。

当重命名做不了时——没有可写入的父目录、所有暂存名都被清不掉的目录占着、或者重命名本身被拒绝——退路是 `RMDir /r $INSTDIR`，也就是模板在普通卸载时做的事。这以放弃回滚窗口换取安装能继续走下去；在那里中止，正是产生这个无路可走的对话框的原因。

`customInit` 的进程清扫保留，但它的理由被更正了：需要清掉老进程的原因不是跨卷搬移，而是活着的进程会让目录删除留下一个暂存目录，并让随后的解压覆盖老版本仍在读取的文件。

### Windows 原生打包

`apps/desktop/scripts/package.ts` 现在按 `PATHEXT` 解析子进程名，并通过 `cmd.exe /d /s /c` （自行处理引号）运行 `.cmd`/`.bat` 垫片。`spawn('pnpm', …)` 在 Windows 上是 `ENOENT`，因为 pnpm 安装成 `pnpm.cmd`；而解析到那个垫片之后又会失败于 `EINVAL`，因为自 CVE-2024-27980 的修复以来 Node 拒绝直接 spawn 批处理文件。没有这一步，打包流水线就只能在 macOS 上跑，Windows 安装器可以被构建，却无法在能复现该缺陷的那台机器上既构建**又**测试。

`scripts/gen-desktop-icons.mjs` 按宿主平台分派缩放——macOS 用 `sips`，Windows 通过 PowerShell 用 System.Drawing——并在非 darwin 上跳过 `.icns` 那一半：那里 `iconutil` 没有对应物，产物也无人消费。Windows 构建需要的是 `build/icon.ico`，而它现在能在 Windows 上产出。

载荷的 boot 闸门同样跟随宿主。有一个裁剪后的载荷会被真正启动一次，用来证明裁剪没有切掉运行时内容，而它此前无条件是 macOS 那个；在 Windows 上，那个载荷恰好缺少裁剪掉的 win32 koffi 与 node-pty 预编译产物，于是它会因为原生模块失败，而不是因为这道闸门本来要抓的东西。现在每个目标的载荷只派生一次，启动的是宿主自己那一个。

流水线里的 MAX_PATH 预警也在其成因被弄清之后重新对准了目标。它此前警告的是"安装前缀"；真正起约束作用的是安装器自己位于 `%TEMP%` 下的解压暂存，现在这条消息报告的是距离那个预算还剩多少个字符。

## 验证

失败与修复都在报告问题的那台机器上观测到:`D:\soft\DSH Desktop` 的 rc.11 per-machine 安装,升级到 rc.12。三次运行把两处改动各自的作用分了开。

| 构建 | 清场 | 结果 |
|---|---|---|
| 仅 `customRemoveFiles` | 不在这个安装器里 | 五次 `old-uninstaller.exe`,间隔十秒,随后弹窗,随后退出码 2 |
| 两处改动,第一次运行 | 改名被拒 | 与上一行完全相同,因为退路是有意静默的 |
| 两处改动,第二次运行 | 第一次尝试就改名成功 | 一次 `old-uninstaller.exe`,安装完成,应用启动 |

中间那次运行正是加上改名重试的原因。任何进程只要把某个目录当作自己的当前目录,该目录就不能被改名,而 `un.onInit` 的第一句就是 `SetOutPath $INSTDIR`——于是每一次旧卸载器运行,都站在它即将移除的那个目录里。那次运行开始时,距离上一个安装器放弃只有四秒,那些句柄还在退场途中。宏做了它被设计去做的事(不动旧安装,让 `uninstallOldVersion` 继续),安装于是按老路径失败;而没有任何提示说明这一点,也正是因为退路的 `DetailPrint` 是不可见的——`installer.nsi` 对每一次非静默运行都设了 `SetDetailsPrint none`。

成功那次:`D:\soft\DSH Desktop` 被改名为 `~dsh-old0`,暂存树在 2.0 秒后删除,安装目录只剩留给 `uninstallOldVersion` 的那一个卸载器,该卸载器只运行一次而不是五次,解压出 12452 个文件,`DisplayVersion` 为 `0.1.0-rc.12`,安装目录旁没有留下暂存目录,应用带着它的内置服务端运行起来。

## 备选方案

**改用 `customCheckAppRunning` 替换进程检查。** 这是只看对话框文案得到的第一反应，也是真机证据到手时正在进行中的那版修复。它不可能生效：`CHECK_APP_RUNNING` 在 `installSection.nsh` 里先于 `uninstallOldVersion` 运行，因此能走到卸载循环本身就证明进程检查已经放行。之所以记下来，是因为这句文案还会再次把人引向它。

**改为缩短打包进去的路径。** 超长的那条路径是 `resources\server\node_modules\@earendil-works\pi-ai\node_modules\@mistralai\mistralai\…` ——服务端 deploy 留下的一层嵌套 `node_modules`。把它提升上来能一次性在所有位置买回约五十个字符，包括安装期的解压路径。之所以没把它选作**那个**修复，是因为它没有消除缺陷，只是把载荷挪回限额以内：下一个嵌套很深的依赖就会重新打开这个问题，而且是在另一台机器上。它仍然是买余量的正确做法，而解压路径的余量只剩三个字符（见上表）。

**完全不做暂存，直接就地删除 `$INSTDIR`。** 最简单，而且出于和重命名相同的理由同样不受 MAX_PATH 影响。之所以没选作主路径，是因为它丢掉了模板想要的回滚：被锁住的文件会让 `RMDir /r` 静默跳过并报告成功，把陈旧文件混进新安装里。它被保留为退路——在那里，另一个选项不是回滚，而是卡死。

**让这次搬移支持长路径。** `MoveFileW` 在 `\\?\` 前缀下可以接受超过 MAX_PATH 的路径，但这个调用位于 app-builder-lib 的 NSIS 模板里，而本仓库不改上游——所有定制都只在 `apps/`、插件与组合层。

## 影响

更新路径不再为每次尝试做 322 MB 的跨卷拷贝：移除老版本的代价变成一次目录重命名加一次同卷删除，而不是弹窗之前每次十秒的那种消耗。

回滚在一种情况下收窄了。如果整目录重命名失败，退路会就地删除，没有还原。模板在那里的行为是中止，而中止正是本 Agent Note 要消除的行为。

如果一次安装在重命名与删除之间被杀掉，安装目录旁可能留下 `~dsh-old<n>` 目录。下一次更新会先清掉这个名字再复用，最多尝试二十个名字后走退路。

打包现在能在 Windows 上原生运行，这正是"构建出来的包能被安装验证"的前提。macOS 交叉构建不受影响，仍然只做结构性验证。

安装期的解压路径（`$PLUGINSDIR\7z-out`）本次未处理，它的 MAX_PATH 余量只有三个字符。它有自己的 `$(appCannotBeClosed)` 重试循环（`include/extractAppPackage.nsh`），可由同一机制触发，而且没有可替换的模板钩子。缓解办法是缩短载荷里最深的那条路径。
