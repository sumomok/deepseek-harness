# Agent Note: macOS 用一张没人信任的证书完成自更新

Status: implemented

[English](2026-08-19-macos-in-app-update-self-signed.md) | 中文

## Problem

[桌面更新通道](2026-08-18-desktop-update-channel.md)在 Windows 上就地安装,在 macOS 上只做移交:客户端发现新版本后把下载交给浏览器,由用户自己解压、拖进「应用程序」覆盖旧版。那份记录给出的原因是 Squirrel.Mac 只为已签名的应用暂存更新。

原因是准确的,但它底下的机制值得说清楚,因为它决定了修复必须产出什么。Squirrel 只接受满足**当前运行**应用 designated requirement 的替换 bundle。未签名的 Electron 构建带的是工具链链接器留下的 ad-hoc 签名——`flags=0x20002(adhoc,linker-signed)`、`Sealed Resources=none`——它的 designated requirement 退化成 `cdhash H"…"`,锁死单个二进制,此后任何构建都不可能满足。真正的签名会把这条要求变成 `identifier "dev.dsh.desktop" and certificate root = H"<指纹>"`,同一张证书签出的每个构建都满足它。

一直以为挡在前面的是 Apple 每年 $99 的 Developer ID。不是。证书随签名的 CMS 结构一起走,更新方的机器从不去钥匙串里查它,所以**一张没有被任何人标记为信任的自签名证书**就能产出 Squirrel 接受的要求。这一点已经端到端验证过:删掉证书所在的整个钥匙串、杀掉 `trustd` 缓存,更新照样跑通。

## Decision

macOS 就地安装更新:用 `MacUpdater` 读 Windows 用的同一个 generic feed,构建由本产品自己的自签名证书签署。

### 签名由 afterPack 钩子执行,不走 electron-builder

electron-builder 用不了这张证书。它通过 `security find-identity -v -p codesigning` 解析身份,而 `-v` 只保留通过信任评估的身份——未信任的自签名证书被报成 `CSSMERR_TP_NOT_TRUSTED` 并过滤掉,于是 builder 找不到身份,直接跳过签名。

`codesign` 没有这条规则。它用未信任身份签名并以 0 退出,`codesign --verify --deep --strict` 对结果通过。它真正要求的是持有该身份的钥匙串必须在**用户的钥匙串搜索列表**里:`--keychain` 是在这个列表内做收窄,而不是往里添加,所以列表之外的钥匙串里的身份,无论怎么请求签名都是 `no identity found`。区别全在这里,而此前它被误判成了信任问题。

因此 `scripts/sign-mac.cjs` 每次构建新建一个钥匙串,导入 PKCS#12,把该钥匙串加到用户搜索列表前面,签名,再在 `finally` 里还原搜索列表并删除钥匙串。`electron-builder.yml` 保留 `mac.identity: null`,让 builder 自己的签名过程根本不运行。钩子选 `afterPack` 而不是 `afterSign`,原因是机制性的:`doSignAfterPack` 只在真的签了名时才发 `afterSign`,身份为 null 时这个钩子永远不触发。`afterPack` 到 zip/dmg 目标之间没有任何东西改动 bundle——没有 `electronFuses` 配置时 `doAddElectronFuses` 立即返回,而配置里没有。

身份默认从 `~/Library/Application Support/dsh-desktop-signing/` 读取,可用 `DSH_MAC_SIGNING_P12` 与 `DSH_MAC_SIGNING_P12_PASSWORD` 覆盖。身份缺失时**构建失败**;`DSH_MAC_SIGN=0` 是显式要一个未签名构建的方式。在这里保持沉默才是昂贵的失败:未签名的构建发到 feed 上无法替换已经装好的签名版本,而且在某次更新失效之前不会有任何东西提示这件事。

证书有效期 20 年。designated requirement 钉死它的指纹,所以轮换证书会切断每个已安装客户端的更新链——出厂的这张证书必须比产品活得久,而不是到期续签。

### 三层,由一次 `existsSync` 决定

`src/updater.ts` 为每次检查选一条路径,第一条成立的就是执行的那条:

1. **就地安装**——Windows 恒定;macOS 在 bundle 已签名时。
2. **下载页**——未签名的 macOS 构建行为与之前完全一致,走未改动的 `checkGeneric`。
3. **回退**——就地路径在运行期失败时,本次运行剩余时间降到第二层,并在那一层重跑同一次检查,让一次检查仍然只给出一个答案,而不是以错误框收场。

签名与否由对 `Contents/_CodeSignature/CodeResources` 的 `existsSync` 回答:签名会封存 bundle 的资源并写出这个文件,ad-hoc 链接器签名什么都不写。起一个 `codesign` 子进程能回答同一个问题,而这段代码在每次启动的首次检查上都会跑。

第三层的降级是刻意粗粒度的——Squirrel 拒绝与连接中断一视同仁地降级,因为区分二者意味着匹配错误消息文本——并且只在本次运行内有效。

### macOS 上的对话框不再是 sheet

在 macOS 上,带 parent 的 `dialog.showMessageBox` 是 NSAlert **sheet**,而 sheet 会在任何东西抬起其父窗口时结束。`BrowserWindow.focus()` 就足够,随后 Electron 会报告按钮下标 0,如同它被点过一样。

每一条回到应用的路径都会调用 `revealMainWindow()`——Dock 图标、点击通知、二次启动、托盘。在这次改动之前,这只会误答一个移交对话框。而当下标 0 后面接的是就地安装器时,它意味着**点一下 Dock 图标就会装上没人同意的更新**,恰恰是[更新通道](2026-08-18-desktop-update-channel.md)承诺不会发生的那一件事。已手工验证:提示框开着时,仅仅 `open -a` 就启动了下载。

`ask()` 现在在 macOS 上不传 parent,此时的无父对话框是 app-modal 的告警面板:随应用一起来到前台,只有按钮能结束它。Windows 保留带 parent 的对话框和当初的理由——无父的顶层窗口会被外壳放到用户正在做的事情后面。

### 那一次点击的代价花在哪

在 macOS 上,`update-downloaded` 是在 electron-updater 自己的下载完成时触发的,不是更新已暂存时。Squirrel 是在 `quitAndInstall` 才拿到文件的;而 `autoInstallOnAppQuit` 是关的——本产品保持关闭,以保证用户决定之前什么都不暂存——所以点击之后的一切都算在这次点击的账上:

| 分段 | 实测 |
|---|---|
| 点击 → 服务停止(`prepareQuit`) | 空闲时 0.06–0.54 s;由 `STOP_TIMEOUT_MS` 封顶在 10 s |
| Squirrel 从 electron-updater 的本地代理把 zip 取回、解压、验签 | 空闲时 4.8–6.0 s,磁盘打满时 28.8 s |
| ShipIt 换包并重新拉起 | 8.7–12.5 s |
| **点击 → 新窗口** | **空闲 14.1、16.0、18.1 s;负载下 42.2 s** |

中间那段并不是看上去的 HTTP 二次投喂。在同一份产物上直接测量:`ditto -xk` 解压 183 MB 的 zip 用 3.0 s,`codesign --verify --deep --strict` 校验 489 MB 的 bundle 用 1.0 s,而回环上的传输只是二者的零头。它是磁盘,并且随争用放大。

这段时间里屏幕大多是空的,因为 ShipIt 要等同一 bundle id 的所有进程退出才开工——于是本应用没有任何东西能留在屏幕上解释这段等待。安装提示(`progress-window.ts` 的 `showInstalling`)在拆除服务**之前**就立起来,写明预计多久、以及不要强制退出;主窗口随之隐藏,因为它的服务马上就没了。Windows 两者都不给:同一次点击一秒之内,NSIS 安装器就画出了自己的进度条。

### 其余

`blockOnMac` 没了。macOS 上的强制更新现在与 Windows 一致——不询问直接下载,然后只给「重启安装」——下载页形态的拦截只留给无法就地安装的构建。

`FEED_BASE` 读 `DSH_UPDATE_FEED`,默认是已发布的 feed。要点不是可配置性,而是让生产 URL 成为本模块唯一的 URL 字面量,这样测试端点就无法因为忘了还原而被提交。指向本机地址的构建发出去以后什么都不报,只是从此再也找不到更新。

`publish-update.ts` 现在为两个通道都上传 blockmap,而不只是 Windows。差量下载读的是**两份** blockmap——新构建的,以及客户端当前版本的那份,后者的 URL 由 electron-updater 把新产物名里的版本号替换出来。因此每个已发布版本的 blockmap 都必须留在 feed 里,只要还可能有人从它升级;脚本里没有任何删除动作,并且现在会报告被替换的那个版本的 blockmap 是否还在。

## Alternatives considered

**Apple Developer ID 与公证。** 对要交给别人的软件,这是正确答案:它满足首次启动的 Gatekeeper,自签名做不到。它要每年 $99 和一个 Apple 账号,而买到的东西本产品并不需要——更新路径校验的是签名里的证书,不是 Apple。以后可以换成 Developer ID 证书,代价是一次强制的手工更新,因为 designated requirement 钉死的是证书根。

**在构建机上信任这张证书。** 这是对 `find-identity -v` 失败最直觉的解读,也是先前一轮排查得到的结论。它错了两次:它需要构建过程无法完成的 GUI 授权,而且没有必要——上面的搜索列表实验表明 `codesign` 从不查询信任设置。

**用 `--keychain` 代替改动搜索列表。** 更想要的方案,但它不工作:钥匙串已解锁、但不在搜索列表里时,`codesign --keychain <路径>` 依然是 `no identity found`。搜索列表的改动被限制在签名这一步并在 `finally` 里还原;硬杀进程可能留下一条指向已删除文件的陈旧条目,难看但无害。

**按 Apple 的建议由内向外逐层签名,而不是一次 `--deep`。** `--deep` 不被推荐,主要是因为它把同一套 entitlements 应用到所有嵌套代码。而这里要的正是这个:本 bundle 里每个二进制拿同一组三条 entitlements。一次签名在 15,778 个文件上耗时 3 s,产出的 bundle 通过 Squirrel 校验所用的那组标志。

**保持 `autoInstallOnAppQuit` 关闭**,代价是把约 5 s 的暂存算在点击的账上;打开它会把这段工作挪到下载刚结束的时候。它保持关闭,因为它同时也是让 Squirrel 预取的开关,而一个已经暂存好更新的构建,离装上用户没要求的更新就只差一步。要重新考虑,必须连同这条不变量一起重新陈述。

**给 `reveal()` 加保护,而不是去掉对话框的 parent。** 那样 sheet 还在,只是把会解散它的动作压住——但 `reveal()` 是用户在要求看到应用,而且以后每一个调用者都得记住这条规则。去掉 parent 是把机制本身移除。

**用一个独立的 overlay 进程盖住黑屏。** 在这次改动之前就已按实测否决:ShipIt 要等同一 bundle id 的所有进程退出,而带着这个 id 的 overlay 本身就在它等待的名单上。它把黑屏从 12 s 拉长到 26 s。

## Consequences

已安装的 macOS 客户端现在会自更新,两个平台的差别只剩安装过程长什么样。这张证书是一份 20 年的承诺:它的私钥就是更新链,弄丢意味着每个已安装的客户端都需要手工替换,泄漏则意味着持有者能造出这些客户端接受的 bundle。它存放在仓库之外,`apps/desktop/.gitignore` 以文件类型兜底拒收。

Gatekeeper 没有变化:自签名且未公证的应用,由**浏览器**下载时首次打开仍需右键打开。由 Squirrel 装上的更新不带隔离属性,什么都不需要。

hardened runtime 是开的,带 electron-builder 自己那三条 entitlements(`allow-jit`、`allow-unsigned-executable-memory`、`disable-library-validation`)。`Contents/Resources/` 下内置的 Node 二进制与 N-API 插件保留各自的签名——`--deep` 把它们当资源、按哈希封存而不是重新签名——这也是必须关掉 library validation 的原因。

## Testing

在 `127.0.0.1` 的本地 feed 上验证:rc.13 由其发布用的 zip 安装,rc.14 作为更新提供;全程没有信任过该证书。

完整跑通四次 rc.13 → rc.14:提示 → 进度窗 → 安装询问 → 安装提示 → 自动重启,事后已安装的 bundle 报告 `0.1.0-rc.14`、`satisfies its Designated Requirement`,以及同一个证书根。强制路径用 feed 里的 `minimumVersion` 走过:启动闸拦住、下载未经询问就开始、安装对话框只给一个按钮。未签名层用真正的 `DSH_MAC_SIGN=0` 构建走过,它走的是下载页路径。失败层用停掉 feed 服务器走过:检查降级并留下一行日志,启动闸放行,没有出现任何错误框。

Dock 激活缺陷及其修复也是这样验证的——提示框开着时,`open -a` 在修复前启动了下载,在修复后什么也没发生。

这里没有覆盖的:手动「检查更新」菜单项的「无法检查更新」对话框,本次改动不触及它的代码路径;Windows 上的一切,除共享的 updater 构造外均未改动;以及任何针对已发布 feed 的运行,那是刻意不去碰的。
