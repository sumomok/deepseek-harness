# Agent Note: 随包出厂的库知识技能

Status: implemented

[English](2026-09-03-bundled-library-skills.md) | 中文

## 问题

在基于组件库搭建的控制台上，agent 只能一次点击一次地摸清这个库的标记是什么意思：哪个图标字形是删除一行，哪个包裹元素才是真正的点击目标，哪个控件打开菜单而不是提交。这些知识在使用该库的每个部署的每个页面上都一样，而它恰恰是会话结束时被丢掉的那部分。在一台控制台上做过的配对试验量出了代价：一份手写技能把同一个任务从 30 次读降到 7 次、从 9 处错降到 0 处。

这份知识有两个看似可行的家，而这里只有一个合法。在 `packages/experimental/content-frame/src/**` 里解读厂商类名，会让 harness 跟着组件库的发布走，每多一个库就多一张表；该包出厂的文本刻意不提任何库的类名。另一个家是技能：按需加载的内容，换一份文件即可替换，运行部署的人还能覆盖它。

产品负责人 2026-09-03 的裁定排除了第三个选项：v1 不做用户维护的共享技能根。库知识随包出厂，用户自己的技能只靠已经存在的目录边界分开。

## 决定

`@deepseek-ai/dsh-experimental-library-skills` 是一个 fork 私有包，运行时内容是一个装着 SKILL 文件的 `skills/` 目录，加上一行组合配置。这一行就是普通的 `@deepseek-ai/dsh-skill-filesystem` 条目，配置 `providerName: library-skills`、`includeDefaultRoots: false`，以及指向本包自己 `skills/` 的 `bundledSkillDir`。上游包零改动，本包也不出厂任何运行时代码：`src/index.ts` 是仓库包布局要求的空模块。

`bundledSkillDir` 把根挂在 `BUNDLED_SKILL_RANK`（600），低于所有用户可写的根，且读取走 Node 而不走 `ctx.fs`。因此用户的同名技能赢两次：一次靠层，因为这一行落在注册表的全局层，而本地发现属于 agent 的 preset 层；万一某个部署把两者放进同一层，再靠 rank 赢一次。`customSkillDirs` 会把这个关系倒过来——rank 300 赢过用户自己的 400——所以它不能用来挂出厂知识。

这一行出现在五个组合文件里：本包自己的 `cordis.patch.yml`，由 `dsh plugin --profile <name> add` 安装激活；生产服务线 overlay `packages/experimental/server-sidebar/overlay/customer.patch.yml`；镜像它的两份 e2e overlay；以及只组合这一行的 `apps/web/tests/library-skills.overlay.yml`。`apps/web/tests/library-skills.e2e.ts` 断言这五处携带完全相同的一行，因此不论走哪条组合路径，出厂的知识都一致。

本包每一份技能都带 `user-invocable: false`。该键默认为真，而组合本包的那些控制台同时挂着 `ui-skill`，因此漏写的技能会变成终端用户 `/` 命令菜单里的一项——把维护者的词汇摆到面向客户的界面上。出厂库知识是面向模型的：模型通过目录找到它，想要一条斜杠命令的人则在用户根里写自己的技能，那份本来也会赢下同名。

路径从该层被安装进的 profile 出发，按包名解析：

```js
process.getBuiltinModule('node:path').resolve(
  process.getBuiltinModule('node:module').createRequire(baseUrl)
    .resolve('@deepseek-ai/dsh-experimental-library-skills/package.json'),
  '../skills',
)
```

`baseUrl` 是该行的 fiber 携带的 profile 目录，`createRequire` 会搜索该目录的 `node_modules` 及其各级祖先——同时覆盖 profile 本地安装与共享的 `$DSH_HOME/profiles/node_modules` 镜像。

因此这一行让本包成为携带它的每个组合的部署依赖，而这项依赖出问题的两种方式并不相同。解析不到本包的 profile 会在该行的 config 被插值时抛出 `MODULE_NOT_FOUND`；`boot()` 的 `assertEntriesActivated` 拒收这个失败的 fiber，控制台起不来。实测：对着一个没有本包的 harness home 跑 `dsh --profile web --patch apps/web/tests/library-skills.overlay.yml`，以 1 退出，报 `Cannot find module '@deepseek-ai/dsh-experimental-library-skills/package.json'`。安静的那种是另一种——能解析到本包、但 `skills/` 缺失或为空时，根照常挂上、什么都不列，因为 `listSkillRootEntriesFromNode` 把不存在的目录当作零条目。provider 自己不会报告这一点，于是由它之外的两处把关：e2e 的列出用例在目录为空时会红，而 `packageFileExtras` 条目强制把 `skills` 写进发布的 `files` 列表，使 tarball 不可能漏掉它。

按人隔离不在本次范围内。单进程控制台按 `$DSH_HOME` 与工作区分隔技能根，从不按人，而且该控制台里的会话对所有人可见——因此没有任何产品界面承诺某个用户的技能是私有的。等到每个用户各有自己的 `$DSH_HOME` 和进程，按人分隔自动成立，不需要任何代码。

### 架构决策闸

| 格 | 本决定 |
|---|---|
| 已定原则替它说的 no | fork 的上游零改动令排除了对 `packages/skill/*` 的任何修改，落点只能是 fork 包加组合。「插件里不写死可调项」排除了固定路径常量。「组合优先于代码」排除了 fork 自写目录扫描器，因为 `skill-filesystem` 已经在扫目录、解 frontmatter、做监听。 |
| 新增面数 | 两个：一个只有资产的包，一行组合。provider、事件、工具、路由、Config 字段、UI 面、审批闸、依赖各为零。真实的carrying cost：双语 README 及其配对记录、版本对齐，以及每个包都要付的 `hygiene` 门禁。 |
| 能验证它对不对的最小版本 | 一份占位技能、那一行，以及四条断言：技能进入某个 agent 的目录、能按名加载、用户同名技能替换它、移走该行后它消失。 |
| 缝还是写死 | 挂载点是已经存在的缝——三个既有 `Config` 字段，其中一个的文档写的正是这种隔离 provider 用法。**内容**则刻意写死为 SKILL，且不会变成代码。一个包放多个库；provider 天然扫整个根。 |
| 边界 | 库知识归技能，页面与业务知识归用户自己的根，工具缺陷归缺陷清单——混在一起意味着为了改一句关于某个客户页面的话而发一次包。出厂技能永不携带客户数据、真实记录标识、主机名、绝对路径或凭据形状，因为本包会到达每一个安装它的部署。天花板：不做热更新、不按部署裁剪、不做 A/B；若一个季度内纯文案修改逼出超过三次发布，则重新评估。天花板：一机一用户一进程上线前，不做按人可见性。 |

本包需要的登记都很普通：`tsconfig.base.json` 的路径别名、`tsconfig.host.json` 的 project reference 与测试 include、`apps/web/tsconfig.json` 的 exclude、实验组 README 的索引行，以及 `scripts/check-workspace-constraints.ts` 的 `packageFileExtras` 条目。最后那个文件在本 fork 上已经带着一条已登记的行为补丁（`.claude/core-patches.md`，`cd77abb2a5`）；本行属于数据登记而不是登记册素材，但下次上游同步要在同一个文件里一并对账两者。

必须点名本包的部署流程写在 `packages/experimental/server-sidebar/README.md` 的 Composition 一节——customer overlay 需要能解析到的其他包已经列在那里。那是唯一的家：没有任何部署脚本枚举它们，overlay 的属主包也没把它们声明成 dependencies，所以在这里发明一条 manifest 边等于新造机制，而不是沿用既有的。

## 片 0 实测到什么

设计稿读代码定不下来的四件事，各自跑一遍得到结论：

**`!!js` 表达式里的 `createRequire` 能解析到包目录。** 本仓 YAML 中此前无先例。对着一棵合成的 profile 目录树打的探针确认：`createRequire(baseUrl)` 传目录 URL 时会同时搜索 `<profile>/node_modules` 与 `<profile>/../node_modules`，因此一条表达式同时覆盖 profile 本地安装与共享镜像。环境变量回退形（`!!js process.env.DSH_LIBRARY_SKILL_ROOT`，即 `content-column.patch.yml` 给应用根用的形式）在任何地方都不需要，包括 e2e 通道——那里由测试创建与生产安装相同的 profile 链接。

**只有资产的包按原样过不了仓库门禁。** `verify-package-invariants` 需要 `tsconfig.json`；`check-workspace-constraints` 需要 `main`、`types` 以及指向 `lib/index.js` 与 `lib/types/index.d.ts` 的 `exports["."]` 配对；`files` 是推导出来的，因此要发布 `skills/` 就必须在该门禁的 `packageFileExtras` 表里登记一条，与 `skill-badge` 的 `assets` 并列；而省略不变式伴生入口需要 README 里那句「No … companion is published」。因此本包带一个空的 `src/index.ts`，与 `agent-team-profile` 完全一致。

**组合后的树把这一行放在全局层，用户技能放在 preset 层。** `dsh --profile web --dump-config` 显示 `skill-filesystem` 与 `tool-skill` 被 `@deepseek-ai/dsh-web-app` 在 `@deepseek-ai/dsh-base` 之上禁用、一行默认 `standard` 的 `agent-presets`，以及作为 profile 树顶层扁平行的本行。e2e 钉住的是它的后果而不是这份 dump：不带 scope 的目录视图答的是出厂那份，同一个 agent 带 scope 的视图答的是用户那份。

**`skill-badge` 在本服务线里没有启用。** `packages/bundle/base/cordis.patch.yml` 出厂即 `disabled: true`，没有任何 overlay 重新打开它，dump 也确认它保持关闭。即使开着也能无冲突共存：provider 名不同，rank 相同。

## 备选方案

**在 `apply()` 里自己注册一个 provider 的插件。** `skill-badge` 是可用的先例，它用 `import.meta.url` 解析自己的资产——完全不需要 `!!js`。但它只登记一份写死的技能。要支持一整个目录，就得在 fork 里重写 `skill-filesystem` 的发现、frontmatter 解析与监听：多一个面、撞克隆检测，还要为上游已有的代码付逐文件覆盖率。

**用 `ctx.skills.register()` 注册运行时技能。** 直接排除：运行时注册的 rank 是 250，排在用户自己的 300/400/500 各根之前，用户就无法用同名技能替换出厂知识。这与整个决定所依据的裁定正好相反。

**用 `customSkillDirs` 而不是 `bundledSkillDir`。** 同样是把关系倒过来，只是路径不同——rank 300 赢过 `$DSH_HOME/skills` 的 400——而且读取会经过 `ctx.fs`，更严格的文件系统后端可以把包目录遮住，且只会记一条告警。

**`DSH_BUNDLED_SKILL_DIR` 环境根。** 仓库零文件，但知识不再随包走：升级不带来新内容，回滚不带回旧内容，一个变量无法同时服务桌面线与服务线，也没有任何门禁能证明技能与代码配套。

**`!!js process.env.DSH_LIBRARY_SKILL_ROOT` 路径形。** 备好的回退方案，与 `content-column.patch.yml` 的应用根同形。实测让它变得不必要，而且它会把路径重新拴回部署侧——包名解析刚刚把它解开。

**用户维护的共享技能根，外加从个人到共享的晋升通道。** 早前的提案。产品负责人在 v1 否决了它：出厂知识不能放在任何人可写的目录里，因为放进去一份文件就等于给每个部署的模型上下文加一条指令。

## 后果

知识与代码同版本、可回滚、可审计，代价是零 TypeScript 与零上游改动。它换来的代价：改一句话就是一次发包加一次重新部署；已经开着的会话不承诺拿到新目录；本包还要付仓库对每个包的固定税——双语 README、配对记录、版本对齐、`hygiene`。

耦合审计多一条：**厂商类名的合法落点是 `packages/experimental/library-skills/skills/` 之内，其他任何地方都不是。** 出厂技能正文会自由地写出组件库的类名——那正是这份内容的全部职责，它按需加载而不常驻，用户还能替换它。`description` 是例外，因为它常驻会话的每次请求：在那里点名组件库是必要的，模型要靠它判断该不该加载，但一串具体类名不该写进去。`packages/experimental/content-frame/src/**` 仍须命中零次厂商类名；本包不含代码，不进那次代码审计。

今天出厂的技能是 `library-skills-placeholder`，正文只说明接线是通的。下一片用真的库知识替换它：由 agent 自写，并在进包前由人按去标识标尺复核。

## 测试

`apps/web/tests/library-skills.e2e.ts` 无密钥、无浏览器、无需录制：它把这一行组合到真实的 Web profile 上，挂载一个由 preset 组合出来的 agent，然后读 `ctx.skills`——正是 `dsh-tool-skill` 渲染目录消息与 `skill` 工具结果所用的那个视图。它钉住：出厂技能以 `provider: library-skills`、`source: bundled` 与 `{ modelInvocable: true, userInvocable: false }` 出现在目录里；正文与 metadata 能按名加载；写进 `$DSH_HOME/skills` 的用户技能在 agent 视图里替换它，而全局层仍答出厂那份；不带这一行的组合里没有这份技能。另有两个不启 scaffold 的用例：一个把五个组合文件钉在同一行上，一个拿链接了本包与没链接本包的两个 profile 目录去求值出厂的 `bundledSkillDir` 表达式。

最后那个用例在子进程里求值，因为「解析不到本包」这件事在测试进程内根本发生不了：vitest 把 pnpm 的扁平 store 目录导出在 `NODE_PATH` 上，于是每个工作区包都进了 `Module.globalPaths`，这条表达式从任何目录都能解析成功。同一个原因也排除了通过 scaffold 断言这次失败。另有两个事实决定了这个用例的形状：web scaffold 的落定检查是 `assertEntriesLoaded`，只拒收没有 fiber 的条目，因此 config 抛错的那一行会以失败状态起来而 scaffold 照常继续；`boot()` 跑的是 `assertEntriesActivated`，那才是让这件事在部署里致命的东西。子进程从出厂的 patch 里读出这条表达式而不是照抄一遍，因此把它改写成会吞掉这次失败的形态时，该用例会红。

本场景不占语料条目。`snapshots/web/*` 里的场景是带 golden 的录制会话；这里的每条主张都关于会话开头的目录，不需要任何一次模型轮次。
