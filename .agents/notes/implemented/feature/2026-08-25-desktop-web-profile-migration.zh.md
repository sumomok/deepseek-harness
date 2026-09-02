# Agent Note: web profile 的插件与桌面端持续保持同步,坏掉的一个仍然可见

Status: implemented

[English](2026-08-25-desktop-web-profile-migration.md) | 中文

## Problem

到 0.1.0-rc.16 为止,桌面壳启动的都是 `bin.js web`,也就是 `--profile web`——那台机器上每一次 CLI 启动都会编排的那个 profile。[rc.17 让它有了自己的 profile](2026-08-21-desktop-builtin-plugins.zh.md),由 `apps/desktop/src/profile-seed.ts` 建出来,当初的理由今天依然成立:除了桌面端没人会启动 `desktop`,于是不会有指向已安装应用的引用留在一个裸 `dsh web` 也要加载的 profile 里。

那次切换没有谁负责把用户自己的插件带过去。profile 属于用户数据,`initProfile` 写一次就不再回头看已存在的文件,而播种只加本次构建随包分发的内置插件,别无其他。跑过 `dsh plugin --profile web add <包>` 的人——在 rc.17 之前,那是插件抵达桌面安装的唯一途径;直到今天,那也仍是七个内置插件之外的东西抵达桌面安装的途径——在 rc.16 上这些插件是被编排的,到 rc.17 就不再被编排。现场案例是从 rc.14 直接升到 rc.22:desktop profile 被全新建出,里面只有七个内置插件,而客户自己的插件仍留在 `~/.dsh/profiles/web/`,装着、列着,却没有任何桌面端跑起来的东西挂载它们。

任何做法都受两条约束。`loadProfile` 会解析 `dsh.profile.bundles` 里的每一个条目,解析不到就抛错;所以一个加进这份列表、日后又解析不到的名字带来的不是功能降级,而是启动终止。还有:这些机器上没有包管理器——桌面客户端的前提就是一个没有终端的人,所以壳里任何东西都不许跑安装。

**上面那道准入检查,在发布几小时之内就被现场证伪了。**当时的 `bundleDefect` 只检查包是否存在、是否声明了 `dsh.bundle`,从不检查包自己的入口文件是否真的在盘上。一位真实客户的 `web` profile 里装着 `@yuxianglin/dsh-bridge-browser`——`package.json` 在、`dsh.bundle` 声明了、`main: lib/index.js`——但这个包是一次未构建的 git 安装:只提交了 `src/*.ts`,压根没有 `lib/`,也没有 `prepare` 脚本会在安装时把它构建出来。本该把一个会终止启动的包挡在 `dsh.profile.bundles` 外面的那道检查,原样把它放了进去,`loadProfile` 此后每次启动都会在 import 它时抛错:`Cannot find module '…\lib\index.js'`。本文最初发布的那道防砖通道,每次启动都会把同一个坏掉的包重新准入一遍,因为在它眼里,这个包看起来和一个健康的包没有任何不同——一次由某道原本为了防止这个结果而写下的检查、造成的客户机器上的永久性开机死循环。

拍板的人没有去修那一道检查,而是重新定义了整个功能。一个坏掉的包绝不能让启动终止,这条没有商量余地——没有哪道准入检查能保证自己是完备的,所以启动本身必须扛得住一个没被它拦下的坏包。而且一个挂载不了的插件应当保持**可见**,而不是悄无声息地消失:处于禁用、可修复的状态,而不是被丢掉——丢掉之后,它的主人根本无从得知它曾经存在过。正是这次重新定义,把一次带着通过/拒绝式准入闸门的一次性迁移,变成了本文现在描述的这套持续的、三态系统。

## Decision

壳让 `web` profile 里用户自己的插件持续与桌面 profile 保持同步,每次启动都同步一次,而一个挂载不了的插件会保持可见、可修复,而不是被丢掉。

**是持续同步,不是一次性迁移。**桌面 profile 里的 `web-migration.json` 记着 `{ from, migrated, defective, removed }`,每次启动都会读它、把它已经追踪的每一个名字重新核对一遍、并把 web profile 自己 `dsh.profile.bundles` 里它还没追踪过的每一个名字准入进来。不再有「标记文件不存在」这道闸门:把一次性运行的闸门设在 profile 建出的那一刻,只够得着全新安装;设在标记文件不存在的那一刻,够得着全新安装加每一台已经在 rc.17 到 rc.22 上的机器——但两种设法都够不着用户在**第一次同步之后**才装进 `web` 的插件,那种插件在旧设计里会一直挂不上,因为再没有任何东西会去检查它。持续同步三种都够得着。只有一个 profile 迄今第一次跑的那次同步——也就是完全找不到标记文件的那一次——才会把 `cordis.patch.yml` 与 `pnpm-workspace.yaml` 整份复制过来,和旧版一次性迁移的做法一样;此后每一次同步都对这两个文件原样不动,这正是让它保持幂等、而不是每次启动都去覆盖一次编辑的原因。

**哪些会搬过来。**web profile 的 `dsh.profile.bundles` 里,凡是既不属于桌面模板已经列出的那两个随附 bundle、也不在 `BUILTIN_WEB_BUNDLES`、也不在 `WITHDRAWN_WEB_BUNDLES`、也还没被 `migrated`、`defective` 或 `removed` 记过的名字。内置插件、被撤下的名字,连同一次拒收,都会连名字带理由写进日志——本功能之所以存在,就是因为有人不得不逐行读客户的 `dsh-server.log` 才弄明白他的插件去哪儿了。那两个随附 bundle 是例外:每一个建出来过的 web profile 都有它们,所以写它们的那一行会出现在每一次安装的首启里,却说不出被读的那个 profile 的任何事。

**只建链接,既不复制也不安装**——本次同步追踪的每一个名字都一样,defective 的也不例外。`~/.dsh/profiles/desktop/node_modules/<name>` 会成为一条指向 `~/.dsh/profiles/web/node_modules/<name>` 的链接——指的是 web profile 的那个路径,而不是该路径当下解析到的地方。pnpm 可能把包放在任何位置、并在那儿放一条自己的链接;越过它去指里层,等于把桌面端钉死在今天这一份上,而那个路径本身会一直交出 `dsh plugin --profile web add <包>@latest` 之后装进去的东西。包仍然只住在 web profile 那一处,也只在那一处被更新。`ensureLink` 本就会建这条链接——在 Windows 上是 junction、因而需要绝对路径目标——也本就会为带 scope 的名字建出父目录。

**记录没了就重建,而不是重放。**若某个名字已经在 `dsh.profile.bundles` 里、而它那条链接正是本壳会建的那一条,就把它记回 `migrated`(若 `bundleDefect` 此刻判它有缺陷,则记回 `defective`),而不再动一次清单——静悄悄地,不写 `migrated <name> from the web profile` 这行日志,因为没有新事发生,没什么可记的。没有这一步,一份被手工删掉的标记文件——或者清单写入刚成功、标记写入却失败这种概率极低的情形——就会留下一批指向 web profile、却没有任何东西再去复核的条目。已经列出、但链接不是本壳自己那条的名字,原样保留、只留下一句 `<name>: already in the desktop profile`,因为那不是本功能该碰的东西。

只有**健康**的名字才会换来清单写入:追加进 `dsh.profile.bundles`,并把 web 清单为它声明的版本抄进 `dependencies`,这样日后的 `dsh plugin --profile desktop install` 会按同一个版本去对账,而不是把名字丢掉。这是播种里唯一会写入依赖条目的动作;模块文档里「依赖与清单里的其他字段都不会被动」那句承诺,如今明确写上了这一条例外。

**有缺陷的名字会被禁用,既不丢掉也不悄悄拒收。**`bundleDefect` 是每一次准入、每一次逐启动复核、以及插件管理服务自己那几条修复路由都读的同一个谓词,如今它答出三种缺陷之一,不再是两种:`missing`(什么都没装——从不记成 defective,因为没有东西可展示)、`not-a-bundle`(装着的版本不再声明 `dsh.bundle`),以及上面那次现场事故新加的 `entry-missing`——清单的 `exports` 或 `main` 指的入口文件盘上没有,未构建的 git 安装留下的正是这个形状。`bundleDefect` 判定有缺陷的名字保留它的链接(可查看、可修复),但从不进入 `dsh.profile.bundles`;它的条目挪进标记文件的 `defective` 列表,带着 kind、一句 `detail`,以及 `at`——首次发现的时刻,只要同一个缺陷在后续启动里还是那个缺陷,这个时刻就不会变。日志那一行是 `disabled migrated <name>: <reason>`,一个名字一次状态转换写一行,不是每次启动只要它还是 defective 就再写一遍。一个 defective 条目在启动时从不会被自动重新核对:只有插件管理服务的 `/recheck` 与 `/repair` 路由——凭用户自己的动作——才会把它提回来。

**删掉桌面这一侧的链接是一次「移除」,不是丢失。**一个 `migrated` 条目,如果不再能经 `resolveBundleDir` 会看的那三处任何一处解析到,而 web profile 自己的那份副本还在、还健康,就会挪进标记文件的 `removed` 列表,而不是被丢掉——`removed <name>: no longer linked in the desktop profile; still installed in the web profile, so it will not return on its own`。这是一块墓碑:`removed` 里的名字不会被上面那套持续同步重新准入,只有插件管理服务的 `/enable` 路由才会。web 那份副本也没了的名字——两边都没了——才是唯一没有任何东西可留的情形,会被彻底从标记文件里删掉,日志仍然写 `dropped migrated <name>: no longer resolves in the web profile`。

**patch 层要么逐字节复制,要么根本不动,而且只在第一次同步时发生。**若桌面这份 `cordis.patch.yml` 还逐字节等于播种写下的空模板、而 web profile 那份不是,web 的文件就会替换它——按字节,所以注释与 `!!js` 标签都活着过来。桌面那份若已被改过则原样保留,日志会点名该手工搬哪些插件的行。`pnpm-workspace.yaml` 同理。任何情况下都不做合并:patch 层是 loader 自有 schema 才读得懂的 YAML,把两份合起来意味着把那套 schema 再实现一遍——而且是在一个刻意不依赖任何 harness 包的 Electron 主进程里。

**每次启动都会拿 `migrated` 里还留着的每一个名字,对着一次全新准入会用的同一套三路判定重新核对。**健康的原样保留。有缺陷的照上面禁用。哪儿都解析不到的那个,则专门拿 web 那份副本去判——是立成 `removed` 墓碑,还是彻底丢掉,取决于上面那两段。这就是把「撤下内置插件」那道清理,套用到壳放进一个自己并不拥有的 profile 里的另一类条目上。用户后来自己接管的名字——桌面 profile 自有 `node_modules` 下的副本、他自己在那个路径上建的链接,或本次构建开始随包分发的包——都仍然挂得起来,于是原样保留。

**启动仍然失败的情形,由 `server.ts`/`main.ts` 隔离并重试一次。**准入和逐启动复核都读 `bundleDefect`,但两者都看不到服务端自己的 loader 拒绝 import 的每一种方式——现场事故的 `entry-missing` 这个 kind,修的是启动**之前**就能查出来的那一种;一个名字仍然可能滑过去、在启动**当下**才失败,而且是本仓库没有建模的方式(一个损坏的模块、一次原生插件不匹配,任何比「文件不见了」更复杂的情况)。所以 `startServerWithQuarantine` 会捕获 `ServerExitedBeforeUrl`——它如今带着整次启动收集到的全部输出,而不只是错误消息自己那段 15 行的尾巴——`quarantineLoadFailureFromOutput` 在里面扫描 loader 那句确切的 `failed to import loader entry <id> (<module>)`;当 `<module>` 是 `migrated` 里的一个名字,它就会带着 kind `load-failed` 挪进 `defective`、把 loader 自己那句消息记成 `detail`,把它从 `dsh.profile.bundles` 里删掉,再重新启动一次服务端——只有这一次,而且这个名字已经不在列表里了。输出里点不到名的模块,或者第二次仍然失败,都会走到原来那个启动失败页——这个解析是刻意做成精确匹配、而不是启发式的,一句形状不一样的消息,宁可留给日志给人看,也不去猜。

**四条回环路由让 Settings 能对一个 defective 或 removed 的名字动手**,每一条都是从硬盘现读现写标记文件,从不用缓存副本:`/recheck` 拿 `bundleDefect` 重新核对已链接的包,健康就提升为 `migrated`,还是坏的就把最新的理由记下来;`/repair` 先弹一个原生对话框确认,按 web profile 自己声明的 specifier 重装(从不采信调用方传来的),如果这个包仍然点着一个盘上没有的入口文件,就在它的真实目录里——用 `realpathSync` 经链接找到——跑它自己的 `build` 脚本,再删掉那次构建产生的 `node_modules` 与 lockfile,随后重新核对;`/forget` 直接删掉一个 defective 或 removed 名字的记录和它的链接;`/enable` 重新准入一个 `removed` 的名字,web 副本还健康就落回 `migrated`,不健康就落进 `defective`。这四条没有一条会自动触发——一个人没有通过这四条之一动过手的名字,就一直停在上一次同步或者上一次路由调用留下它的地方。

**Peer 版本不是本功能要管的事。**一个在更老 harness 下装的插件,未必配得上这一版。它未满足的 peer 会逐级落到 `$DSH_HOME/profiles/node_modules`,由正在跑的这次安装修复,于是它共用本次构建的那一份 cordis 而不是再解析出第二份——但它的代码是否对得上本次构建的 API,不是一条链接答得上来的问题,运行期的 peer 兜底也不会去校验它。在这里加一道检查,等于去猜一个本仓库里没有任何东西建模过的兼容关系。

## Alternatives considered

**通知用户,而不是替他迁移。**在日志里写一行,或在窗口里给个提示,点名哪些插件在 `web` 里而不在 `desktop` 里,以及哪条命令能把它们搬过来。因为受众而否决:桌面客户端的前提是一个没有终端的人,而 `dsh plugin --profile desktop add` 是一条要在没有 pnpm 的机器上、对着注册表执行的终端命令。一条无法照做的通知,结果等同于沉默,只是话更多。

**复制包目录,而不是建链接。**不再依赖一个用户能删掉的目录,于是不需要修复通道,也不会有悬空条目。因为它把包分了叉而否决:副本从此收不到 `dsh plugin --profile web` 的更新,而壳里没有任何东西会去更新它;于是搬过来的插件会永远冻结在搬运那天装的版本上,待在一个用户手里任何工具都不认识的目录里。修复通道的代价是每次启动、每个记录名字一次解析,换来的是全局只有一份副本。

**照 web 清单的 dependencies 在桌面 profile 里跑一次 `pnpm install`。**这才是 profile 体系本来就建模的结果:真实的依赖、解析好的 peer、`dsh plugin` 正常对账。直接否决:壳不许跑包安装。机器上没有 pnpm,profile 自己的 `pnpm-workspace.yaml` 出于扁平兜底所依赖的理由关掉了 `autoInstallPeers`,而在一次启动过程里跑安装,等于在用户和他的窗口之间插进一次网络操作。

**只在建出桌面 profile 时从 web profile 播种。**代码少得多——`initDesktopProfile` 里一个分支,不需要记录文件,也不需要修复。因为它解决的不是问题所在而否决:提出这份报告的客户,他的桌面 profile 早就在那儿了,建出那件事发生在三个版本之前。

**把两份 patch 层合并。**这才是对「配置」的完整回答,而不是「谁先在谁算数」:用户桌面端的行与他 web 的行同时生效。因为这个合并不是文本层面的而否决——两层都是按 id 定向的 patch 条目,同一个 id 在两份文件里出现意味着一行、而不是两行——要做对就得用 loader 的 schema 解析 YAML,再连 `!!js` 标签和注释一起重新输出。那是 `@deepseek-ai/dsh-app-boot` 的活,而本模块刻意复刻那三份模板、不去依赖它,因为依赖 harness 包的 Electron 应用会把产品闭包第二次打进 `app.asar`。那条拒收会点名要搬哪些插件的行,而这本就是一次合并无论如何都要人去复核的东西的诚实版本。

**把记录放在 profile 外面,放进应用的 userData。**它是壳自己的账本、不是用户数据,而且用户删掉 profile 它也还在。因为「删掉后还在」本身就是错的而否决:被删掉的 profile 意味着用户在要回播种后的初始状态,而这份记录只对它所在的那个 profile 里的条目才有意义。让两个文件对同一个 profile 的内容各执一词,是在等一台两者都有的机器上出 bug。

**修一道谓词,继续悄悄丢掉有缺陷的名字。**针对现场事故最小的修法:给 `bundleDefect` 加上 `entry-missing` 检查,别的一律不变——准入拒收、复核丢弃,不给用户留下任何痕迹。因为发现这个漏洞的同一次事后复盘,也发现了它一直藏着的那种失效方式而否决:客户完全无从知道自己的插件曾经存在过,唯一发现问题的办法是一行一行读原始服务端日志。一个连本仓库自己都还没摸清全貌的谓词——今天三种缺陷,下一个现场案例就会找出第四种——不该独自决定一个插件是不是就此无声无息地消失:启动不崩是必要条件,不是充分条件;可见、可修复才是让这件事对当事人变得可理解的那一步。

**让 `defective` 条目也像 `migrated` 一样,每次启动都自动重新核对。**和同步的其余部分对称,而且如果用户在壳外面手工修好了这个包,还能自愈。因为否决:一个用户还没动过手的名字,不该在两次启动之间的会话里,没有任何一次 `/recheck` 调用,就悄悄重新开始挂载——插件管理那几条路由存在的意义,就是让人来决定一个看起来修好了的包是否值得信任、可以纳入编排,而不是让下一次启动替他决定。`/recheck` 的代价是按需一次 `bundleDefect` 调用;启动时的扫一遍则会为一个标记文件本就答得上来的状态,在每一次启动上都付出一次「每个 defective 名字一次」的代价。

## Consequences

从本版之前的任何构建升上来的客户,首次启动就把插件拿回来了,不需要任何操作,也不需要终端。他拿回的是 rc.16 上的那套组合:同样的包、同样的已装版本、来自同一个目录——此后他装进 `web` 的插件,也会在下一次启动时抵达,不再只是首启那一次。

桌面 profile 现在带着一批「包住在它外面」的条目,而让这些条目保持有效是壳的责任。代价是每次启动、`migrated` 里每个被追踪的名字一次 `resolvedBundleDir` 遍历,外加每个新到达的名字一次 `bundleDefect` 调用——一个 defective 或 removed 的名字一旦被记住,就不会再被重新遍历,所以代价不会随着一个坏插件搁置的时间变长而增加。

`dsh plugin --profile web add <包>@latest` 会同时为两个 profile 更新一个迁移过来的插件,而这次更新出岔子的两种方式如今落在不同的地方:`dsh plugin --profile web remove <包>`——web 那份也没了——会让桌面那条条目彻底丢掉;升级到一个不再是 bundle 的版本,则会把它禁用为 `defective`,保留链接、保持可见,而不是丢掉。只删掉桌面这一侧的链接,则会把这个名字立成 `removed` 墓碑,而不是前两种任何一种。三种情况都不会自己回来;`/recheck`、`/repair` 与 `/enable` 才是把一个名字带回来的办法。

准入这道检查看不到的现场情形——服务端自己的 loader 在 import 时抛错,而理由比「文件不见了」更复杂——会在晚一次启动才被截获,代价是恰好一次重试,而不是又一次永久性的死循环。

在更老的 harness 下装得好好的、到这一版却出毛病的插件,这里不做拦截;撞上的人可以在 `cordis.patch.yml` 里禁用它那一行,或者在 `web` profile 里升级它。

## Testing

`apps/desktop/tests/profile-seed.spec.ts` 在一个搭出来的 `$DSH_HOME` 上、不碰 Electron 地驱动整个功能:全新安装的同步、desktop profile 由更早构建建出且没有记录的 rc.17 到 rc.22 现场案例、什么都不改的第二次启动、每一种拒收各自连同它写进日志的理由、建在 web profile 路径上而非该路径解析结果上的链接、被抄过去的依赖版本与桌面自己声明因而被保留的那一个、只在第一次同步时被复制、已被改过则被拒绝的 patch 层与 pnpm 设置、带 scope 的名字走完链接与清单两个字段、记录被手工删掉后从它自己建的链接重建回来、一次早前同步已经迁移过别的插件之后又准入一个新到达的插件,以及一份只有两个字段的旧版标记文件被读成 `defective` 与 `removed` 皆为空。一个专门的 `bundleDefect` 用例组驱动入口文件检查会读的每一种 `exports`/`main` 形状,包括那次现场事故的原样重现(`main: 'lib/index.js'`,盘上没有这个文件)。复核这组用例覆盖:包被从 web profile 里删掉、web profile 被整个删掉、包被原地升级成一个没有声明 `dsh.bundle` 的版本(如今是被禁用而不是被丢掉)、此后 bundle 版本又回来而刻意不再重新启用、桌面这一侧的链接被删掉而 web 那份副本仍然健康(立成 `removed` 墓碑,不会被自动重新同步)、两种结局各自之后的第二次启动,以及名字仍然挂得起来的三种方式——profile 自有的副本、被用户改指过的链接,以及本次构建开始随包分发的包。

`apps/desktop/tests/server.spec.ts` 用一个真实的、跑得很短的脚本化子进程(不用 `dsh` 服务端,不碰 Electron)驱动 `startServer` 与 `startServerWithQuarantine`:`ServerExitedBeforeUrl` 带着整次启动收集到的全部输出、超出错误消息自己那段 15 行的尾巴;注入的 `quarantine` 找到一个该怪的名字时重试一次;什么都没找到时不重试;一次根本不是「退出前没打印 URL 行」的失败不会重试;重试自己再失败一次时,那次失败会照原样往外传。`apps/desktop/tests/plugin-admin-repair.spec.ts` 覆盖 `/recheck`、`/repair`、`/forget`、`/enable`:每条路由在各自作用的标记列表之外都答 422、`/recheck` 提升一个已被手工修好的包、修不好时把最新理由记下来、`/repair` 的确认对话框文案、它按声明的 specifier 重装(一个 semver 范围与一个 git spec 各一次)、它的构建脚本梯子经 `realpathSync` 出来的真实目录跑并清理产生的 `node_modules` 与 lockfile、它两种具名的失败理由(没有构建脚本、没有声明版本可重装)、`/forget` 删掉一个 defective 与一个 removed 记录的链接,以及 `/enable` 依 web 副本是否仍然健康,把一个 removed 的名字重新链接进 `migrated` 或 `defective`。
