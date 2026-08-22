# Agent Note: 桌面端分发权限网关,预设随插件一起走

Status: implemented

[English](2026-08-22-desktop-builtin-permission-gateway.md) | 中文

## Problem

`@haoran/dsh-llm-permission-gateway` 在 `tools/pre-execute` 上把每一次有副作用的工具调用交给一个单独配置的审查模型判断,而 `tools/pre-execute` 是唯一能看到调用参数的扩展点。正是它让 `{sandbox: danger-full-access, approval: ask}` 这样的权限预设站得住脚,而它只活在一台机器上:用 `dsh plugin --profile web add` 手工装进去,再由一份手写的 `~/.dsh/profiles/web/cordis.patch.yml` 配置——那份文件同时定义了与这道门配对的 `yolo-access` 预设。

rc.17 把桌面客户端挪到了它自己的 `desktop` profile 上,理由记在[内置插件那篇](2026-08-21-desktop-builtin-plugins.zh.md)里。桌面端不再编排 `web`,于是也不再编排这个网关,预设跟着一起没了。没有任何东西提示这件事:预设控件里就是不再有自动审查,工具调用就是不再被审,唯一的证据是一个曾经配好的功能现在不在了。

文档给出的补救办法是 `dsh plugin --profile desktop add <tarball>`,再把一份配置文件复制进新 profile——一个终端、一份能用的 pnpm、一次手工编辑 YAML,而这三样恰恰是桌面客户端存在的意义:让人不需要它们。这与侧栏和 `@` 提及被放进载荷所依据的是同一条理由,只是这次落在一个权限功能上。

有两点让它比「侧栏不见了」更糟。一个留着 `yolo-access` 却没有这道门的 profile,严格差于单纯的 `danger-full-access`:文件全开、没有模型审查,而 `ask` 策略仅剩的作用,是把 `never` 本会直接拒掉的那些残余审批请求送到一个毫无上下文的人面前。而这个配对没有任何东西强制——它只是用户自己那份 patch 文件里的一段注释,请阅读的人别把两个块拆开。

## Decision

插件像另外三个内置插件那样随载荷分发,预设则随插件走。

**载荷。**`apps/desktop-server/package.json` 把 `@haoran/dsh-llm-permission-gateway` 声明为 `file:./vendor/haoran-dsh-llm-permission-gateway-0.1.3.tgz`,该 tarball 与它一起提交,`BUILTIN_WEB_BUNDLES` 列出这个名字,于是 `apps/desktop/src/profile-seed.ts` 会在服务端启动之前把它播种进 `desktop` profile。pnpm 只为 `file:` tarball 记录 `integrity` 哈希,而 `pnpm deploy` 拒绝没有该字段的 lockfile 条目——截图插件被 vendor 而不是去取,也是同一个原因。`scripts/bundle-closure.ts` 按它本就有的规则完整保留这个包:清单声明了 `dsh.bundle` 的包是 profile bundle,载荷里没有任何东西以标识符导入它。暂存启动的 client 模块检查会跳过它,因为它没有声明 `dsh.client`——工具是 agent 去调用的,不是页面去加载的。`THIRD_PARTY_NOTICES.md` 用一条指向该 tarball 的仓库相对链接标识它,这条记在生成器的覆盖表里。

**播种能够到已经出问题的那些机器。**`seedExistingManifest` 只把缺失的名字追加在清单已列内容之后,别的一概不改写,所以一个由 rc.17 建出来的 `desktop` profile 会在下次启动时多出这一个名字,同时保留它自己的 `cordis.patch.yml`、它的依赖,以及每一个不归壳所有的字段。没有这一点,这次修复就只能到达全新安装,而丢了这个功能的恰恰是那些曾经拥有它的安装。

**预设写在插件自己的 patch 层里。**包里的 `cordis.patch.yml` 贡献两行:门本身,以及加入了 `yolo-access` 的 `permission` 行预设表。于是挂载这个 bundle 才是让预设存在的动作,移除这个包会一步带走两半。这道门无法察觉自己的缺席——没挂载的插件不运行任何代码——所以「一个 patch 文件同时装下两行」是这个耦合唯一能成立的地方。

以 id 为目标的 patch 会替换目标行的整个 `config` 而不是并入其中,所以那一层把 `@deepseek-ai/dsh-base` 编排的三个预设原样重述了一遍,旋钮值不变。这份重述的副本就是会过期的东西:base 若发布了新增预设、改名或改动旋钮组合,都会被这个文件遮住直到它被更新,而症状是预设控件不声不响地一直提供旧表。`apps/desktop/tests/builtin-permission-gateway.spec.ts` 先单独编排 dsh-base 那一层,再把网关那一层叠上去,并把三个基础预设与 dsh-base 自己编排出的结果相比——而不是与写死的字面量相比——所以 base 侧的改动会在那里失败,而不是被发出去。

**`yolo-access` 是被提供的,从不是被强加的。**这条 patch 不设 `defaultPreset`,并把 `yolo-access` 声明在最后。`PermissionPresetService` 推断默认值的方式,是拿编排出的沙箱与审批默认值按声明顺序去表里找第一个匹配项;而 dsh-base 的两个旋钮都由同一个 `DSH_PERMISSION_MODE` 表达式导出:它的编排能产生的组合只有两种——模式不是 `danger-full-access` 时该模式配 `ask`,以及 `danger-full-access` 配 `never`。两者都不是这个预设的组合,所以那个环境变量取任何值,都不会让新会话落在它上面。桌面壳根本不设这个变量,所以新会话被钉住的是 `workspace-write`。

`{danger-full-access, ask}` 也是这个预设唯一可能的组合。`{danger-full-access, never}` 已经是 `danger-full-access` 了,而该服务是靠在表里查旋钮值来解析预设的,所以两个条目共用一组旋钮时会双双解析成 `custom`,谁都不再可命名。何况 `ask` 本身是更好的失败模式:一个完全敞开的沙箱不会自己产生任何越权升级,所以这条策略在正常使用中是静默的,只在审查模型说自己拿不准时才现身。

**插件的两个 schema 默认值按实测上调。**`maxArgumentsChars` 从 8000 改为 200000,`timeoutMs` 从 20000 改为 30000,落在插件的 `0.1.3`。2026-08-21 实测:`code` 预设的 `run_code` 调用常规带 9-10K 字符参数,所以旧上限拦下的恰恰是最该被审的那些调用,并把每一个都变成一次人工审批——这个默认值把插件本身的用途给废了。`deepseek-v4-flash` 把 200K 字符的调用整包审完约需 5-8 秒,30 秒够用。`reasoningEffort` 保持 `off`,这不是调参而是承重的:开了思考,256 token 的输出预算会被推理吃掉,裁决 JSON 被截断,而截断是失败关闭,于是症状是每一次调用都弹审批框。

## Why not a preset registry

本仓库自己的规矩是「注册即 effect」,所以最先尝试的是通过 `@deepseek-ai/dsh-permission-presets` 上一个返回 disposer 的 `register()` 把 `yolo-access` 贡献进去。没有这样一条缝。`PermissionPresetService` 在构造函数里一次性读取 `Config.presets`,存进私有字段,并就地由它派生出设置 schema、projection 单元与 `/permission` 命令;「预设表是进程级的」正是它自己 README 记下的局限之一。加一个注册表意味着改动 `packages/` 下的包,那是一个有自己归属者的内核决定,不是一次插件改动可以顺手做掉的。

如果将来真有第二个插件需要贡献预设,那仍是更好的形态:以 effect 注册的预设会把上面那份重述连同它的过期风险一起删掉,并让挂载与卸载插件直接增删该条目,完全不必去碰另一个插件的配置。

## Alternatives considered

**交给 `dsh plugin --profile desktop add`。**这是受支持的安装路径,而它就是问题本身的复述:它需要一个终端、一份能用的 pnpm,以及一个够得到的 tarball 来源。为了避开终端才装桌面客户端的人跟不了这套步骤,而这个功能之所以曾经丢过一次,恰恰就是因为它依赖一条手跑的命令。

**让壳把预设播种进 profile 的 `cordis.patch.yml`。**壳在创建 profile 时本来就会写这个文件,所以它也可以顺手写下预设那一行。两重理由否决。壳会因此拥有另一个插件的配置,把一张插件专属的表放进 Electron 主进程,并让这个配对重新横跨两个仓库。而且播种刻意从不改写已存在的文件,所以每一台已经有 `desktop` profile 的机器——也就是每一台出问题的机器——patch 文件里依旧不会有这个预设。

**把 `yolo-access` 设为默认值。**唯一拥有过这个功能的那台机器实际上就是这么用的,设置 `defaultPreset` 能让每次安装都直接拿到同样的效果,少点一下。否决:那等于替每一个桌面构建的每一个用户、在他们没有做出任何决定的情况下,悄悄把操作系统沙箱关掉。这个预设的位置在选择器里,选中它必须是一个动作。

**把基础预设重述在桌面 profile 自己的 patch 层,而不是插件的。**这样插件的 patch 文件就只剩门那一行。以「壳来播种预设」同样的理由否决:profile 是壳只写一次的用户数据,所以这份重述到不了已存在的 profile,而预设又会重新变得可以比插件活得更久。

## Consequences

现在每一次桌面安装都带着一个「被选中时会关掉操作系统沙箱」的预设。选中它意味着审查模型成为 agent 与文件系统之间唯一的东西,于是安全性变成那个模型判断质量的属性,而不再是沙箱的属性——这正是这个预设要提供的取舍,只是现在够得到它的人多了。编译进插件的两条红线,凭据外泄与对权限系统自身的改动,不受这一切影响,也配置不掉。

在这个预设被选中期间,每一次有副作用的工具调用都要花一次 `deepseek-v4-flash` 的审查调用,记在与会话相同的凭据上。只读工具从不送审,一次裁决是单轮而不是一段对话,参数完全相同的重复调用在该 agent 本次运行的剩余时间里复用同一个裁决。

vendored tarball 就是这个插件的更新渠道。一个新版本意味着在插件工作区里构建、提交 tarball、把 `file:` 标识符移过去,再发一次桌面构建;携带某次构建的安装包拥有该版本,与其余每个内置插件一样。

只禁用门那一行、却不把预设一并去掉,会造出这次改动正要防止的那个状态——一个把沙箱关掉、背后却没有任何审查的预设。patch 层拦不住用户在自己那一层里写下这种配置,因为用户层在所有 bundle 层之后应用,所以 `apps/desktop/README.zh.md` 把它写明为唯一一个不该单独禁用其行的内置插件,并说明怎样把预设一起从控件里去掉。
