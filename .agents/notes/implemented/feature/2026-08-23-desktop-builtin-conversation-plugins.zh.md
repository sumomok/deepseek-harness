# Agent Note: 桌面端自带引用与改问重跑

Status: implemented

[English](2026-08-23-desktop-builtin-conversation-plugins.md) | 中文

## Problem

对一个已经打开的对话做的两件事,web GUI 都没有,而这两件事用户在头一个小时里就会去找。

**引用更早的一段话。**输入框的 `@` 菜单能够到工作区文件和别的会话([web 文件与会话引用](2026-07-27-web-file-and-session-references.zh.md)),却够不到你正身处其中的这个对话里的任何东西。长线程里的一个代词——「把你列的第二个问题修一下」——要模型把上面所有内容重读一遍,再猜你指的是哪一条;用户实际做的修补是把那段话选中、手工粘回去。粘回去的文字没有任何东西表明它是对模型自己更早那段回答的引述,于是用户想做的那次引用,模型看不见。

**改写更早的那个问题。**用户气泡上的编辑按钮曾作为一个背后无物的桩被移除,[移除它的那篇 note](../simplification/2026-07-31-drop-user-message-edit-stub.zh.md) 写着:等能力齐了再把控件放回来。没有谁放回来。同一行上的分支控件是在回答**之后**切开的,与「改写我的问题」正好相反,于是 GUI 真正提供的两种修补是:在最下面重新问一遍——错的那次交流仍留在模型上下文里;或者从头开始——把原本好用的那部分一起丢掉。

两个缺口都在客户端一侧,都不是 harness 的缺口:回答它们所需的缝——输入触发器注册表、conversation 各个插槽、`sessions.fork`——都是已发布的,而且本仓库里已经有了。缺的是一个用它们的插件,以及一条让桌面端用户不开终端就能拿到它的路。

## Why not an existing plugin

围绕这两项能力对社区注册表做过调研,没有任何候选同时做到可用、安全、有人维护。拒绝的理由归为三条。

**改宿主 DOM 与截键。**候选插件用 `MutationObserver` 伸进宿主渲染的消息气泡里,并吞掉输入框的 Enter 键,于是 web 客户端的标记或按键处理一变,它们就无声地坏掉,而插件挂载期间输入框的行为也不再是宿主自己的那套。

**自定义会话事件却不带 `ignorable: true`。**把自己的事件类型写进会话日志的插件,一旦被卸载,它碰过的每个会话就再也读不出来了:`SessionEventMap` 成员默认是读时必需的,不认识这个类型的构建会拒绝整份日志,而不是跳过那一行。

**不带鉴权的自更新路由。**候选插件注册一条宿主路由,由它去拉取自己的新副本并写进磁盘,任何能够到服务端的东西都能够到它——这就是在 agent 已经在跑的那台机器上任意执行代码。

## Decision

两个插件都像它们之前那五个内置插件一样随载荷分发,并且都不新增任何宿主面。

**`@haoran/dsh-quote-message` 0.1.0** 通过它 README 描述的两个入口,把当前会话里更早的内容送进输入框:在任意聊天消息里选中一段文字会抬起一个 `Quote` 药丸,点它就往草稿里追加一个引用 chip;在输入框里打 `@` 则多出一个「本会话消息」分组,可以挑一整条消息。这个 chip 的渲染与内置的 `@file`、`@session` chip 一致,只在提交时才展开,展开成一段以 `[quote #12 assistant message msg_01J…]` 起头的 markdown 引用块——会话事件位次、角色,以及宿主记下的消息 id——上限 4000 个码点,来源更长时附一条截断说明。这行抬头随发送那一刻的界面语言走。宿主记下的,是展开后的提示词本来就是的那条普通 `user/message`。

**`@haoran/dsh-edit-rerun` 0.1.0** 在每个已完成回合的操作行上、复制与分支旁边放两个按钮:一个打开一个预填了原问题、供你改写的子会话,另一个直接发出去。它的边界规则就是它语义的全部,它的 README 用一句话写明:子会话包含到被改写的那个问题所在回合的**前一个**回合为止的全部内容,不含那个问题自己那一回合的任何部分。具体做法是取严格早于该问题的最后一个已完成回合的 `turn/end`,在那里调 `sessions.fork({ atSeq })`,于是种入的日志正好停在被替换的那一回合将要开始的位置,重新问一遍不可能把问题问重。开启会话第一个回合的问题没有更早的边界,于是插件改为接上工作区的空白会话并预填问题,而不是 fork。原会话从不被修改。

**两个都只有客户端一半,这正是它们带起来便宜的原因。**每个包的宿主那一半都是一个空的 `apply`,存在的意义只是让 loader 挂载一个真正的 cordis 插件、让 web 插件表找到它的 `dsh.client` 声明。两者都不新增宿主路由、remote 命名空间、工具、服务或会话事件;都不读文件系统,也都不自行开连接。它们用的是已发布的客户端面:`slots`、`sessions`、`locale`,引用另加 `inputTriggers`、首回合那种情况另加 `workspaces`,渲染进 `conversation.chat.assistant-actions` 与 `conversation.input.dock`,引用还用到带 `ReferenceCodec` 的 `slash/input-insert-reference` 事件。两者都不装 `MutationObserver`、都不截键;它们从宿主渲染结果里读的唯一一个属性是 `data-chat-flow-key`,那是 web 客户端为自己的滚动锚定放在每一个聊天行上的。

**载荷按已经就位的规则把它们带上。**`apps/desktop-server/package.json` 把两者各声明成一条 `file:` 标识符,指向提交在 `vendor/` 下的 tarball,因为两者都没发布,而 `pnpm deploy` 拒绝没有 `integrity` 哈希的 lockfile 条目。`scripts/bundle-closure.ts` 在一个包自己的清单声明了 `dsh.bundle` 时把它整个保留并加进 external,这正是可达性遍历不会删掉一个没人 import 的包的原因——而整个保留,也正是让每个 `lib/client.js` 保持它的 client 构建留下的样子的原因:把它按 `platform: 'node'` 重打一遍,会在文件顶上加一句 `import ... from 'node:module'`,浏览器从此再也走不到下面。

**构建门禁一处都不用改,而它证明的东西变多了。**`verifyClientModules` 是从暂存载荷里每个内置插件自己的清单读 `dsh.client`,不是从一份名单读,所以把这两个包写进 `BUILTIN_WEB_BUNDLES` 就是全部的声明:它要求出现在所服务 index 点名的 client 模块里的内置插件数从两个变成四个,而这四个各自的响应体都必须通过 `window.__ModuleLoader__` 自行注册、并且不 import 任何 Node 内置模块。它那一条下限——至少有一个内置插件声明了 `dsh.client`,这项检查才不是空的——未变。

**两个浏览器半在运行时 require 的每一个模块都在壳的静态表里。**`PLATFORM_MODULES`(`packages/client/web/src/platform.ts`)把 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots` 与 `@deepseek-ai/dsh-client-ui-primitives` 共享进冻结的模块表,而这些正好就是这两个 bundle 调 `require` 所用的标识符。两者都没有声明 `dsh.client.external`,对一个不索取该基线之外任何东西的包来说,这才是正确的声明。它们的 `dsh.client.inject` 列表是信息性的图元数据,不是模块边;其中点到的每个包——`@deepseek-ai/dsh-client-runtime`、`-locale`、`-ui-conversation`、`-ui-input-trigger`、`-ui-slots`——要么由 `@deepseek-ai/dsh-web-app` 的 patch 层挂载,要么就在那张静态表里,而且每一个今天都已经被 `dsh-at-file` 或 `dsh-better-sidebar` 点到过。

**两个名字都播种在 `@haoran/dsh-default-model` 之前**,这样在全新 profile 上那个包仍是最后一层 bundle,也就是[当初给它的位置](2026-08-23-desktop-builtin-default-model.zh.md),好让它去落定前面几层不去碰的条目。顺序其实两边都不花钱:两个新层都只 `insert` 一行插件,谁都不去 patch 任何别的层设过的 id,所以把这两个名字追加在 default-model 层之后的已有 profile,编排出来的结果是一样的。

## What an existing installation sees

`seedBuiltinBundles` 把缺的两个名字追加到 `dsh.profile.bundles` 已有内容之后,并把两个包各链接进 `$DSH_HOME/profiles/node_modules`,除此之外什么都不做。profile 的 `cordis.patch.yml`、它的依赖,以及清单里其他每个字段都不被碰,所以一台已经在跑桌面构建的机器会在下次启动时拿到这两项功能,编排上没有别的变化。两个插件都没有可供部署方调整的 `config` 块,所以事后也没有什么要用户去设。

已有会话在两个方向上都不受影响。两个插件都不读也不写属于自己的会话日志格式,所以它们挂载时旧会话不会有任何变化;而在它们挂载期间录下的会话,日后要读也不需要它们在场——引用是一条普通 `user/message` 里面的引用块,重跑则是一个普通子会话,带着宿主为每次 fork 都会记的谱系。

## Alternatives considered

**交给 `dsh plugin --profile desktop add`。**这是受支持的安装路径,而它需要终端、能用的 pnpm,以及一份能拿到的 tarball——而这份 tarball 不在任何注册表上。这和当初把侧栏、`@` 提及、权限网关放进载荷的理由是同一条,失败在同一个人身上:为了不开终端才装桌面客户端的人,照着这条路走不下去。

**等这两项能力进上游。**两者最终都该在 web 客户端里——编辑控件是 harness 自己清出来、并写明在等能力的一个座位,而引用当前会话则是 `@file` 与 `@session` 旁边缺的第三个域。作为「现在什么都不发」的理由则被否决:上游拥有的是每个 CLI 安装都要编排的已发布面,有它自己的节奏;而这两个是一个部署的产品决定,对本仓库的成本是两个 tarball 与几行清单。哪一个真进了上游,内置插件就撤掉,它填的那个座位交还给上游那一个。

**只发其中一个。**引用改动更小、也更安全。否决,因为它们从相反的两侧回答同一句抱怨——一个修补问错了的问题,一个免去把问对了的重新打一遍——单发其中一个,另一个就只剩上面那条安装路径可走。

## Consequences

两个插件的版本都归安装包所有,和其他每个内置插件一样:换一个新版本意味着在插件工作区里构建它、提交 tarball、把 `file:` 标识符指过去,再发一个桌面构建。vendor 的 tarball 是唯一的更新渠道,因为两个包都不在任何注册表上。

载荷多出两个页面在启动时加载的 client bundle,也就是浏览器模块图上多两次 `/plugins/<name>/client.js` 请求,以及仓库里大约 62 KB 的已提交归档。

两个插件把 peer 钉在 `>=0.1.0-rc.1 <0.2.0-0`,构建时对着的是 `@deepseek-ai/*` 的 `0.1.1-rc.2`。宿主越过 `0.2.0` 会把它们推出所声明的范围,但真正要紧的失败不是范围检查,而是插槽被改名:`conversation.chat.assistant-actions` 与 `conversation.input.dock` 是改问重跑注册进去的两个座位,它会在注册时大声失败,而不是渲染到错的地方去。本仓库没有任何门禁会拿这两个插件去对插槽改名,所以信号是暂存启动的 client 模块检查,加上打开一个会话看看。

引用是往草稿末尾追加,而不是在光标处插入,因为输入机器发布的是草稿文本与一个修订计数,不含光标位置。改问重跑对提问里带了图片或附件的回合不给按钮,对仍在分页加载的转录里最早那个已加载回合也不给,因为在那里 fork 会切错位置。这两条限制都是插件自己的,记在它们各自的 README 里;本仓库不做宿主改动就抬不动其中任何一条。
