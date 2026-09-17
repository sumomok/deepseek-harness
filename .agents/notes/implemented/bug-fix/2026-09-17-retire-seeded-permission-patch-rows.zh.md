# Agent Note: The permission rows an old shell copied into the desktop profile are retired

Status: implemented

[English](2026-09-17-retire-seeded-permission-patch-rows.md) | 中文

## Problem

一台跑着 0.1.0-rc.33 的桌面客户端,给出的仍是 2026-08 那套访问方式:仅可查看 / 工作区内修改 / 完全权限 / 自动审查,就按这个顺序,`yolo-access` 的描述仍是沙箱完全关闭，文件系统与命令不再有操作系统层面的围墙……。`@haoran/dsh-llm-permission-gateway` 0.4.3 声明的是另一套顺序的四行——有墙、没墙但还问你、没墙也不问——被审查那一行也换了自己的名字与描述。这些一样都没到这台机器上。

盖住它的文件是 `~/.dsh/profiles/desktop-shell/cordis.patch.yml`,最后一次写入在 2026-08-27,里面装着一条带整张预设表的 `- id: permission`,外加一行 `llm-permission-gateway`。后面那一行是以 id 为目标的 `- id: llm-permission-gateway`,而不是包自己那份 `- insert:`——一份对着已经挂载了这个插件的构建写下的层,取的正是这种形态。profile 自己的 patch 层是倒数第二层——每一个 bundle 层都在它之前生效——所以那里一条以 id 为目标的条目会替换整个 `config`,插件那张表就永远不生效。产品里没有任何东西会从那个文件里把一行取回去:`WITHDRAWN_WEB_BUNDLES` 与 `web-migration.json` 够得着的是 bundle 名字与链接,从来不是 patch 层的内容。

这两行是壳自己留下的,走的是 [`copyPristineProfileFile`](../../../../apps/desktop-shell/src/profile-seed.ts) 说明的那条路。一个 `desktop-shell` profile 迄今第一次跑同步时,会把仍是空模板的那份 patch 层逐字节换成 `web` profile 的文件,而在这台机器上,`web` 层正是 [2026-08-22 那份网关记录](../feature/2026-08-22-desktop-builtin-permission-gateway.zh.md)写下的那份手写文件:`yolo-access` 与这道门,靠一句请阅读的人别把两个块拆开的注释配在一起。0.1.0-rc.21 把这两行搬进了包里(`1229bc8049`,`apps/desktop-server/vendor/haoran-dsh-llm-permission-gateway-0.1.3.tgz`),六天之后,首次同步把这台机器自己那份副本抄进了如今盖住这个包的那个 profile。

那台机器上那份文件的确切字节不在本仓库里。`git log -S 'only defensible while' --all` 在这里什么都匹配不到,`apps/` 下唯一带着这两行完整字节的文件是那三个随包的网关 tarball;壳自己的 `PROFILE_PATCH_TEMPLATE` 从来就是那份空的 `[]` 层。能取回来的是 0.1.3 的那份 patch 层,它的两条条目逐字段就是那套手写配对所声明的东西,而那台机器自己的头部注释是对这份文件自带注释的转述。

## Decision

`apps/desktop-shell/src/profile-seed.ts` 里的 `retireSeededPermissionRows` 对每个 profile 只跑一次,排在 `syncWebBundles` 之后,这样本次启动抄进来的副本在同一次启动里就被取回去。它读 profile 的 patch 层,把仍恰好是 0.1.3 那层声明的两行之一的条目拿掉,再把其余部分写回去。

匹配看的是内容,不是文件字节。每一条顶层条目由 `js-yaml` 在 `FAILSAFE_SCHEMA` 下单独解析。那个解析器就是 loader 自己用的那个:`vendor/include/src/index.ts` 读 patch 层用的是 `js-yaml` 的默认 schema 外加一个注册进去的 `tag:yaml.org,2002:js` 标量类型,所以 loader 的方言 = 这个解析器的方言 + `!!js`,不注册那个类型来读,拒绝的恰好就是含义要靠 loader 自己 schema 才定得下来的条目——`!!js` 或任何别的标签、重复键、制表符。逐条目解析,是一条读不了的条目不牵连文件其余部分的原因。读出来的东西按每个映射的键排序后序列化,再与那两行相比,所以同样的字段配同样的取值,不论当初按什么顺序写下都算匹配。顺序不属于一份抄件的身份——把这一行拿掉,正是让随包分发的预设顺序回来的办法。

一次移除会带走条目本身、紧写在它上面的那段注释,以及紧跟在它下面的空行。文件里其余的一切——别的条目、`!!js` 表达式、文件主人自己的文字——逐字节留在原处。除此之外别无他物的一层会变回那份空模板;只剩注释的一层会补上这些注释原本注解的那个 `[]`,因为 loader 把这个文件读成一个顶层数组。还留着别的东西的一层原样返回,所以一份把数组写成 `[]` 而不是块序列的文件不会多出第二个顶层节点;而每一种答案都以恰好一个换行结尾。

网关那一行两种形态都会被匹配——包的 `- insert:` 与以 id 为目标的 `- id:`——条件相同:每个字段都是随包分发的那个值。以 id 为目标的那一种并不是看上去那样一份无害的重复:这样一条 patch 会替换整行的 `config`,所以一份带着 0.1.3 的 `provider` 与 `model` 的副本会把那条裁判路由钉死,并丢掉此后某个版本在自己那一行上设的每一个 `Config` 字段。任何一处有出入的行都是文件主人的,会留下,并在日志里给出理由:`skipped cordis.patch.yml: the permission preset table is not the one this shell wrote; left exactly as it is`。网关那一行上的裁判路由也算——有人改过的 `model` 就让那一行成了他的。发生移除时打印 `retired the permission preset table from cordis.patch.yml`,来自新增的 `SeedReport.retired`。

这个决定作为 `permissionPatch` 记进 `web-migration.json`——`removed`、`kept` 或 `absent`——它在,就是后续启动不再读这个文件的依据。完全没有标记文件的 profile 不会在这里得到一个:标记文件在不在,正是 `syncWebBundles` 读作「这个 profile 同步过」的那个依据,凭空造一个会压掉 web profile 那两个文件仅此一次的抄送。这样的 profile 下次启动会再读一次,代价是一次文件读取,以及常见情形下一次跟模板的比较:仍是那份模板的一层根本不经解析就判为 `absent`,并像别的决定一样记下来。

## Alternatives considered

**把插件那张表合进 profile 这一层,而不是把条目拿掉。**这样能留住那条条目携带的其他东西。但合并要的不只是读,还要写——一次经 loader 方言(`!!js` 节点在内)、且保住注释的往返——那才是 `copyPristineProfileFile` 抄文件而不合并文件时回避掉的那个「把那套 schema 再实现一遍」。读一条条目把它认出来,是比重写它小得多的承诺。

**用手写的逐行扫描器而不是解析器来认这两行。**这件事的第一版就是这么做的:139 行,把条目读成映射、序列以及朴素或简单引号的标量,拒绝标签、块标量、flow 语法、重复键与制表符。它平白违反了「优先用有人维护的依赖,而不是自己手写」——`js-yaml` 本来就是 `apps/desktop-shell` 的运行期依赖(`src/theme.ts`、`src/updater.ts` 都在 import 它),而且正是 loader 读 patch 层用的那个解析器,所以换过去不多一个包、不多一个版本、asar 也不多一克。它还恰好是没人测过的那一半:对这个文件跑一次 `--coverage.include`,报出的未覆盖行里有 30 条落在那个扫描器的拒绝分支上,而 `apps/` 不在覆盖率门禁内(`vitest.config.ts` 只 include `packages/*/*/src`),所以永远不会有门禁逼它们跑起来。那个扫描器与解析器仅有的两处行为差异,两次都是扫描器错了:它拒绝块标量、拒绝值里带 ` #` 的行,而 loader 把前者读成字符串,把后者读成一个后面跟了注释的值。

**用 `yaml`(eemeli)解析整份文件,按每个节点的 `range` 去切。**它给出每一个顶层项的字节偏移,这样删条目就不必自带逐行扫描。可是它从 `apps/desktop-shell` 解析不到——`yaml` 是三个 `packages/` 工作区声明的,不是这个 app 声明的,用它就意味着往 asar 里多塞一个包。它还丢掉了这里需要的逐条目粒度:重复键是文档级错误,制表符缩进会给出 `UNEXPECTED_TOKEN` 并把所有条目并成一项、其 `range` 被截断,按那个 range 去切会毁掉文件。要把逐条目拒绝找回来,还是得逐条目切片再解析——那正是 `js-yaml` 在这里做的事,而且不多塞包。

**拿整个文件跟一份随包模板逐字节比对。**这是能定的最严的规则,也不需要识别器。它永远不会命中:机器上的那些字节来自一份手写的 `web` 层,它的注释措辞与包里那份并不一样,而本仓库从来没有装过它们。一条连自己存在的唯一理由都匹配不到的规则,不叫保守。

**干脆让首次同步不再抄 `web` 的 patch 层。**这能让下一台机器不再染上这两行。它修不好任何一台已经有了的机器,还会放弃这次抄送的全部目的:把文件主人自己的行随他的插件一起搬过来。

**在插件里给这个预设改 id,让陈旧的副本盖不住它。**一份钉在 `yolo-access` 上的副本,确实就盖不住一个改了名字的行。`permission.defaultPreset` 存在一个对这张表里的名字做闭合联合的 schema 下,而 `SettingsProvider.register` 面对 schema 不再接纳的已存小节是拒绝安装,所以改名会让存过它的人整个 `permission` 设置小节装不上——这正是[四档访问方式那份记录](../feature/2026-09-17-gateway-four-access-modes.zh.md)保留这个 id 的理由。

**不管 `config` 写了什么,一律把网关那一行拿掉。**这一行的身份就是插件名,而 bundle 层本来就声明了这一行,所以 profile 里的这份副本除了重复之外什么也没加。那里的 `provider` 与 `model` 可能是有人特意选过的裁判路由,而这个壳没有任何办法把一条路由和一份残留分开。留下一条改过的行,代价是一行日志;拿掉一条,代价是一项没人要求丢掉的设置。

**给从未同步过的 profile 造一个标记文件。**这能让一份留着某行的手改层不必每次启动重读。标记文件在不在是 `syncWebBundles` 本来就在读的一个标志,提前写一个会压掉那个 profile 对 `cordis.patch.yml` 与 `pnpm-workspace.yaml` 仅此一次的抄送。而那次重读不过是一次 `readFileSync` 加一次字符串比较。

## Consequences

抄过这两行的客户端在下一次启动就拿回随包分发的那张访问方式表,不用终端,也不用手改 YAML,patch 层里其余每一行照留。改过其中任何一行的客户端会留着它,并被告知是哪一行、为什么;在有标记文件把这个决定记下来之前,每次启动告知一次。发现这件事的那台机器两行都会掉:它的网关行正是以 id 为目标的那一种,而里面每个字段都是随包分发的那个值。

`MigrationMarker` 多了一个可选字段。它是 `@haoran/dsh-plugin-updates` 读的跨组件契约,所以这个字段是叠加的,没做决定之前不存在,并且 `readMigrationMarker` 与 `syncWebBundles` 写出的标记都会把它带着走。

被 failsafe schema 拒读的条目会原样留下,这是安全的那个方向,但也意味着某台机器的副本在那一条里带了标签、重复键或制表符时,它会继续被盖着,只在日志里说明,而不会被修好。

## Testing

`apps/desktop-shell/tests/profile-seed.spec.ts` 里每个用例都经 `seedBuiltinBundles` 驱动,那两行照 0.1.3 的 patch 层逐字铺好:两行都被拿掉而文件主人自己的行与注释完好;它们就是整个文件时留下那份空模板;只剩文字时补上 `[]`;一张改过的表被留下并给出跳过行,而它旁边的网关那一行照样被拿走;一张字段按另一种顺序写下的表仍然匹配;一条改过的裁判路由被留下;一条 `!!js/eval` 路由被留下;标记文件里已经有决定时,哪怕两行还在文件里也读了就照办;没有标记文件的 profile 被取回却没有因此多出一个标记文件;仍是模板的一层不经解析就判为 `absent`;网关行以 id 为目标的那种形态被取走,而这种形态带着文件主人自己的路由时被留下;一条无关条目自带的注释提到网关时被读作不是这个壳的任何一行;一张改过的表按它声明的 id 命名,而不是按它描述里提到的网关;被删的行处在文件末尾时留下恰好一个换行;以及已经有一个 `[]` 的一层不会再多出一个。
