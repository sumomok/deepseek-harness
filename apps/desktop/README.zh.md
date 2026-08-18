# @deepseek-ai/dsh-desktop

[English](README.md) | 中文

桌面客户端:Electron 壳,主进程启动内嵌的 `dsh web` 服务器——即 [apps/desktop-server](../desktop-server/README.md) 经 pnpm deploy 物化的闭包,跑在随包捆绑的真实 Node 运行时上(绝不用 Electron 内建 Node,服务端因此保持在被测试的 engines 线上,`node:sqlite` 与原装 N-API 预编译产物照常工作)——等到 `dsh web:` URL 行后在原生窗口里打开所服务的 UI。窗口是纯浏览器面:无 preload、无 Node 集成;外部链接交给系统浏览器。退出时拆除整棵服务器进程树(SIGTERM + 超时升级;Windows 走 `taskkill /T`)。

## 构建安装包

```sh
pnpm exec tsx apps/desktop/scripts/package.ts --mac        # zip + dmg (arm64), runnable on this machine
pnpm exec tsx apps/desktop/scripts/package.ts --win        # NSIS installer (x64), cross-packaged from macOS
```

产物落在 `apps/desktop/dist-app/`。流水线按 python/sdk-runtime 配方暂存服务端(legacy hoisted `pnpm deploy`、恢复 hoist、物化符号链接),删掉本机编译的原生 `build/` 树以强制走多平台预编译产物,补齐 macOS 安装时跳过的平台分包可选依赖的 win32-x64 成员,再按平台暂存 Node 运行时(`--skip-repo-build` / `--skip-deploy` 复用既有产物)。

## 更新机制

已安装的客户端读一个静态更新源——一个 electron-builder `generic` provider 目录,里面是清单与它们点名的产物:

```
https://lhr.ink/dsh-updates/win/     latest.yml  + the NSIS installer + its blockmap
https://lhr.ink/dsh-updates/mac/     latest-mac.yml + the zipped app
```

这里没有更新服务:清单**本身**就是判断过程,所以 nginx 发一个目录已经把它整个实现了。更新源地址存在于两处——生成清单与打包内 `app-update.yml` 的 `electron-builder.yml`,以及运行时读取它们的 `src/updater.ts`——迁移更新源要同时改这两处。`channel: latest` 在两端都显式写出;默认行为会拿运行版本的预发布段给渠道命名,那会让渠道名随发布周期的每个阶段改名。

**Windows 原地安装,分三步。**静默检查(启动后 15 秒、此后每四小时,以及 **帮助 → 检查更新**)先征询下载。同意后在后台下载,配一个可以随手关掉、关掉也不会中断下载的小进度窗。下载完成后再征询重启安装。**没有用户的决定就不会发生安装**,退出时或别的任何时候都一样:`autoInstallOnAppQuit` 关闭,应用只在有人点了「重启安装」之后的几秒里替换自己。被拒绝的安装留在盘上,只会在下次启动与菜单手动检查时再被提起——别处没有。

**那次点击之后的执行不再打断用户**,这与"不问自装"是两回事。`quitAndInstall(true, true)` 给安装程序传 `/S --force-run`,于是它跳过安装模式页、进度页与完成页——这些页面问的正是那次点击已经回答过的问题——装进它在 `.onInit` 里从注册表 `InstallLocation` 读到的目录,装完再把应用拉起来。两个参数都不可少:assisted 安装器的自动启动分支是 `${if} ${isForceRun} ${andIf} ${Silent}`,所以只给 `/S` 会装好但把用户晾在空屏前。

**macOS 只发现,再交接。**Squirrel.Mac 只为已签名应用暂存更新,而这些构建没有证书,所以 macOS 自己比对版本,改为用系统浏览器打开下载。该提示只出现在启动时或手动检查时,绝不在会话中途。

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

产物是未签名的开发构建:macOS Gatekeeper 在非构建机上需要右键打开(或 `xattr -dr com.apple.quarantine`),Windows SmartScreen 会弹未知发布者提示。Windows 包只做了交叉构建与结构校验——交付前务必在真实 Windows 机器上冒烟。

这也框定了更新源能承诺什么。TLS 认证服务器,清单里的 sha512 把产物绑定到清单,所以传输途中无法被做手脚。产物本身未签名,于是对 `/var/www/dsh-updates` 的写权限就等于对每个客户端下一个安装程序的写权限,而两个操作系统都不会为收到的东西背书。补上这一环要靠代码签名——Windows 的 Authenticode、macOS 的 Developer ID 加公证——那也正是能让 macOS 改为原地安装而非交接的那件事。

## 服务器环境

服务器在用户主目录启动,环境为 GUI 继承环境加标准 shell PATH 条目(macOS GUI 应用以 launchd 的极简 PATH 启动)。`DEEPSEEK_API_KEY` 走常规凭据链(环境变量 → 托管存储 → `.env`),首启无 key 也能进 UI,在模型设置页补录。服务器输出追加到应用日志目录的 `dsh-server.log`,由 **帮助 → 查看日志** 打开;启动页只报告启动阶段,不再显示路径。

## Known Limitations and Deferred Work

- macOS 无法原地安装更新:未签名构建不在 Squirrel.Mac 愿意暂存的范围内,所以客户端只发现新版本并打开下载。前置条件是代码签名,不是打包工作。
- Windows arm64 与 Linux 桌面目标未构建;node-pty 预编译已覆盖 win32-arm64,缺口只是打包工作。
- 开发启动(`pnpm --filter @deepseek-ai/dsh-desktop exec electron lib/main.js`)用的是检出目录的已构建 CLI 和 PATH 里的 Node,不是暂存资源。
