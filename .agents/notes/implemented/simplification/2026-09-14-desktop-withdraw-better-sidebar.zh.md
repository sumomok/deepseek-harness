# Agent Note: Withdrawing the vendored right sidebar

Status: implemented

[English](2026-09-14-desktop-withdraw-better-sidebar.md) | 中文

## 问题

桌面端同时分发着两个右侧栏。上游的 `ui-sidebar-right` 是随附 web 应用的一部分，它把「打开侧边栏」按钮注册进 `conversation.session.header.corner` 这个槽（[`packages/client/ui-sidebar-right/src/client/index.ts`](../../../../packages/client/ui-sidebar-right/src/client/index.ts)）。贩售进来的 `dsh-better-sidebar` 在它旁边挂了第二块面板——用的是自己 `document.body` 下的 `<div data-dsh-better-sidebar>`，而不是一次槽注册——它的「展开侧边栏」与「展开底部面板」两个开关就浮在同一个角上。一条屏幕边缘，两块面板，两套控件，而且没有任何东西能把它们调和掉：插件那一块根本不在头部角落所仲裁的槽系统里。

## 决策

0.1.0-rc.33 只分发一个右侧栏，就是上游那一个。`dsh-better-sidebar` 整个退出载荷：`apps/desktop-server/vendor/` 下的 tarball、[`apps/desktop-server/package.json`](../../../../apps/desktop-server/package.json) 里它的 `file:` 标识符，以及 [`pnpm-workspace.yaml`](../../../../pnpm-workspace.yaml) 里的 `dsh-better-sidebar>node-pty` override，全部删除。那条 override 只为这一个插件存在；harness 内核自己把 `node-pty` 钉在 `1.2.0-beta.15` 的那份声明与 `patches/node-pty@1.2.0-beta.15.patch` 不受它离开的影响。

名字是从 [`apps/desktop-shell/src/profile-seed.ts`](../../../../apps/desktop-shell/src/profile-seed.ts) 的 `BUILTIN_WEB_BUNDLES` 移进 `WITHDRAWN_WEB_BUNDLES`，而不是两处一起消失。服务端会解析 `dsh.profile.bundles` 里的每一个名字，解析不到就直接让启动失败，所以 0.1.0-rc.32 播种过的 profile 碰上一个悄悄删名的构建就起不来。`pruneWithdrawnBundles` 把条目从清单里取走，并移除壳自己为它建的扁平兜底链接，而且只清理壳自己留下的东西：指向本次载荷以外任何位置的链接会保留，包只要仍能解析，它的 bundle 条目也会保留，所以用 `dsh plugin --profile desktop-shell add` 装的副本会照它自己的归属继续工作。同一次启动的 `web` profile 同步会以 `withdrawn, not migrated` 跳过住在那里的副本，所以用户为 CLI 装的插件不会被这次改动拽进桌面 profile。

这个插件不声明任何自有会话事件——它的源码里没有任何东西并入 `SessionEventMap`——所以它挂载期间写下的会话日志不会点到本次构建读不了的类型。rc.32 上记录的对话照常打开。

## 为什么不能反过来关上游那一个

`sidebarRight` 是 Chat 目标的必需服务，不是可选项：[`packages/client/ui-chat/src/client/apply.ts`](../../../../packages/client/ui-chat/src/client/apply.ts) 把它列在 `inject` 里，没有提供方，Chat 目标就根本不会装配，对话视图整个渲染不出来。同一个文件里，聊天正文中的每一个文件链接都经 `ctx.sidebarRight.openResource` 打开。留着插件、关掉上游那块面板，意味着 fork `ui-chat`，这与本 fork 对上游核心的既定铁律正相反。

## 用户失去了什么

`dsh-better-sidebar` 0.18.0-alpha.0 是一整个工作台而不是一块面板，它们一并离开：懒加载的文件浏览器、能存回磁盘的 CodeMirror 编辑器、图片/PDF/Markdown 的内嵌预览（含 Mermaid 渲染）、跑在 `node-pty` 上的真终端标签页、Git 面板、内嵌浏览器、后台任务页，以及 Side Chat 旁路线程。它还发布了一个供别的插件注册侧栏页与文件查看器的服务；本载荷里没有别的东西消费它。它那八个 `terminal_*` 工具随之而去——它们只在用户打开 `agentTerminalTools`（默认关）时才注册——随之而去的还有随包分发的工具里唯一一族进程跑在壳未清洗的 `process.env` 而非 `scrubbedParentEnv()` 上的东西。

## 备选方案

**藏掉插件自己的开关，两块面板都留着。**那组开关是插件渲染进自己 body 级宿主里的，藏它就意味着写一条针对别人包内部标记的样式规则——插件下一次发版就会无声失效，而且第二块面板、它那些 document 级按键监听、它那八个工具依然全都挂着。这只处理了促成这次决定的那个症状，没碰后面的重复本身。

**在播种的 patch 层里禁用它那一行，而不是把包撤下。**在 `@deepseek-ai/dsh-desktop-app` 的层里写一行 `disabled: true` 能让它不挂载，但包仍留在载荷里，那是一个 3.48 MB、解包后带 12.35 MB 客户端产物的 tarball、那条 `node-pty` override，以及一个用户可以自己重新打开、从而撞回同一场冲突的插件。真正拿掉这份编排的是撤下；禁用行只是一个默认值，而这个决定不该让用户去反悔。

**只把名字从 `BUILTIN_WEB_BUNDLES` 删掉，别的什么都不加。**rc.32 播种过的每一个 profile 仍然列着这个名字，`resolveBundleDir` 会对它让启动失败，于是每一台升级上来的客户端等到的不是少一块面板，而是一个起不来的应用。`WITHDRAWN_WEB_BUNDLES` 正是为这种过渡而存在，`@sumomok/dsh-edit-rerun` 就是先例。

**重打一个剥掉侧栏面板的插件贩售进来。**文件工作台、终端、Git 面板与 Side Chat 全挂在那块面板上，剪完之后剩下的是一个没有任何界面的包。为了保住一个没人消费的服务而维护一个 0.18.0-alpha 插件的分叉，代价是上游每发一版就要重打一次补丁，换回来的是零功能。

## 后果

载荷少了这个插件和它自己的闭包。重锁之后，`@codemirror/*`、`cosmokit@1.8.1` 与无作用域的 `schemastery@3.18.0` 从 `pnpm-lock.yaml` 里消失，它们没有别的消费方；`@xterm/headless` 留着，因为 `packages/terminal/terminal-bash` 也依赖它。

重锁同时收走了十三个同级插件借以解析客户端 peer 的那批工作区链接。`pnpm-lock.yaml` 设了 `autoInstallPeers: true`，而 `dsh-better-sidebar` 是唯一把 `@deepseek-ai/dsh-client-locale`、`-ui-slots`、`-ui-conversation`、`-ui-primitives` 与 `-ui-settings` 声明为非可选 peer 的贩售插件，pnpm 因此把这五个装到 `apps/desktop-server` 这个 importer 上，每个同级插件的可选客户端 peer 也就解析到同一批工作区链接。它一走，`link:packages/client/locale` 在锁文件里从十三处变成零处，`dsh-client-*` 从每个同级插件的 peer 后缀里消失。运行时没有任何东西读它们：十三个里带宿主半边的那十二个，`lib/index.js` 都不 import 任何 `@deepseek-ai/dsh-client-*`，`@haoran/dsh-default-model` 根本不带代码，而每个浏览器半边都从客户端模块表解析自己的 import——`apps/desktop-shell/tests/vendored-client-runtime.client.spec.ts` 对每一个播种的内置插件都把那张表物化出来并跑了 apply。

`WITHDRAWN_WEB_BUNDLES` 里的这一条，要留到不再可能有 0.1.0-rc.32 或更早的安装升上本构建为止。提前删掉它并不会弄坏全新安装——它只是不再去修那些仍然列着这个包的 profile，而那正是它存在要防住的失败。

内置插件的数目写在没有任何解析器会读的散文里。[`apps/desktop-shell/README.zh.md`](../../../../apps/desktop-shell/README.zh.md) 与它的英文对照件在五处带着这个数——分发多少个、其中多少个有浏览器那一半、分别是谁、profile 清单列了什么、`web` profile 里已经有什么——这次全部人工更新。`vendored-plugin-versions` 那道闸只覆盖表格的行。

## 相关

[桌面安装包分发插件并把它们播种进自己的 profile](../feature/2026-08-21-desktop-builtin-plugins.zh.md) 拥有「内置插件为什么在载荷里」以及 `WITHDRAWN_WEB_BUNDLES` 对已经有它的 profile 做什么；[贩售插件引用闸](../process/2026-09-03-vendored-plugin-reference-gate.zh.md) 拥有「README 表格与署名 overrides 必须与清单一致」这道检查，正是它让删掉的行成为一次硬失败而不是一处陈旧。
