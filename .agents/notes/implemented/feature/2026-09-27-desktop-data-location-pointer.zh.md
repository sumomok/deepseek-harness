# Agent Note: The desktop names its data directory with a pointer, a marker, and a link

Status: implemented

[English](2026-09-27-desktop-data-location-pointer.md) | 中文

## 问题

有人要求把桌面端的数据放到另一块磁盘上。服务端的每一条路径都在加载时经 `dshHomePath()` 与 `resolveDshHome()` 从 `DSH_HOME` 推出,服务端子进程又继承壳的环境,所以在拉起子进程之前导出一个值,就能让整个服务端换位置,不需要核心补丁。壳缺的是:一份数据在哪里的持久记录;一种办法,把这份记录和只是恰好在同一路径上的文件夹区分开;以及对另外两个主目录读者的回答——没有 `DSH_HOME`、读 `~/.dsh` 的终端 `dsh`,和使用者自己设置的 `DSH_HOME`。

这次改动定下这三件事。数据的搬迁本身——复制、校验、删除旧目录和进度窗口——留给后续改动。

## 决定

**userData 里的指针与数据目录里的标记互相认定。**`apps/desktop-shell/src/data-location.ts` 在 Electron 的用户数据目录下维护 `data-location.json`,含 `version`、`path`、`dataId`、`lastSeenEnv` 与 `movedAt`,经落盘后的临时文件写入,上一份保留为 `data-location.json.bak`。数据目录里的 `.dsh-data-id` 存着同一个 UUID。指针单独成文件,而不是 `desktop-state.json` 的一个字段,因为那个文件的约定是缺了、读不了都不影响运行,而指针是启动的前提。userData 在更新后保留;Windows 上卸载后也保留,因为 `deleteAppDataOnUninstall` 没开。

**没有指针时启动不变;目录不见了绝不回退。**没有指针时,主目录按以往每个版本的规则解析——进程里非空的 `DSH_HOME`,否则 `~/.dsh`——唯一的写入是给已有的主目录补一个标记,好让以后的搬迁认得它。指针指的目录不见了,或身份不同、没有身份时,启动停在启动页上,给出 重试、选择数据所在的文件夹…、退出;选中的文件夹只有带着指针的身份才被接受。回退到 `~/.dsh` 会让一个空的主目录看起来像数据丢了,之后两个目录还会各改各的。

**更新的 `DSH_HOME` 覆盖指针。**发布负责人起初定的是指针优先、冲突的变量只做提示,2026-09-27 改成「新的覆盖旧的」。有指针的每次启动都读一次 `DSH_HOME`——先读进程环境,但排除壳自己导出的值(由 `DSH_DESKTOP_POINTER_HOME` 标明),再读 macOS 的登录 shell(`$SHELL -ilc`,随机标记包住,五秒上限)或 Windows 的用户环境变量(经 PowerShell)——再与 `lastSeenEnv` 比较。值不同时,若目录带标记或含有 `sessions/`、`profiles/`、`attachments/`、`storages/`,就跟过去;否则启动窗口在 使用这个新位置 与 保持原位置 之间询问,被拒绝或被采用的值成为 `lastSeenEnv`,之后不再问。读不到值时不动 `lastSeenEnv`,因为探测失败不能证明变量被删了。只有存在指针时才探测,所以从没搬过数据的安装不付出启动 shell 的代价。

**写 `DSH_HOME` 每个平台只动一处存储,从不改使用者自己写的行。**`apps/desktop-shell/src/terminal-env.ts` 在 Windows 上经 `[Environment]::SetEnvironmentVariable(..., 'User')` 写用户变量,它会自己广播 `WM_SETTINGCHANGE`,值放在子进程环境里而不在命令行上;不解析 `reg query`,因为它的输出是 OEM 代码页。macOS 上它在 `~/.zshrc`、`$ZDOTDIR/.zshrc` 或 `~/.bash_profile` 里只拥有 `# >>> DSH data location >>>` 与 `# <<< DSH data location <<<` 之间的一段,先备份,再在链接目标处原子替换。块外的 `DSH_HOME` 赋值会让这次写入作罢,并连同行号记进日志:把块追加在它后面会悄悄盖掉使用者的那一行,改它则是改了壳不拥有的文件区域。fish 与其他 shell 不写。不用 `launchctl setenv`,因为它的值在块被删掉后仍活到重启,会继续把旧位置喂给每个从访达打开的应用。启动页上选中的文件夹按这个方式写入;被拒绝的 `DSH_HOME` 不改写。

**`~/.dsh` 保持为指向数据目录的链接。**发布负责人要求搬迁之后终端里的 `dsh` 看到同一份数据。只要指针指向别处、而 `~/.dsh` 不存在或是指向别处的链接,`apps/desktop-shell/src/home-link.ts` 就把 `~/.dsh` 做成符号链接,Windows 上做成目录联接;旧链接用 `unlink` 删掉,从不跟随。那里是真实目录或文件时原样保留并记进日志,并按是否带着这份数据的标记区分,因为替换它就等于删掉它。在 macOS 上用一个 `~/.dsh` 悬空的临时 `HOME` 探测过上游 CLI,临时目录之外的写入由 `sandbox-exec` 拒绝:`--profile headless`、`plugin list` 与 `dump-config` 都在主目录下第一次 `mkdirSync` 时以 `ENOENT` 失败,链接处与链接目标处都什么也没创建,所以悬空链接不需要核心补丁。

## 考虑过的替代方案

**不留链接,在文档里写明终端 `dsh` 会看到一个新的空 `~/.dsh`。**被发布负责人否决:CLI 必须看到同一份数据。

**无论 `DSH_HOME` 是什么都以指针为准。**被发布负责人后来的规则取代:指针写下之后使用者设的值是更新的决定。

**数据目录不见时回退到 `~/.dsh`。**否决:空主目录读起来像数据丢了,之后两份副本各自变化。

**每次启动都探测登录 shell。**否决:这给从没搬过数据的安装的每次启动都加了一次 shell 启动,而对它什么都不改变。

## 后果

数据位置的提示是盖在启动页上的消息框,因为那个页面是没有 preload 与 IPC 的 `data:` 文档。`settleDataLocation` 返回这次启动定下的内容——主目录、显式值及其来源、链接结果——留给后续改动加的设置入口。

位置改变之前就导出了 `DSH_HOME` 的终端会一直带着旧值,直到重新打开;从这样的终端启动的应用会把这个值当成更新的值。只有应用自身环境里有 `$ZDOTDIR` 时才认它。

Windows 路径只由记录式替身覆盖:目录联接调用、PowerShell 脚本及其 UTF-8 输出、`WM_SETTINGCHANGE` 是否到达资源管理器,以及 Windows 上的 CLI 如何报告悬空的联接,都只有在真实 Windows 机器上才知道。

## 相关

[rc.34 之前的设置导入](2026-09-26-desktop-settings-yaml-pre-import.zh.md) 是另一个在服务端读主目录之前运行的启动步骤。
