# Agent Note: The permission rows an old shell copied into the desktop profile are retired

Status: implemented

[English](2026-09-17-retire-seeded-permission-patch-rows.md) | 中文

## Problem

一台跑着 0.1.0-rc.33 的桌面客户端,给出的仍是 2026-08 那套访问方式:仅可查看 / 工作区内修改 / 完全权限 / 自动审查,就按这个顺序,`yolo-access` 的描述仍是沙箱完全关闭，文件系统与命令不再有操作系统层面的围墙……。`@haoran/dsh-llm-permission-gateway` 0.4.3 声明的是另一套顺序的四行——有墙、没墙但还问你、没墙也不问——被审查那一行也换了自己的名字与描述。这些一样都没到这台机器上。

盖住它的文件是 `~/.dsh/profiles/desktop-shell/cordis.patch.yml`,最后一次写入在 2026-08-27,里面装着一条带整张预设表的 `- id: permission`,外加一行 `llm-permission-gateway`。profile 自己的 patch 层是倒数第二层——每一个 bundle 层都在它之前生效——所以那里一条以 id 为目标的条目会替换整个 `config`,插件那张表就永远不生效。产品里没有任何东西会从那个文件里把一行取回去:`WITHDRAWN_WEB_BUNDLES` 与 `web-migration.json` 够得着的是 bundle 名字与链接,从来不是 patch 层的内容。

这两行是壳自己留下的,走的是 [`copyPristineProfileFile`](../../../../apps/desktop-shell/src/profile-seed.ts) 说明的那条路。一个 `desktop-shell` profile 迄今第一次跑同步时,会把仍是空模板的那份 patch 层逐字节换成 `web` profile 的文件,而在这台机器上,`web` 层正是 [2026-08-22 那份网关记录](../feature/2026-08-22-desktop-builtin-permission-gateway.zh.md)写下的那份手写文件:`yolo-access` 与这道门,靠一句请阅读的人别把两个块拆开的注释配在一起。0.1.0-rc.21 把这两行搬进了包里(`1229bc8049`,`apps/desktop-server/vendor/haoran-dsh-llm-permission-gateway-0.1.3.tgz`),六天之后,首次同步把这台机器自己那份副本抄进了如今盖住这个包的那个 profile。

那台机器上那份文件的确切字节不在本仓库里。`git log -S 'only defensible while' --all` 在这里什么都匹配不到,`git log -S 'yolo-access' -- apps/` 只匹配到三个随包 tarball;壳自己的 `PROFILE_PATCH_TEMPLATE` 从来就是那份空的 `[]` 层。能取回来的是 0.1.3 的那份 patch 层,它的两条条目逐字段就是那套手写配对所声明的东西,而那台机器自己的头部注释是对这份文件自带注释的转述。

## Decision

`apps/desktop-shell/src/profile-seed.ts` 里的 `retireSeededPermissionRows` 对每个 profile 只跑一次,排在 `syncWebBundles` 之后,这样本次启动抄进来的副本在同一次启动里就被取回去。它读 profile 的 patch 层,把仍恰好是 0.1.3 那层声明的两行之一的条目拿掉,再把其余部分写回去。

匹配看的是内容,不是文件字节:一个识别器把一条顶层条目读成映射、序列,以及朴素或简单引号的标量,凡是含义要靠 loader 自己那套 YAML schema 才定得下来的一律拒读——标签、块标量、flow 语法、重复键、制表符。读出来的东西按每个映射的键排序后序列化,再与那两行相比,所以同样的字段配同样的取值,不论当初按什么顺序写下都算匹配。顺序不属于一份抄件的身份——把这一行拿掉,正是让随包分发的预设顺序回来的办法。

一次移除会带走条目本身、紧写在它上面的那段注释,以及紧跟在它下面的空行。文件里其余的一切——别的条目、`!!js` 表达式、文件主人自己的文字——逐字节留在原处。除此之外别无他物的一层会变回那份空模板;只剩注释的一层会补上这些注释原本注解的那个 `[]`,因为 loader 把这个文件读成一个顶层数组。

任何一处有出入的行都是文件主人的,会留下,并在日志里给出理由:`skipped cordis.patch.yml: the permission preset table is not the one this shell wrote; left exactly as it is`。网关那一行上的裁判路由也算——有人改过的 `model` 就让那一行成了他的。发生移除时打印 `retired the permission preset table from cordis.patch.yml`,来自新增的 `SeedReport.retired`。

这个决定作为 `permissionPatch` 记进 `web-migration.json`——`removed`、`kept` 或 `absent`——它在,就是后续启动不再读这个文件的依据。完全没有标记文件的 profile 不会在这里得到一个:标记文件在不在,正是 `syncWebBundles` 读作「这个 profile 同步过」的那个依据,凭空造一个会压掉 web profile 那两个文件仅此一次的抄送。这样的 profile 下次启动会再读一次,代价是一次文件读取与一次跟模板的比较;而仍是那份模板的 patch 层根本不会被解析。

## Alternatives considered

**把插件那张表合进 profile 这一层,而不是把条目拿掉。**这样能留住那条条目携带的其他东西。这也意味着要把一份 patch 层解析出来跟另一份合并,那是把 loader 自己那套 YAML schema 再实现一遍——正是 `copyPristineProfileFile` 抄文件而不合并文件的理由,从那个函数写下时就写在那里。这里的识别器只读到够认出壳自己留下的东西为止,其余一概拒读,这是一个小得多的承诺。

**拿整个文件跟一份随包模板逐字节比对。**这是能定的最严的规则,也不需要识别器。它永远不会命中:机器上的那些字节来自一份手写的 `web` 层,它的注释措辞与包里那份并不一样,而本仓库从来没有装过它们。一条连自己存在的唯一理由都匹配不到的规则,不叫保守。

**干脆让首次同步不再抄 `web` 的 patch 层。**这能让下一台机器不再染上这两行。它修不好任何一台已经有了的机器,还会放弃这次抄送的全部目的:把文件主人自己的行随他的插件一起搬过来。

**在插件里给这个预设改 id,让陈旧的副本盖不住它。**一份钉在 `yolo-access` 上的副本,确实就盖不住一个改了名字的行。`permission.defaultPreset` 存在一个对这张表里的名字做闭合联合的 schema 下,而 `SettingsProvider.register` 面对 schema 不再接纳的已存小节是拒绝安装,所以改名会让存过它的人整个 `permission` 设置小节装不上——这正是[四档访问方式那份记录](../feature/2026-09-17-gateway-four-access-modes.zh.md)保留这个 id 的理由。

**不管 `config` 写了什么,一律把网关那一行拿掉。**这一行的身份就是插件名,而 bundle 层本来就声明了这一行,所以 profile 里的这份副本除了重复之外什么也没加。那里的 `provider` 与 `model` 可能是有人特意选过的裁判路由,而这个壳没有任何办法把一条路由和一份残留分开。留下一条改过的行,代价是一行日志;拿掉一条,代价是一项没人要求丢掉的设置。

**给从未同步过的 profile 造一个标记文件。**这能让一份留着某行的手改层不必每次启动重读。标记文件在不在是 `syncWebBundles` 本来就在读的一个标志,提前写一个会压掉那个 profile 对 `cordis.patch.yml` 与 `pnpm-workspace.yaml` 仅此一次的抄送。而那次重读不过是一次 `readFileSync` 加一次字符串比较。

## Consequences

抄过这两行的客户端在下一次启动就拿回随包分发的那张访问方式表,不用终端,也不用手改 YAML,patch 层里其余每一行照留。改过其中任何一行的客户端会留着它,并被告知是哪一行、为什么;在有标记文件把这个决定记下来之前,每次启动告知一次。

`MigrationMarker` 多了一个可选字段。它是 `@haoran/dsh-plugin-updates` 读的跨组件契约,所以这个字段是叠加的,没做决定之前不存在,并且 `readMigrationMarker` 与 `syncWebBundles` 写出的标记都会把它带着走。

这个识别器是壳的,不是 loader 的:被它拒读的条目会原样留下,这是安全的那个方向,但也意味着一台副本里用了标签或不常见引号的机器会继续被盖着,只在日志里说明,而不会被修好。

## Testing

`apps/desktop-shell/tests/profile-seed.spec.ts` 里每个用例都经 `seedBuiltinBundles` 驱动,那两行照 0.1.3 的 patch 层逐字铺好:两行都被拿掉而文件主人自己的行与注释完好;它们就是整个文件时留下那份空模板;只剩文字时补上 `[]`;一张改过的表被留下并给出跳过行,而它旁边的网关那一行照样被拿走;一张字段按另一种顺序写下的表仍然匹配;一条改过的裁判路由被留下;一条 `!!js/eval` 路由被留下;标记文件里已经有决定时,哪怕两行还在文件里也读了就照办;没有标记文件的 profile 被取回却没有因此多出一个标记文件;以及仍是模板的 patch 层根本不被读。
