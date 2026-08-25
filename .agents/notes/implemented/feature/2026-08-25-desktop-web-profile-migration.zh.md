# Agent Note: web profile 里的插件一次性搬到桌面端

Status: implemented

[English](2026-08-25-desktop-web-profile-migration.md) | 中文

## Problem

到 0.1.0-rc.16 为止,桌面壳启动的都是 `bin.js web`,也就是 `--profile web`——那台机器上每一次 CLI 启动都会编排的那个 profile。[rc.17 让它有了自己的 profile](2026-08-21-desktop-builtin-plugins.zh.md),由 `apps/desktop/src/profile-seed.ts` 建出来,当初的理由今天依然成立:除了桌面端没人会启动 `desktop`,于是不会有指向已安装应用的引用留在一个裸 `dsh web` 也要加载的 profile 里。

那次切换没有谁负责把用户自己的插件带过去。profile 属于用户数据,`initProfile` 写一次就不再回头看已存在的文件,而播种只加本次构建随包分发的内置插件,别无其他。跑过 `dsh plugin --profile web add <包>` 的人——在 rc.17 之前,那是插件抵达桌面安装的唯一途径;直到今天,那也仍是七个内置插件之外的东西抵达桌面安装的途径——在 rc.16 上这些插件是被编排的,到 rc.17 就不再被编排。现场案例是从 rc.14 直接升到 rc.22:desktop profile 被全新建出,里面只有七个内置插件,而客户自己的插件仍留在 `~/.dsh/profiles/web/`,装着、列着,却没有任何桌面端跑起来的东西挂载它们。

任何做法都受两条约束。`loadProfile` 会解析 `dsh.profile.bundles` 里的每一个条目,解析不到就抛错;所以一个加进这份列表、日后又解析不到的名字带来的不是功能降级,而是启动终止。还有:这些机器上没有包管理器——桌面客户端的前提就是一个没有终端的人,所以壳里任何东西都不许跑安装。

## Decision

壳把 `web` profile 里用户自己的插件一次性、自动地迁进桌面 profile,并在此后每次启动都复核它加过的那些条目。

**让它只跑一次的是一份记录,不是 profile 不存在。**桌面 profile 里的 `web-migration.json` 记着 `{ from: "web", migrated: [...] }`,迁移在这个文件不存在时执行。以「建出 profile」为闸门只够得着全新安装,却会漏掉每一台已经在 rc.17 到 rc.22 上的机器——而那正是本功能要救的那批:desktop profile 已经存在、装着内置插件,却从来没见过它主人装的那些插件。以记录为闸门两边都够得着,而记录里的名字正是下面那道修复要复核的东西。

**哪些会搬过来。**web profile 的 `dsh.profile.bundles` 里,凡是既不属于桌面模板已经列出的那两个随附 bundle、也不在 `BUILTIN_WEB_BUNDLES`、也不在 `WITHDRAWN_WEB_BUNDLES` 里的名字。内置插件、被撤下的名字,连同下面那两种拒收,都会连名字带理由写进日志——本功能之所以存在,就是因为有人不得不逐行读客户的 `dsh-server.log` 才弄明白他的插件去哪儿了。那两个随附 bundle 是例外:每一个建出来过的 web profile 都有它们,所以写它们的那一行会出现在每一次安装的首启里,却说不出被读的那个 profile 的任何事。

**只建链接,既不复制也不安装。**`~/.dsh/profiles/desktop/node_modules/<name>` 会成为一条指向 `~/.dsh/profiles/web/node_modules/<name>` 的链接——指的是 web profile 的那个路径,而不是该路径当下解析到的地方。pnpm 可能把包放在任何位置、并在那儿放一条自己的链接;越过它去指里层,等于把桌面端钉死在今天这一份上,而那个路径本身会一直交出 `dsh plugin --profile web add <包>@latest` 之后装进去的东西。包仍然只住在 web profile 那一处,也只在那一处被更新。`ensureLink` 本就会建这条链接——在 Windows 上是 junction、因而需要绝对路径目标——也本就会为带 scope 的名字建出父目录。

随后桌面清单会把该名字追加进 `dsh.profile.bundles`,并把 web 清单为它声明的版本抄进 `dependencies`,这样日后的 `dsh plugin --profile desktop install` 会按同一个版本去对账,而不是把名字丢掉。这是播种里唯一会写入依赖条目的动作;模块文档里「依赖与清单里的其他字段都不会被动」那句承诺,如今明确写上了这一条例外。

**只有解析得到的名字才会被写进去。**链接先建,而在它之前还有两种拒收:web profile 列了却从没装过的名字,以及没有声明 `dsh.bundle` 的包。这两种 `loadProfile` 都会抛错——前者在 `resolveBundleDir`,后者在缺失的 `dsh.bundle` 上——所以收下它们等于用一个本来就加载不了的插件,换一次写进 profile 的启动失败。清单写入失败时,链接已经建好而记录没有写,下一次启动正是从这个状态重试。

**patch 层要么逐字节复制,要么根本不动。**迁移当时,若桌面这份 `cordis.patch.yml` 还逐字节等于播种写下的空模板、而 web profile 那份不是,web 的文件就会替换它——按字节,所以注释与 `!!js` 标签都活着过来。桌面那份若已被改过则原样保留,日志会点名该手工搬哪些插件的行。`pnpm-workspace.yaml` 同理。任何情况下都不做合并:patch 层是 loader 自有 schema 才读得懂的 YAML,把两份合起来意味着把那套 schema 再实现一遍——而且是在一个刻意不依赖任何 harness 包的 Electron 主进程里。

**每次启动都会复核迁移加过的东西。**这些条目指向的是归用户所有、也能被用户清空的目录——重装或删掉 `web` profile 都会让链接悬空——而一个解析不到的条目就会终止启动。所以在每一次播种运行上(不只是执行迁移的那一次),记录里的每个名字都按 `resolveBundleDir` 的方式去解析;哪儿都解析不到的名字会失去它的 bundle 条目、它的链接,以及它在记录里的位置,启动日志写下 `dropped migrated <name>: no longer resolves in the web profile`。这就是把「撤下内置插件」那道清理,套用到壳放进一个自己并不拥有的 profile 里的另一类条目上。用户后来自己接管的名字——桌面 profile 自有 `node_modules` 下的副本、他自己在那个路径上建的链接,或本次构建开始随包分发的包——都解析得到,于是原样保留。

**记录没了就重建,而不是重放。**若某个名字已经在列表里、而它那条链接正是本壳会建的那一条,就把它重新记进记录,清单一个字都不动。没有这一步,一份被手工删掉的标记文件——或者清单写入刚成功、标记写入却失败这种概率极低的情形——就会留下一批指向 web profile、却没有任何东西再去复核的条目,而那恰恰是上一段要防的那种砖。

## Alternatives considered

**通知用户,而不是替他迁移。**在日志里写一行,或在窗口里给个提示,点名哪些插件在 `web` 里而不在 `desktop` 里,以及哪条命令能把它们搬过来。因为受众而否决:桌面客户端的前提是一个没有终端的人,而 `dsh plugin --profile desktop add` 是一条要在没有 pnpm 的机器上、对着注册表执行的终端命令。一条无法照做的通知,结果等同于沉默,只是话更多。

**复制包目录,而不是建链接。**不再依赖一个用户能删掉的目录,于是不需要修复通道,也不会有悬空条目。因为它把包分了叉而否决:副本从此收不到 `dsh plugin --profile web` 的更新,而壳里没有任何东西会去更新它;于是迁过来一次的插件会永远冻结在迁移那天装的版本上,待在一个用户手里任何工具都不认识的目录里。修复通道的代价是每次启动、每个记录名字一次解析,换来的是全局只有一份副本。

**照 web 清单的 dependencies 在桌面 profile 里跑一次 `pnpm install`。**这才是 profile 体系本来就建模的结果:真实的依赖、解析好的 peer、`dsh plugin` 正常对账。直接否决:壳不许跑包安装。机器上没有 pnpm,profile 自己的 `pnpm-workspace.yaml` 出于扁平兜底所依赖的理由关掉了 `autoInstallPeers`,而在一次启动过程里跑安装,等于在用户和他的窗口之间插进一次网络操作。

**只在建出桌面 profile 时从 web profile 播种。**代码少得多——`initDesktopProfile` 里一个分支,不需要记录文件,也不需要修复。因为它解决的不是问题所在而否决:提出这份报告的客户,他的桌面 profile 早就在那儿了,建出那件事发生在三个版本之前。

**把两份 patch 层合并。**这才是对「配置」的完整回答,而不是「谁先在谁算数」:用户桌面端的行与他 web 的行同时生效。因为这个合并不是文本层面的而否决——两层都是按 id 定向的 patch 条目,同一个 id 在两份文件里出现意味着一行、而不是两行——要做对就得用 loader 的 schema 解析 YAML,再连 `!!js` 标签和注释一起重新输出。那是 `@deepseek-ai/dsh-app-boot` 的活,而本模块刻意复刻那三份模板、不去依赖它,因为依赖 harness 包的 Electron 应用会把产品闭包第二次打进 `app.asar`。那条拒收会点名要搬哪些插件的行,而这本就是一次合并无论如何都要人去复核的东西的诚实版本。

**把记录放在 profile 外面,放进应用的 userData。**它是壳自己的账本、不是用户数据,而且用户删掉 profile 它也还在。因为「删掉后还在」本身就是错的而否决:被删掉的 profile 意味着用户在要回播种后的初始状态,而这份记录只对它所在的那个 profile 里的条目才有意义。让两个文件对同一个 profile 的内容各执一词,是在等一台两者都有的机器上出 bug。

## Consequences

从本版之前的任何构建升上来的客户,首次启动就把插件拿回来了,不需要任何操作,也不需要终端。他拿回的是 rc.16 上的那套组合:同样的包、同样的已装版本、来自同一个目录。

桌面 profile 现在带着一批「包住在它外面」的条目,而让这些条目保持有效是壳的责任。代价是每次启动、每个记录名字一次 `existsSync`,外加一条在有名字失效时才跑的修复路径。

`dsh plugin --profile web add <包>@latest` 会同时为两个 profile 更新一个迁移过来的插件;`dsh plugin --profile web remove <包>` 会把它从 web profile 移除,并让桌面那条条目悬空到下一次启动把它删掉——用户删掉的插件多活一次启动,然后是那行说明它已经走了的日志。

这一次运行之后,两个 profile 不再有任何东西保持同步。此后加进 `web` 的插件不会出现在 `desktop` 里;README 明说了这一点,并给出了命令。

在更老的 harness 下装得好好的、到这一版却出毛病的插件,这里不做拦截;撞上的人可以在 `cordis.patch.yml` 里禁用它那一行,或者在 `web` profile 里升级它。

## Testing

`apps/desktop/tests/profile-seed.spec.ts` 在一个搭出来的 `$DSH_HOME` 上、不碰 Electron 地驱动整个功能:全新安装的迁移、desktop profile 由更早构建建出且没有记录的 rc.17 到 rc.22 现场案例、什么都不改的第二次启动、五种拒收各自连同它写进日志的理由、建在 web profile 路径上而非该路径解析结果上的链接、被抄过去的依赖版本与桌面自己声明因而被保留的那一个、还是模板时被复制、已被改过则被拒绝的 patch 层与 pnpm 设置、带 scope 的名字走完链接与清单两个字段,以及记录被手工删掉后从它自己建的链接重建回来。

修复有自己的一组用例:包被从 web profile 里删掉、web profile 被整个删掉、一次修复之后的第二次启动,以及名字重新解析得到的三种方式——profile 自有的副本、被用户改指过的链接,以及本次构建开始随包分发的包。

其中两条断言的是整个功能的边界属性而不是报告本身:桌面清单列出的每一个名字,都能经 `@deepseek-ai/dsh-app-boot` 的 `resolveBundleDir` 解析得到——`loadProfile` 对每个名字调的就是它,而它一抛错启动就结束。
