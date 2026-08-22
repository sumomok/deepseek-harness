# Agent Note: 桌面安装包内置插件,并把它们播种进一个自己的 profile

Status: implemented

[English](2026-08-21-desktop-builtin-plugins.md) | 中文

## Problem

`dsh-better-sidebar`(右侧的文件树、编辑器、终端标签页与任务列表)和 `dsh-at-file`(输入框里的 `@` 文件提及)是让桌面客户端显得完整的东西,而装上它的人一个都拿不到。要装上它们得有终端、能用的 pnpm,还要对着注册表执行 `dsh plugin --profile <name> add <包>`——所以它们只存在于一台 macOS 机器上,Windows 上一台都没有。装桌面客户端正是为了不碰终端的那个人,恰恰是走不完这几步的那个人。

把它们放进载荷只解决了一半,因为 profile 属于用户数据,而 launcher 刻意不再回头看它。`initProfile`(`packages/boot/app-boot/src/profile.ts`)按 profile 名在 `PROFILE_TEMPLATES` 里对应的模板把目录写一次——`web` 的模板只有 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`,别无其他——此后每一个已存在的文件都永远不动。于是加进安装目录的插件永远进不了已存在 profile 的组合;全新安装也一样进不去,因为没有哪个模板写着它的名字。

## Decision

插件随 deploy 闭包一起分发,桌面壳在启动服务端之前把它们的名字放进 profile。

**闭包。**`apps/desktop-server/package.json` 在 workspace 包旁边以精确版本声明 `dsh-better-sidebar` 与 `dsh-at-file`,`pnpm deploy` 于是把它们和服务端闭包的其余部分一起物化进 `resources/server/node_modules`。版本归携带该次构建的安装包所有;插件没有独立的更新通道。

**版本。**`dsh-better-sidebar` 是 npm 上的 `0.14.0`,而且这是下限而非偏好:`0.1.0-rc.8` 起不再暴露 `window.__DSH_MODULES__` 页面全局,改由 `ctx.modules` 服务提供,而 `0.13.1` 里每个懒加载 chunk 正是靠前者解析外部依赖的。在该版本及之后的任何宿主上,`0.13.1` 都会报 `[dsh-better-sidebar] chunk "terminal": client module system unavailable`,并丢掉终端、编辑器与 Mermaid 面板。`0.14.0` 注入 `@deepseek-ai/dsh-client-modules`——本仓库有 `0.1.1-rc.1` 这一版——把插件自有的全局共享给它的 chunk 副本,并移除了随 rc.8 消失的 `dsh-client-web-react` 与 `dsh-client-schema-form` 两个 peer。它的 `node-pty` 范围没变,所以下面那条 override 照原样继续生效。

`dsh-at-file` 取的是作者仓库的 `v0.6.5`,而不是 npm 的 `0.6.3`,理由正是下面那处分裂解析:一个 bundle 的 patch 层经 `resolveBundleDir` 安装目录优先,模块则按常规的逐级向上查找,先撞上 profile 自己的 `node_modules`。对着一个自行装了 `v0.6.5` 的 profile 分发 `0.6.3`——第一台跑起这个插件的机器正是这个状态——会让 `0.6.3` 的一行配上 `v0.6.5` 的代码。

这条依赖写的是该 tag 所指的提交(`289f19bb`),而不是它的归档 URL。pnpm 不为 GitHub 归档 tarball 记录 `integrity`,因为那些字节并不保证稳定,而 `pnpm deploy` 拒绝没有该字段的 lockfile 条目——`ERR_PNPM_MISSING_TARBALL_INTEGRITY`,它当场让打包运行失败。提交本身就是它的哈希,所以 `resolution: {commit, repo, type: git}` 对内容的钉死程度不亚于注册表的 `integrity`。安装期什么都不构建:该仓库把 `lib/` 提交了进去,也没有声明 `prepare` 脚本。作者在注册表发布 `0.6.5` 或更高版本,就是换回普通版本号的理由。

**播种。**`apps/desktop/src/profile-seed.ts` 在 Electron 主进程里、遗留进程清扫与 `startServer` 之间运行,只补上启动所需的三件事:

- `desktop` profile 目录存在,并且带着清单、`cordis.patch.yml` 与 `pnpm-workspace.yaml`——正是 `initProfile` 会写的那三个文件;
- 清单的 `dsh.profile.bundles` 列表带上每一个内置插件的名字,追加在已有条目之后,于是 `loadProfile` 会应用各插件的 `cordis.patch.yml` 层;
- `$DSH_HOME/profiles/node_modules/<name>` 链接到载荷里的目录,因为 Loader 以 profile 目录作为 `baseUrl` 解析插件标识符,而扁平兜底目录是这条逐级向上的路径上唯一能容纳安装目录所提供的包的位置。

是三个文件都写,而不是只写清单:`initProfile` 把整个目录挡在 `if (!existsSync(package.json))` 之后,所以先写了清单的播种会把它短路掉,另外两个文件此后没有任何人会创建。`cordis.patch.yml` 正是 README 教用户关掉内置插件的地方,而 `pnpm-workspace.yaml` 的 `nodeLinker: hoisted` 才是把 out-of-tree 插件缺失的 peer 送到 healed 扁平兜底目录的东西——缺了它,用户日后装进这个 profile 的每个插件都会解析出自己那份 cordis。

初始化目录是必需的,因为 `desktop` 不在 `PROFILE_TEMPLATES` 里,`loadProfile` 对一个从未建过它的 home 给出的答复是 `profile "desktop" does not exist`。做不到时报告里带一行 `failed` 供日志记录,启动照常拉起服务端,由服务端给出它加载不了这个 profile 的诊断。此后的一切——写上 bundle 名字、维护链接——仍是尽力而为,因为其中每一处失败留下的都是一个少了些插件、但仍可用的应用。

后一半最容易被漏掉。`resolveBundleDir` 解析 bundle 的 **patch 层**时安装目录优先,所以只要列出名字,`loadProfile` 就会成功,那一行也会被插入——然后 `entry.init()` 用这个裸名字从 `baseUrl` 导入插件并失败,因为 profile 逐级向上的路径上没有任何位置放着它。`healProfilesModuleFallback` 为 CLI 应用自己的依赖闭包维护同一个 `profiles/node_modules` 目录,而这两个包不在那个闭包里;它只添加自己知道的名字,其余链接一概不碰,所以壳自己建的那些链接每次启动都活着。

两处写入都是追加式且幂等的。已列出的名字不会重复追加,已经指向正确目录的链接原样保留,任何 bundle 条目、依赖或清单里的其他字段都不会被删除或改写。"已经指向正确目录"由 `sameLinkTarget` 判定:比较前先剥掉 `\\?\` 扩展长度前缀、归一化尾部分隔符,并把相对读取的结果按链接自身所在目录解析——Windows 读回 junction 的形式与创建它的字符串本就不同,裸比较对一条正确的链接也为假,于是每次启动都会删掉重建。上游 `packages/boot/app-boot/src/profile.ts` 里的 `ensureSymlink` 用的是裸比较,存在同一处缺陷。清单以 rename 替换,所以写到一半被打断的启动留下的是原来那份文件,而不是被截断的一份。整次运行如实汇报它做了什么,启动日志写一行,没改动则不写。

**profile 里的副本只报告,绝不改动。**当 profile 自己的 `node_modules` 里有某个内置插件的另一版本时,那一份才是 Loader 导入的代码,而 patch 层依旧来自安装目录。播种会在自己那行日志后追加一条 warning——`profile copy dsh-at-file@0.6.3 shadows the shipped 0.6.5 module; patch layer comes from the shipped copy`——并且什么都不改:profile 的依赖归安装它的人所有,`dsh plugin --profile desktop remove <name>` 是用户该做的动作,不是壳该做的。

**过了第一次写入,这里没有任何一处是致命的。**壳认不出的 profile 原样保留,启动照常继续,只是没有内置插件:解析不了的清单留给服务端自己的诊断;没有声明 bundle 列表的清单按手写编排对待(往一个不存在的列表里追加两个名字,会得到一个只挂载内置插件、别无其他的 profile);该放链接的位置上是真实目录则如实报告而不是删掉;载荷里没有的插件绝不写进清单——列出却解析不了的 bundle 会让启动硬失败,所以播种只写它看得见的东西。一个因为看不懂 profile 就拒绝启动的壳,比一个少了侧栏的壳更糟。

## 桌面端为什么独占自己的 profile

壳启动的是 `--profile desktop`,这个名字没有别的 dsh 安装会去启动。`dsh web` 是 `--profile web` 的硬编码别名(`apps/cli/src/args.ts`),而后者是这个 home 上每一次 CLI 启动都会编排的 profile,所以往里播种,等于让一个与安装目录毫无关系的 launcher 承重地依赖上了这个已安装的应用。

`$DSH_HOME/profiles/node_modules` 本来就指向最后运行过的那份 dsh。在一台最后一次启动的是桌面客户端的机器上,那里 200 多条链接——`accepts`、`ajv`、`argparse` 等等——全都解析进 `DSH Desktop.app/Contents/Resources/server/node_modules`,而这没有问题:`healProfilesModuleFallback` 每次启动都会把它们逐一重指到当前正在运行的那份安装上。播种建的链接是那个目录里唯一不被它维护的条目,因为 heal 遍历的是 CLI 应用自己的依赖闭包,而这些名字不在里面。所以确切的缺陷是:一条指向可能已经消失的应用、且不会自愈的引用,撞上 `loadProfile` 对解析不了的 bundle 的硬失败——应用被删掉或移走之后,`dsh web` 与 `dsh --profile web --dump-config` 干脆拒绝启动。

不删任何东西也能看到同一个根因。因为插件是在应用里被找到的,它们的 peer 也就从应用的闭包里解析——用源码检出启动一个被播种过的 `web` profile,会加载出 2 份 cordis,其中 38 次解析落在应用闭包内。

在桌面端独占的 profile 下,这两种情况都不成立。只有桌面端会启动 `desktop`,而它启动时,负责解析这些 bundle 的 dsh 就在插件所在的同一个应用里。共享的 `web` profile 再也不会被写入,也不留任何需要自愈的引用。

## profile 的两处规范化对被播种的列表做了什么

有两处机制会改写 bundle 列表,而它们都碰不到这些名字。

`normalizeShippedProfile` 只在 `INSTALLATION_OWNED_PROFILE_TUPLES[name]` 存在、且当前列表与它精确相等时才改写 profile。只有 `headless` 有条目,所以 `desktop` profile 无论装着什么都原样返回;就算是 `headless`,只要多出一个名字,精确元组判定当即不成立。

`reconcilePlugins`(`apps/cli/src/plugin.ts`)只在 bundle `wasDependency` 时移除它——即在 pnpm 运行前后出现在 profile 的 `dependencies` 里。被播种的名字不是 profile 的依赖,所以 `dsh plugin` 的各种操作都不碰它们。唯一会移除的路径是:用户自己装过同名包之后再执行 `dsh plugin --profile desktop remove <name>`,而下次启动会把它播种回来;要永久关掉一个内置插件,办法是在 `cordis.patch.yml` 里禁用那一行,README 记的也是这一条。

## 只留一份 node-pty,不留两份

`dsh-better-sidebar` 声明 `node-pty: ^1.1.0`,它自己的 `src/pty-deps.ts` 写明它必须解析到与 harness 内核同一个物理包。内核精确钉在 `1.2.0-beta.15`,并由 `patches/node-pty@1.2.0-beta.15.patch` 为内嵌运行时的 spawn helper 打了补丁,而预发布版本不在 `^1.1.0` 范围内——于是不加干预的安装会产生两份副本。在一个围绕文件数设计的载荷里,这不只是浪费:`PLATFORM_DIR_RULES` 只对顶层的 `node-pty/prebuilds` 生效,所以嵌套的第二份会把每个平台的二进制带进两个载荷并让载荷门禁失败;`prunePlatformBuilds` 只对顶层那份 chmod spawn helper;而嵌套的那份正是侧栏真正加载、却没打补丁的那份。

因此 `pnpm-workspace.yaml` 带上了 `'dsh-better-sidebar>node-pty': '1.2.0-beta.15'`。两个版本 API 兼容:`resize` 多了一个可选的第三参数,`useConpty` 变成了有文档说明的空操作。

## 构建不再改动开发者的 harness home

`verifyStagedBoot` 会真的把派生出的载荷启动起来,而它此前用的是构建机上 `$DSH_HOME` 解析到的那个目录。于是每次构建都跟着两处写入:`prepareProfile` 重写 `~/.dsh/profiles/web/cordis.yml`,`healProfilesModuleFallback` 把全部 171 条扁平兜底符号链接重指到 `apps/desktop/staging/server-mac/node_modules`——下次构建就会删掉的那棵树。什么都没丢——下次 `dsh` 启动会把链接治好——但构建本就不该改动这台机器的 harness 状态,而且同一个 home 也漏进了两次 `--version` 冒烟。

`package.ts` 现在把整次运行包在 `withBuildHome` 里:创建一个 `mkdtemp` home,放到 `process.env` 上(`run()` 展开的、两处 `spawn` 继承的都是它),并在 `finally` 里删除。

这改变了启动门禁所证明的东西,而且是变好了。对着开发者的 home,它加载的是那位开发者恰好装了什么;对着一个全新的 home,它本来只会加载两个内置 bundle。于是门禁通过 `seedBuiltinBundles` 播种自己的 home——与壳调用的是同一个函数——再要求两个内置插件都出现在所服务 index 点名的 client 模块里。载荷自带的那两份能挂载、能服务,现在是一条构建断言,而不是某次手跑冒烟碰巧查到的事。

## 别让载荷的打包器把它们删掉

`scripts/bundle-closure.ts` 让 `@deepseek-ai/*` 的包保持可按名字解析,并删除任何可达代码都不 import 的第三方包。两个插件按名字算第三方,又没有任何人 import 它们——profile 是在启动时读取的配置里点名它们的——所以它们在到达用户之前就被删掉了。

补上的规则是结构性的,而不是一张名单:自己的清单里声明了 `dsh.bundle` 的包就是 profile bundle,整包保留,并加入 esbuild 的 `external` 集合。是整包保留而非打包,因为两者都发布了预构建的 `lib/` 树,其中的浏览器那一半必须保持它们各自 client 构建留下的样子。它们自己的依赖靠现有的可达性遍历存活,遍历现在也从它们出发;只有预打包的浏览器产物才需要的东西——`mermaid`、CodeMirror 各包——照旧被删掉,因为没有任何可达代码点名它们。载荷构建会打印它保留了哪些 bundle,因为可达性遍历本就无法展示"没有任何人引用的东西"的存活。

## Alternatives considered

**把名字加进 `PROFILE_TEMPLATES.web`。**一行的事,而且能覆盖全新 profile。它在两个层面被否决:它改的是发布出去的 `@deepseek-ai/dsh`,而 CLI 用户并没有装这两个包,会因为一个解析不了的 bundle 直接硬启动失败;而且模板只在 profile 不存在时才被查阅,所以现有的每一位桌面用户——正是提这个需求的人——依然什么都看不到。

**由壳传一个 `--patch` 覆盖层。**`dsh web` 接受覆盖 patch 文件,壳完全可以传一个插入两行的文件而根本不碰 profile。否决理由是覆盖层位于用户层**之上**:用户将无法从 `cordis.patch.yml` 禁用或配置一个内置插件,而其他每一行都是在那里配置的。播种 bundle 名字则把这两行放在栈里的常规位置,位于用户自己那一层之下。

**首次启动时由壳执行 `dsh plugin add`。**这是受支持的安装路径,而它需要 PATH 上有 pnpm、需要能连上注册表——恰恰是桌面客户端为了不需要而存在的两样东西。它还会在每台机器上再装一份插件,与载荷里已有的那份并存。

**把它们声明为 `@deepseek-ai/dsh` 的依赖,让 `healProfilesModuleFallback` 去建链接。**这样能整块去掉壳里做符号链接的那一半,因为每次启动 heal 都会遍历 CLI 应用的依赖闭包。否决理由:它把两个只属于桌面的插件塞进了每一份已发布 CLI 安装的依赖树,这个主张比"桌面安装包携带它们"大得多。

**把插件实体拷进 `$DSH_HOME/profiles/node_modules/`,而不是建链接。**副本能活过应用,于是不会有悬空。它可行,但有条件:只拷这三个包会导致启动致命失败(`Cannot find package 'schemastery'`),因为 `dsh-better-sidebar` 依赖无 scope 的 `schemastery@3.18.0`,并经由它依赖 `cosmokit@1.8.1`,而 harness 全仓用的是 rescope 后的 `@deepseek-ai/schemastery`——所以这两个名字永远不可能出现在 heal 的 BFS 闭包里。否决理由是它把一个可归因的失败("应用被删了,所以 CLI 拒绝启动")换成了一个不可归因的失败("某个插件新增了一个依赖,所以桌面端与 CLI 一起拒绝启动"),而且没有 gate 守得住后者:`verifyStagedBoot` 启动的是载荷内的闭包,那是 hoisted 平铺的,`schemastery` 就在顶层,所以打包期一定解析得到、一定不报警。该失败只在副本进了 `$DSH_HOME`、再由另一份 dsh 启动它时才暴露。

**给桌面端一个自己的 `$DSH_HOME`。**彻底隔离,profile 的问题也就不存在了。作为远大于问题本身的代价被否决:会话、凭据与模型设置全在 home 根上,用户只要用一次终端,历史与 API key 就一分为二。

**把插件 vendor 进仓库。**版本完全可控,也不必声明第三方依赖。作为一项没有收益的长期成本被否决:两者都已发布、都是 MIT、都是预构建的,vendor 只会让它们白白与各自上游分叉。

## Consequences

现在桌面安装在两个平台上首次启动就有侧栏和 `@` 提及,不需要终端。版本归安装包所有:升级一个内置插件意味着发一版桌面构建,而这与载荷其余部分本来就是同一节奏。

播种会在服务端之前写 `$DSH_HOME`。它只限于 `profiles/desktop/` 与 `profiles/node_modules/` 下的链接,而且只做追加,但"壳会动用户数据"这件事本身是这个应用的一个事实,README 写明了它。

用户在自己 `web` profile 里做的定制不会跟着到桌面客户端,后者挂载的是 `desktop`。没有任何东西需要先清理:此前没有任何已发布版本播种过 `web`——rc.16 的 `app.asar` 里没有 `profile-seed`——所以不存在哪个共享 profile 带着只有应用才解析得了的名字。内置插件也不用管,桌面端自带。真正需要用户重做一遍的,是他自己装进 `web` 的那些,也就是 `~/.dsh/profiles/web/package.json` 里的 `dependencies` 列表;用 `dsh plugin --profile desktop add <包>` 把其中一个装进桌面 profile。README 记的就是这一条。

`dsh-at-file` 是载荷里唯一一个不来自注册表的依赖。提交钉死是可验证的,但这也意味着这个包是那个仓库树的内容,而不是按 `files` 过滤后的发布产物,于是载荷里带上了它的 `src/`、`tests/` 与构建配置——几个小文件,后缀裁剪大多会清掉。注册表上出现 `0.6.5` 或更高版本时,值得换回去。

`pnpm-workspace.yaml` 的 override 把插件的 `node-pty` 绑到 harness 内核钉住的版本上。挪动内核的钉子就得连同挪动这条 override,而那时要重新核对的是插件自己的兼容窗口,不只是 harness 的。

profile 里自装一份同名插件现在会得到分裂的解析:Loader 导入 profile 里那一份,而 `resolveBundleDir` 从安装目录读取 patch 层。因此不支持从 profile 侧把内置插件钉到另一个版本,README 的限制小节点了这一条。
