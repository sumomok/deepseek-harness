# Agent Note: 桌面安装包内置两个插件并把它们播种进 web profile

Status: implemented

[English](2026-08-21-desktop-builtin-plugins.md) | 中文

## Problem

`dsh-better-sidebar`(右侧的文件树、编辑器、终端标签页与任务列表)和 `dsh-at-file`(输入框里的 `@` 文件提及)是让桌面客户端显得完整的东西,而装上它的人一个都拿不到。要装上它们得有终端、能用的 pnpm,还要对着注册表执行 `dsh plugin --profile web add <name>`——所以它们只存在于一台 macOS 机器上,Windows 上一台都没有。装桌面客户端正是为了不碰终端的那个人,恰恰是走不完这几步的那个人。

把它们放进载荷只解决了一半,因为 profile 属于用户数据,而 launcher 刻意不再回头看它。`initProfile`(`packages/boot/app-boot/src/profile.ts`)按 `PROFILE_TEMPLATES.web` 写一次 `$DSH_HOME/profiles/web/`——只有 `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`,别无其他——此后每一个已存在的文件都永远不动。于是加进安装目录的插件永远进不了已存在 profile 的组合;全新安装也一样进不去,因为模板里没有它的名字。

## Decision

插件随 deploy 闭包一起分发,桌面壳在启动服务端之前把它们的名字放进 profile。

**闭包。**`apps/desktop-server/package.json` 在 workspace 包旁边以精确版本声明 `dsh-better-sidebar` 与 `dsh-at-file`,`pnpm deploy` 于是把它们和服务端闭包的其余部分一起物化进 `resources/server/node_modules`。版本归携带该次构建的安装包所有;插件没有独立的更新通道。

**播种。**`apps/desktop/src/profile-seed.ts` 在 Electron 主进程里、遗留进程清扫与 `startServer` 之间运行,只补上启动所需的两件事:

- profile 清单的 `dsh.profile.bundles` 列表带上两个名字,追加在已有条目之后,于是 `loadProfile` 会应用各插件的 `cordis.patch.yml` 层;
- `$DSH_HOME/profiles/node_modules/<name>` 链接到载荷里的目录,因为 Loader 以 profile 目录作为 `baseUrl` 解析插件标识符,而扁平兜底目录是这条逐级向上的路径上唯一能容纳安装目录所提供的包的位置。

后一半最容易被漏掉。`resolveBundleDir` 解析 bundle 的 **patch 层**时安装目录优先,所以只要列出名字,`loadProfile` 就会成功,那一行也会被插入——然后 `entry.init()` 用这个裸名字从 `baseUrl` 导入插件并失败,因为 profile 逐级向上的路径上没有任何位置放着它。`healProfilesModuleFallback` 为 CLI 应用自己的依赖闭包维护同一个 `profiles/node_modules` 目录,而这两个包不在那个闭包里;它只添加自己知道的名字,其余链接一概不碰,所以壳建的这两条链接每次启动都活着。

两处写入都是追加式且幂等的。已列出的名字不会重复追加,已经指向正确目录的链接原样保留,任何 bundle 条目、依赖或清单里的其他字段都不会被删除或改写。清单以 rename 替换,所以写到一半被打断的启动留下的是原来那份文件,而不是被截断的一份。整次运行如实汇报它做了什么,启动日志写一行,没改动则不写。

**这里没有任何一处是致命的。**壳认不出的 profile 原样保留,启动照常继续,只是没有内置插件:解析不了的清单留给服务端自己的诊断;没有声明 bundle 列表的清单按手写编排对待(往一个不存在的列表里追加两个名字,会得到一个只挂载内置插件、别无其他的 profile);该放链接的位置上是真实目录则如实报告而不是删掉;载荷里没有的插件绝不写进清单——列出却解析不了的 bundle 会让启动硬失败,所以播种只写它看得见的东西。一个因为看不懂 profile 就拒绝启动的壳,比一个少了侧栏的壳更糟。

## profile 的两处规范化对被播种的列表做了什么

有两处机制会改写 bundle 列表,而它们都碰不到这些名字。

`normalizeShippedProfile` 只在 `INSTALLATION_OWNED_PROFILE_TUPLES[name]` 存在、且当前列表与它精确相等时才改写 profile。只有 `headless` 有条目,所以 `web` profile 无论装着什么都原样返回;就算是 `headless`,只要多出一个名字,精确元组判定当即不成立。

`reconcilePlugins`(`apps/cli/src/plugin.ts`)只在 bundle `wasDependency` 时移除它——即在 pnpm 运行前后出现在 profile 的 `dependencies` 里。被播种的名字不是 profile 的依赖,所以 `dsh plugin` 的各种操作都不碰它们。唯一会移除的路径是:用户自己装过同名包之后再执行 `dsh plugin --profile web remove <name>`,而下次启动会把它播种回来;要永久关掉一个内置插件,办法是在 `cordis.patch.yml` 里禁用那一行,README 记的也是这一条。

## 只留一份 node-pty,不留两份

`dsh-better-sidebar` 声明 `node-pty: ^1.1.0`,它自己的 `src/pty-deps.ts` 写明它必须解析到与 harness 内核同一个物理包。内核精确钉在 `1.2.0-beta.15`,并由 `patches/node-pty@1.2.0-beta.15.patch` 为内嵌运行时的 spawn helper 打了补丁,而预发布版本不在 `^1.1.0` 范围内——于是不加干预的安装会产生两份副本。在一个围绕文件数设计的载荷里,这不只是浪费:`PLATFORM_DIR_RULES` 只对顶层的 `node-pty/prebuilds` 生效,所以嵌套的第二份会把每个平台的二进制带进两个载荷并让载荷门禁失败;`prunePlatformBuilds` 只对顶层那份 chmod spawn helper;而嵌套的那份正是侧栏真正加载、却没打补丁的那份。

因此 `pnpm-workspace.yaml` 带上了 `'dsh-better-sidebar>node-pty': '1.2.0-beta.15'`。两个版本 API 兼容:`resize` 多了一个可选的第三参数,`useConpty` 变成了有文档说明的空操作。

## 别让载荷的打包器把它们删掉

`scripts/bundle-closure.ts` 让 `@deepseek-ai/*` 的包保持可按名字解析,并删除任何可达代码都不 import 的第三方包。两个插件按名字算第三方,又没有任何人 import 它们——profile 是在启动时读取的配置里点名它们的——所以它们在到达用户之前就被删掉了。

补上的规则是结构性的,而不是一张名单:自己的清单里声明了 `dsh.bundle` 的包就是 profile bundle,整包保留,并加入 esbuild 的 `external` 集合。是整包保留而非打包,因为两者都发布了预构建的 `lib/` 树,其中的浏览器那一半必须保持它们各自 client 构建留下的样子。它们自己的依赖靠现有的可达性遍历存活,遍历现在也从它们出发;只有预打包的浏览器产物才需要的东西——`mermaid`、CodeMirror 各包——照旧被删掉,因为没有任何可达代码点名它们。载荷构建会打印它保留了哪些 bundle,因为可达性遍历本就无法展示"没有任何人引用的东西"的存活。

## Alternatives considered

**把名字加进 `PROFILE_TEMPLATES.web`。**一行的事,而且能覆盖全新 profile。它在两个层面被否决:它改的是发布出去的 `@deepseek-ai/dsh`,而 CLI 用户并没有装这两个包,会因为一个解析不了的 bundle 直接硬启动失败;而且模板只在 profile 不存在时才被查阅,所以现有的每一位桌面用户——正是提这个需求的人——依然什么都看不到。

**由壳传一个 `--patch` 覆盖层。**`dsh web` 接受覆盖 patch 文件,壳完全可以传一个插入两行的文件而根本不碰 profile。否决理由是覆盖层位于用户层**之上**:用户将无法从 `cordis.patch.yml` 禁用或配置一个内置插件,而其他每一行都是在那里配置的。播种 bundle 名字则把这两行放在栈里的常规位置,位于用户自己那一层之下。

**首次启动时由壳执行 `dsh plugin add`。**这是受支持的安装路径,而它需要 PATH 上有 pnpm、需要能连上注册表——恰恰是桌面客户端为了不需要而存在的两样东西。它还会在每台机器上再装一份插件,与载荷里已有的那份并存。

**把它们声明为 `@deepseek-ai/dsh` 的依赖,让 `healProfilesModuleFallback` 去建链接。**这样能整块去掉壳里做符号链接的那一半,因为每次启动 heal 都会遍历 CLI 应用的依赖闭包。否决理由:它把两个只属于桌面的插件塞进了每一份已发布 CLI 安装的依赖树,这个主张比"桌面安装包携带它们"大得多。

**把插件 vendor 进仓库。**版本完全可控,也不必声明第三方依赖。作为一项没有收益的长期成本被否决:两者都已发布、都是 MIT、都是预构建的,vendor 只会让它们白白与各自上游分叉。

## Consequences

现在桌面安装在两个平台上首次启动就有侧栏和 `@` 提及,不需要终端。版本归安装包所有:升级一个内置插件意味着发一版桌面构建,而这与载荷其余部分本来就是同一节奏。

播种会在服务端之前写 `$DSH_HOME`。它只限于两处——`profiles/web/package.json` 和 `profiles/node_modules/` 下的链接——而且只做追加,但"壳会动用户数据"这件事本身是这个应用的一个新事实,README 因此写明了它。

`pnpm-workspace.yaml` 的 override 把插件的 `node-pty` 绑到 harness 内核钉住的版本上。挪动内核的钉子就得连同挪动这条 override,而那时要重新核对的是插件自己的兼容窗口,不只是 harness 的。

profile 里自装一份同名插件现在会得到分裂的解析:Loader 导入 profile 里那一份,而 `resolveBundleDir` 从安装目录读取 patch 层。因此不支持从 profile 侧把内置插件钉到另一个版本,README 的限制小节点了这一条。
