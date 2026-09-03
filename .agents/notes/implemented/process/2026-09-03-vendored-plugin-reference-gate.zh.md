# Agent Note: Vendored plugin reference gate

Status: implemented

[English](2026-09-03-vendored-plugin-reference-gate.md) | 中文

## 问题

桌面端的内置插件只声明一次——作为 [`apps/desktop-server/package.json`](../../../../apps/desktop-server/package.json) 里形如 `file:./vendor/<扁平化包名>-<版本>.tgz` 的依赖——却在两处没有任何东西会重新生成的地方被复述:[`scripts/gen-third-party-notices.ts`](../../../../scripts/gen-third-party-notices.ts) 里的 `OVERRIDES` 表,其中的 vendor 路径会成为 `THIRD_PARTY_NOTICES.md` 里的归属链接;以及 [`apps/desktop/README.zh.md`](../../../../apps/desktop/README.zh.md) 及其英文对照里的内置插件表。

重新 vendor 一个插件的动作是:提交新 tarball、删掉旧的、把标识符指过去。两处复述都被落在原地,而且两处都已失真:内置插件表十一行里有七行写的版本比它旁边的 tarball 更旧——`@haoran/dsh-clickable-refs` 写 `0.3.3`,提交进来的却是 `0.4.1`;`dsh-better-sidebar` 写 `0.15.2`,还说是从 npm 装的;`dsh-at-file` 写 `v0.6.5`,还说是作者仓库里的一个提交——同时有两条 `OVERRIDES` 指向早已不存在的 tarball 文件名,于是 `THIRD_PARTY_NOTICES.md` 带着两条指向归档的死链,而归属正是它存在的理由。什么都没红,因为根本没有东西在检查。

## 决策

[`scripts/verify-vendored-plugin-versions.ts`](../../../../scripts/verify-vendored-plugin-versions.ts) 把 desktop-server 的 manifest 作为唯一的记录依据,并拿每一处复述与它核对。它作为 `doc-sync` 的 `vendored-plugin-versions` 叶子门禁运行(也在不需要构建的 `doc-quick` 聚合里),与其余 `verify-*` 文档门禁并列。

契约是 tarball 的文件名,而不是归档内部的 `version` 字段。`dsh-better-sidebar-0.18.0-alpha.0-patched1.tgz` 与 `dsh-at-file-0.7.0-da602d1.tgz` 内部的 manifest 都声明着一个朴素的上游版本号;后缀才是把本仓库分发的这份字节与同号上游发布区分开的东西,也正是读者据以找到该文件的东西。门禁从文件名里剥掉 `pnpm pack` 的包名前缀(`@haoran/dsh-clickable-refs` → `haoran-dsh-clickable-refs-`)得到版本,并拒绝文件名不带自身包名的标识符,因为从那样的文件名里读不出版本。

由此得出这些断言:每条 `file:` 标识符都指向 `./vendor/` 下一个存在的 tarball;每条 `repo` 是 vendor tarball 路径的 `OVERRIDES` 都指向存在的文件;每张表对每个 vendor 包恰好一行、且不含任何别的行,于是一个被撤下的插件不会留下一行孤儿;每一行的版本格都等于版本 code span 加上该文档的来源短语,于是一行不可能版本没错、来源却退回去说自己来自 npm 或某个 Git tag。行按包名匹配,所以调整行序或改写描述都不会惊动门禁。

这些规则是纯函数,输入是 manifest 文本、README 文本、覆盖表,以及由调用方提供的存在性探测,因此[对应的 spec](../../../../scripts/verify-vendored-plugin-versions.spec.ts) 用 fixture(测试前置数据)钉住每一种拒绝,不碰文件系统。`OVERRIDES` 为此从声明生成器导出,而不是另抄一份:那些路径的第二份副本,正是这道门禁要拦的失真。

两张 README 表都会读,各带自己的小节标题与自己的来源短语。配对门禁替代不了第二次读:它的结构签名只数表格的行数与列数,不看单元格里的文字,所以只改中文一侧的版本再重录,它照样是绿的。

## 考虑过的替代方案

**由 manifest 生成 README 表格。** 版本列是可推导的,但它旁边的描述列是两种语言的手写产品文案,整张表又嵌在一节散文中间。为一份其余部分皆为手写的文档去生成其中一列,代价是一个生成器、一套围栏协议和一条翻译豁免,换掉的却是一个装得进单个文件的检查。

**放进 [`scripts/gen-third-party-notices.spec.ts`](../../../../scripts/gen-third-party-notices.spec.ts) 断言**,一如声明文件自身的新鲜度那样,不占新的调度位。但那个 spec 管的是披露内容,README 行与 manifest 标识符都不是。更糟的是,失败会出现在测试 lane,而不是 `doc-sync`——后者才是改文档的人真正会跑的聚合。

**从每个 tarball 内部的 `package.json` 读版本。** 恰恰在最需要说清来源的那两个包上,它与文件名不一致——一个是打了补丁的发布版,一个是未发布的提交——还会逼着 README 写出一个在 `vendor/` 里找不到对应文件的版本。每跑一次门禁就解开十一个归档,读到的还不如文件名已经说明的多,这笔账不划算。

**顺便拒绝 `vendor/` 里没有任何标识符指向的 tarball。** 那确实是一类真实失真,但它是另一类,而且会拒绝一种正当的中间状态:重新 vendor 时先放好新归档、还没改 manifest。这里每一条断言都以 manifest 为记录依据,那一条却会把目录列表变成第二个依据。

## 后果

此后重新 vendor 一个插件,要么把两张 README 表——以及 tarball 名字变了时的那条声明覆盖——一并带上,要么 `doc-sync` 报红,并给出点名文档、包与和它矛盾的那个 tarball 的一行。这项检查只读文本——不安装、不解包——所以耗时以毫秒计,也因此进了快速聚合。

表里写的版本不是应用报出来的版本。`-patched1` 与 `-da602d1` 只活在文件名里;每份归档内部的 manifest 写的是 `0.18.0-alpha.0` 与 `0.7.0`,装进去的是这个,`@haoran/dsh-plugin-updates` 渲染的更新页看到的也是这个。点名归档才能让读者找到实际分发的那份字节,这处不一致就是它的代价。

只有表格进了门禁。表格周围的散文里仍带着解析器看不见的计数与版本字面量——分发了几个插件、其中几个带浏览器那一半、分别是哪几个、侧栏 `0.14.0` 的下限,以及 shadowing warning 里引用的版本——所以把「十一个里有九个」改成「三个」,门禁照样是绿的。这些由本次改动手工核对。

`OVERRIDES` 从此是声明生成器模块接口的一部分。改动它的形态会波及这道门禁,而这正是有意为之的耦合:两个文件描述的是同一批 tarball。

门禁靠各自的小节标题和 `` | `包名` | `版本` `` 的行文法来读每一张表。重构其中任一节都会让门禁明确报红,而不是默默通过——因为读不出表格本身就算一次违规。

## 相关

[桌面安装包内置插件,并把它们播种进一个自己的 profile](../feature/2026-08-21-desktop-builtin-plugins.zh.md) 负责这些内置插件为什么在载荷里,以及 profile 自己那一份副本会怎样;[让 vendor 插件脱离已退役的 client runtime](2026-09-01-desktop-server-vendored-plugins-off-client-runtime.zh.md) 负责给其中大多数换上当前归档的那一趟。两篇都不在本门禁的解析范围内:它们由本次改动手工核正。
