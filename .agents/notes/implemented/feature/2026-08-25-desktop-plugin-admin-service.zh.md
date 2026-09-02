# Agent Note: The shell lends its package manager, so a plugin can be updated without a terminal

Status: implemented

[English](2026-08-25-desktop-plugin-admin-service.md) | 中文

## Problem

桌面客户端的用户装不了任何东西,也更新不了任何东西。

进入 profile 的每一条路都要经过 `dsh plugin --profile <name> add <package>`,而 `apps/cli/src/plugin.ts` 为它拉起的是 PATH 上一个裸的 `pnpm`。桌面客户端的前提正是一个没有终端的人,而它发往的那些机器上没有包管理器:那次拉起会得到 `ENOENT`,CLI 打印出 `pnpm not found on PATH — install pnpm to manage profile plugins`,那是一句写给开发者看的话。

在插件只随应用一起到达的年代,这还撑得住。插件开始从应用之外到达之后,就撑不住了。[那次一次性迁移](2026-08-25-desktop-web-profile-migration.zh.md)把用户自己 `web` profile 里的插件带进了桌面 profile,于是一个桌面安装现在会组合来自 npm 的包——它们有自己的发布节奏,而那台机器上没有任何东西能把它们挪到更新的版本。修好了 bug 的插件依旧是坏的;为了某个功能才装的插件,依旧停在那个功能出现之前的版本。

有两件事让答案比「加一个安装按钮」窄得多。profile 是用户数据,而应用里的页面能经由 `/api` 够到它,所以任何会安装东西的路径都不能被那边操纵——一个能指定 specifier 的调用方,就能指定一个 git URL 并安装任意代码。而且安装必须走到这台机器配置的那个仓库:处在镜像、代理或私有仓库之后的客户,把这些写在 `~/.npmrc` 里,任何自己去请求 URL 的做法都会把这三样一并绕过。

## Decision

壳打开**第二个本机服务**,与[渲染服务](2026-08-22-desktop-render-service.zh.md)并列、带着自己独立的 token,把安装包自带的那份包管理器借给服务端。`apps/desktop/src/plugin-admin-service.ts` 拥有它;`@haoran/dsh-plugin-updates` 是消费它并画出设置标签页的那个插件,并从 0.1.0-rc.23 起作为内置插件分发,所以全新安装不必先装什么就已经有这个标签页。

**两个服务,而不是一个被扩大的服务。**渲染 token 换来的是一扇隐藏窗口里的像素,截图工具每次调用都握着它。把安装路由挂在同一个 token 之后,就等于让每一个持有它的人都能改变这个应用运行的是什么。所以壳另铸一个 32 字节的 token,在另一个临时 loopback 端口上监听,并把两者只经由 `DSH_DESKTOP_PLUGIN_ADMIN_ENDPOINT` 与 `DSH_DESKTOP_PLUGIN_ADMIN_TOKEN` 传给服务端那一个子进程——绝不放进壳自己的 `process.env`,这也正是让它们进不了这个服务自己拉起的 pnpm 的环境的原因。两个服务共享的是 `apps/desktop/src/loopback-service.ts`:loopback 地址、`mintToken`、常数时间的 `authorized`、带上限的 `readBody`、两个回答写入器,以及 `listenLoopback`。任何与路由有关的东西都不在那里。

**Typert 与 Host 头都被否决为传输通道。**会改东西的调用必须有闸,而 `PRIVILEGED_METHODS` 管的是 JSON-RPC 那面而不是 Typert 网关,所以一条只走 Typert 的路由,凡是被 `/api` 放进来的东西都够得着。Host 头的围栏则可以被反向代理伪造。带每次启动一换的 bearer token 的 loopback 监听,是壳手上已经有一份能用实例的那道围栏,而它「404 先于 401」的次序意味着没有凭据的调用方对这里提供什么一无所知。

**调用方点名的是一个包,而不是一个 specifier。**这是会改东西那条路由的全部安全立场,而它是三道彼此独立的检查,都在处理函数里、都在每次调用时做:

- `profile` 是拿去和 `['desktop', 'web']` 比对,而不是拼进路径,所以任何 `..` 与任何绝对路径都点不到一个目录。
- `version` 必须匹配 `EXACT_VERSION`——一个裸的 `major.minor.patch`,可带预发布与构建元数据。pnpm 在同一个位置上接受 `latest`、`^1.2.3`、`git+ssh://…`、`file:../…`、`npm:other@1.0.0` 以及裸的 tarball URL,它们每一个都会装上没人点过名的代码。
- `name` 必须是该 profile 清单自己 `dependencies` 里的一个键,**在处理函数里从硬盘读取**,既不采信请求,也不在启动时缓存。那个集合恰好就是一个 profile 装过的包。壳植入的内置插件写在 `dsh.profile.bundles` 里而没有依赖项,所以它们天然落在可更新集合之外,而不是靠一份这段代码得自己维护的名单——该 profile 从未装过的包也一样。

**没有键盘前的那个人点头,什么都装不上。**`/update` 与 `/relaunch` 在做任何事之前,先以主窗口为父窗口打开 `dialog.showMessageBox`。原生模态框是 web UI 唯一既盖不住、也替不了它作答的那个界面,而这一点要紧,因为请求安装的那个页面,也正是一个被攻陷的插件会用来画自己那个确认框的页面。对话框携带调用方可选的那行 `warning`,先剥掉控制字符再截断,因为那段文字是一个插件写的、却要拿给一个人看。同一时刻只跑一次安装;第二次会被答以 503 而不是排队。

**pnpm 就是随包发出的那份。**`scripts/package.ts` 把仓库自己 `packageManager` 钉住的那个版本——这个事实只有一个出处——用已经在给 Windows 原生变体用的那套 `npm pack` 加解包手法,暂存到 `staging/pnpm`。`scripts/after-pack.cjs` 把它拷到自带 Node 旁边的 `resources/runtime/pnpm`,因为 pnpm 发布的目录树里有一个 `dist/node_modules`,而 electron-builder 的 `extraResources` 拷贝器硬性排除 node_modules 目录树——服务端闭包走同一条路,理由也一样。服务随后在 `runtime/node` 下运行 `runtime/pnpm/bin/pnpm.mjs`,参数放在数组里,绝不经过 shell。它落在 `runtime/` 而不是服务端闭包旁边,是因为 `bundle-closure.ts` 的清扫会删掉 `server/` 下闭包不引用的任何东西。开发启动不带这份资源,会退回到 PATH 上的 `pnpm`,那是开发者自己那份,到不了任何用户。这里没有任何东西直接请求仓库地址,所以这台机器自己的 `.npmrc` 服务于每一个请求。

**说明一次安装成没成的是硬盘上的版本,而不是退出码。**这一条是把做完的功能真跑起来才发现的,而不是读出来的;它在每一次全新安装上都是一个真实缺陷:`pnpm add` 会在装得完全正确的同时以 `ERR_PNPM_IGNORED_BUILDS` 退出码 **1** 结束——在任何还没回答过 pnpm 那个构建审批问题的 profile 上都会。这个壳植入的每一个 profile 都是这样的 profile——模板写了 `nodeLinker` 与 `autoInstallPeers`,没写 `allowBuilds`——而任何依赖树里带有安装脚本的插件都会踩到它,`dsh-better-sidebar` 就经由 `node-pty` 踩到了。把退出码当结果来读,会在新版本已经躺在硬盘上时告诉那个人更新失败了,并且连撤销记录与重启提示一起带走,之后那一行还会不声不响地回到「已是最新」那一组里。所以 `/update` 在运行之后重新读一遍那个包自己的清单,回答 `installedVersion`,由调用方拿它和自己要的版本比对。退出码仍然一并报告,因为它点名的是那句抱怨。这与 `outdated` 那条路由本来就遵循的规则是同一条——pnpm 在那里恰恰是「有东西过时」时才退出 1——只是把它用到了会改东西的那条路由上。

**不再是 bundle 的包会被取出来。**安装成功之后,服务会重新读一遍被更新那个包的清单。一个不再声明 `dsh.bundle` 的版本仍然解析得到,于是 `loadProfile` 过得了 `resolveBundleDir` 这一关,却在之后拒绝这个层,而那会终结整次启动——迁移自己那趟修复存在的理由,正是同一个失败。这个名字会被从该 profile 的 `dsh.profile.bundles` 里移除,并在回答里说出来。依赖项保持不动:包还装着,而这件事说的是 Loader 挂载什么。

## The reachable surface

四条 `POST` 路由,全都要 bearer 认证,全都是 JSON。`/outdated` 与 `/peers` 是读:它们在某个 profile 目录里运行 `pnpm outdated --json` 与 `pnpm view <name>@<version> peerDependencies --json`,把 pnpm 打印出来的东西原样交回——解析了但不重塑——旁边附上 `exitCode`、`signal` 与截断过的 `stderr`。报告退出码而不是解读它,是承重的:`pnpm outdated` **恰恰在有东西过时的时候**退出码为 1,所以把退出码当失败读的调用方,会恰恰在有东西可报的时候什么都不报。`/update` 与 `/relaunch` 是先问用户的那两条。

由插件决定一个包归属哪个 profile,因为那个决定关乎迁移而不关乎壳。它读桌面清单的依赖、web 清单的依赖,以及 `web-migration.json`;记录里有、而 `web` profile 至今仍在声明的名字,归 `web` 所有——装进桌面 profile 会用第二份副本顶掉壳做的那个链接,而 `web` profile——仍然是 `dsh plugin --profile web` 够得着的那一个——会被留在旧版本上。**`web-migration.json` 现在被这个仓库之外的组件读取了。**`apps/desktop/src/profile-seed.ts` 写它,插件直接读它;只读 `migrated` 这个数组,而一个解析不了的标记文件被读作「没有名字」。

## Alternatives considered

**做一个调用 CLI 的 `dsh plugin` 图形界面。**CLI 已经拥有初始化、pnpm 调用与 reconcile,壳只需要把它跑起来。否决,理由正是这整个功能存在的那个事实:`runPlugin` 拉起的是 PATH 上一个裸的 `pnpm`,而机器上没有。让 CLI 接受一个 pnpm 路径,等于把「有没有随包发出一份包管理器」这个决定推给一个根本不知道答案的二进制,还等于给模型递上一个能装包的子进程。

**让插件自己运行 pnpm。**它知道 profile 目录和包名,桌面告诉它 pnpm 在哪就行。否决,因为那把围栏挪进了模型运行所在的那个进程。确切版本与依赖成员这两道检查的全部意义,就在于它们由一个插件绕不过去的东西来执行;而一个握着包管理器路径的插件,是一个能装任何东西的插件。

**用 `PRIVILEGED_METHODS` 在 Typert 上给会改东西的调用加闸。**不用第二个监听、不用第二个 token、不用写一份协议文档。否决,因为那份名单管的是 JSON-RPC 那面而不是 Typert 网关,所以它根本给这个调用加不上闸;那道围栏会只是一句注释。

**用 `Host` 头代替 bearer token 做围栏。**比 token 便宜,而且 loopback 绑定本身已经限制了范围。否决,因为反向代理可以随意伪造 `Host`,而这个部署正是客户可能会放在反向代理之后的那一种。

**这份构建不满足其 peer 的更新一律拒绝。**兼容性检查最强的版本:绝不安装一个自称跑不起来的东西。否决,因为那个范围是插件作者声明的,而这里没有任何东西能证明它。harness 正处在候选版本线上,按普通 semver,`0.1.1-rc.2` 不满足 `^0.1.0-rc.8`,所以拒绝会以一条「字面正确、结果常常不对」的规则挡下大多数真实更新。它改为警告,只用一句话,由那个人来决定。

**关于 peer 什么都不查。**更简单,而且 pnpm 本来就会一声不吭地装上不匹配的插件。否决,因为那份沉默正是问题所在:profile 关掉 `autoInstallPeers`,让 peer 经由扁平回退解析进安装目录,于是不匹配要到*下一次启动*才发作——发作在一扇窗口里,而那扇窗口的设置页正是那个人刚才在用的。安装之前那一句话,把一桩谜案变成一个决定。

**给植入的 profile 模板加上一个 `allowBuilds` 答案,让 pnpm 退出 0。**它从源头上消掉了那个假失败,而且只有两行。否决,因为那份模板属于 `@deepseek-ai/dsh-app-boot`,并且被 `profile-seed.spec.ts` 拿去和 `initProfile` 自己的输出逐字比对,所以在这里改它意味着要改上游、还要改那次比对的两边——而且那等于替用户回答了一个构建审批问题,对象还是这个壳没见过的包。读硬盘上的版本修掉的是同一个缺陷,却没有替他们决定任何事,而且它覆盖的是「pnpm 在安装成功之后仍以非零退出」的所有情形,而不只是被发现的那一种。

**一次性全部更新。**一个按钮,没有行。否决,因为失败的批处理会把 profile 留在一个没人选择过的状态里,而撤销只有一次,不是一摞。

**让浏览器点名版本。**最顺手的 API,而且标签页本来就知道它显示的是哪个版本。否决,因为那会把一个 specifier 放上线路。`update(name)` 安装的是主机自己那次检查查到的版本,`rollback()` 安装的是记录里存着的版本;任何版本都不经过网关,而这正是让壳那道 `EXACT_VERSION` 检查成为第二道围栏、而不是唯一一道的原因。

## Consequences

桌面用户可以在设置里,用两次点击加一次原生确认,更新自己装的插件——在一台没有终端、没有包管理器的机器上。他们在那里做不到的是装新东西:那是一份不同的列表配一道不同的闸,应该有自己的标签页。

载荷每个平台大约增大 19 MB,压缩成产物后约为 4-5 MB。pnpm 以单个 tarball 发布,携带它全部四个平台的原生模块,所以 macOS 构建也一并带上了 Windows 的那些;拆开它们意味着重新推导 pnpm 自己的打包方式,而载荷闸并不清扫 `runtime/`。

壳现在拥有一个会安装包的界面,而针对它的审计是三行校验加一个原生对话框,而不是对调用它的那个插件做一次评审。`apps/desktop/README.zh.md` 写明了协议,那是第二个实现要照着写的东西。

`web-migration.json` 成了一个跨组件文件:这里写,仓库外的一个插件读。两边都写进了文档。改变它 `migrated` 数组的含义,现在是一次有消费者的改动。

一次安装是在一个 profile 目录里跑 pnpm,而那个目录里同时躺着这个壳做出来的软链接——迁移指向 `web` profile 的那些链接。在 pnpm 11.7.0 上、以 profile 自己的 `nodeLinker: hoisted` 实测:`pnpm add <name>@<version>` 把那些链接原封不动地留着——一个只作为 bundle 项存在的名字对它来说不是多余的,而一个同时也是依赖项的名字,则被链接解析到的那个版本满足了。这正是「在一个壳只拥有一部分的 profile 里跑安装」之所以安全的原因;而这是 pnpm 的性质而不是这段代码的性质,所以一次 pnpm 升级才是可能把它拿走的那个改动。

用这种方式更新的插件要下次启动才生效。那一行会这么说,并给出一个重启按钮,因为在运行中的应用仍由旧副本组合而成时说「已更新」,是一句下次启动就会纠正的断言。

渲染服务保留了它原有的每一项行为。抽取到 `loopback-service.ts` 把 `authorized`、`readBody`、`sendJson` 与那段监听序列从 `render-service.ts` 里搬了出来,留下它的 `fail` 作为一层薄封装、继续携带报告响应头;它那 91 个协议测试原样通过,这正是这次搬动确实是机械操作的证据。

## Testing

`apps/desktop/tests/plugin-admin-service.spec.ts` 在一个搭好的 `$DSH_HOME` 上把整条协议跑一遍,pnpm 与对话框都是注入的,所以它不需要 Electron、也不需要包管理器:404 先于 401 的次序、缺失的 token、一个等长但写错的 token、真 token 的一个前缀、请求体上限与 content type、profile 白名单对上穿越路径与绝对路径、一个该 profile 从未装过的包、一个内置插件的名字、一个形似标志或路径的名字、二十个 pnpm 会接受而这里拒绝的版本 specifier、它接受的那五个确切版本、两次调用之间从硬盘重新读取的依赖表、确认文案与它的按钮、被拒绝的对话框什么都不装、一行被压平并截断的 warning、同一时刻只跑一次安装、安装后的包不再声明 `dsh.bundle` 时被摘掉的 bundle 项与仍然声明时的原样不动、原样传递而非解读的退出码,以及打包版与开发版的 pnpm 启动方式。

有三个用例钉住「硬盘上的版本才是结果」这条规则:一次以 1 退出、却把要的版本装上了的运行被报告为已安装,并且仍然带着那行 `ERR_PNPM_IGNORED_BUILDS`;同一次运行会摘掉那个包不再声明的 bundle 项;而一次把旧版本留在硬盘上的运行,无论它以什么退出码结束,都被报告为什么都没装上。

其中有两个用例断言的是这整个界面被什么框住,而不是它报告了什么:token 不出现在这个进程持有的任何环境里,以及第二次启动铸出的是另一个 token。

## Related

- [渲染服务](2026-08-22-desktop-render-service.zh.md)是第一个本机服务,也是这一个所遵循的样式;两者现在共享 `apps/desktop/src/loopback-service.ts`。
- [一次性 `web` profile 迁移](2026-08-25-desktop-web-profile-migration.zh.md)写下这个功能读取的那个标记文件,也正是一个桌面安装为何会持有应用之外的包的原因。
- [内置插件植入](2026-08-21-desktop-builtin-plugins.zh.md)解释了内置插件为何是一个没有依赖项的 bundle 项,而那正是把它放在可更新集合之外的东西。
