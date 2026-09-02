# Agent Note: The product-console line on the 0.1.2-alpha.4 base — composition over accommodation

Status: implemented

[English](2026-09-02-server-console-on-the-alpha-4-base.md) | 中文

## Problem

`product/server-console` 这条线由九个 `packages/experimental/*` 包组成，它们把出厂外壳、侧边栏与内容列替换成一套面向客户的控制台，另有八个浏览器场景钉住它。它此前钉在 0.1.1 时代的基座上。迁到 0.1.2-alpha.4 跨过了一次包退役（`dsh-client-runtime` 拆成五个归属）、一次把工作区导航移到本线刻意移除的那个插件背后的服务搬迁、若干 Session API 改名，以及一次浏览器测试脚手架变更。在新基座上这条线编译不过；编译过了起不来；起来了八个场景一个也不过。每一处修复都要回答同一个问题：是在我们自己的包里迁就基座、给基座打补丁，还是改组合加载什么。

## Decision

每一处修复都落在组合层或本线自己的包里。两个上游文件带着改动，均已在 `.claude/core-patches.md` 登记并写明退役条件，其中一个修的是上游自己的缺陷而不是迁就它。

**客户端词汇搬到了哪里。** `@deepseek-ai/dsh-client-runtime` 退役、拆进五个归属；八个符号跨 29 处 import 迁移。`ClientContext` 现在是 `@deepseek-ai/cordis` 的 `Context`；`SessionId` 来自 `dsh-session/types`；`defineStore` 与 `EngineStoreHandle` 来自 `dsh-client-store`；`SessionProjectionMap` 来自 `dsh-session-projection/types`；`SlotRegistry` 来自 `dsh-client-ui-renderer/client`；`SessionListState` 来自 `dsh-api-session-controller/client`；`ToolCallBlock` 来自 `dsh-client-ui-chat/client`。每个包的 `dsh.client.inject` 改为点名该包真正触达的服务归属，而不是那个已退役的聚合包。`settingsNamespace()` 已删除且命名空间键不变，因此 `'server-sidebar' as SettingsNamespace` 是纯字符串替换，已落盘设置不需要迁移。`Session.events` 现在是 `snapshotEvents()`，`SessionEvent.seq` 变成 branded 类型，聊天界面则从 Session 快照的一个字段变成 `dsh-client-ui-chat` 自己的会话标准 hook。

**`gen-tsconfig-paths` 无法为包名与目录名不一致的包生成别名**，而本线九个包全部如此（`<dir>/` 目录下的 `dsh-experimental-<dir>`）。按上游对自己的 inspector 与 Agent Teams 包已有的做法，别名手写在生成块之上。本次迁移真正需要的逐包改动，是按每个包 `src` 实际 import 重新推导它的 `references` 列表，而不是拆分 Host/Client 配置。`docs/development.md` 把那种拆分只留给 `api/remotes`，并明确写着「同时拥有 Node 加载入口与浏览器入口不构成拆分理由」。

**严格 session 作用域的槽必须包在标准套件的 `SessionProvider` 里。** `ShellFrame` 的详情列渲染了一个这样的槽，缺了它渲染器会抛 `SlotAssemblyError`，而且不是那一列挂不上——整个外壳一个格子都不渲染。

## `ui-workspace` 是被组合的，词汇由一条 CSS 规则承担

alpha.4 把 `dsh-client-ui-conversation` 的客户端注入从 `workspaces` 控制器换成了 `ui-workspace` 的 `uiWorkspace` 服务。本线三份 overlay 原本彻底禁用 `ui-workspace`，为的是让工作区词汇不出现在客户页面上；在 alpha.4 下这会让对话列以及五个兄弟行都无法激活。三份 overlay 现在都组合它。

当初为之禁用的那些词汇，不禁用也已经被盖住。它的 `sidebar.workspaces` 注册走 `ctx.slots.inject`，那是声明门控的，而本外壳不声明这个槽，于是这一半永久失效。它的 `conversation.hero.workspace` 注册确实会落地，落在一行被 `terminology-guard.ts` 隐藏的界面里。那条规则从此不再是双保险，而是唯一挡住真实工作区标题与可用选择菜单出现在页面上的东西，因此它的场景断言那个元素**既存在又不可见**：这份样式表里每条规则都是对 CSS module 局部类名的子串匹配，它失效的方式就是元素不再匹配，而只断言不可见的写法，在元素根本不存在时同样通过。

输入框的权限 chip 经另一条路径说出了工作区：出厂的 `permission` 预设表，由该 chip、`/permission` 弹窗与 Settings 默认行共同显示。没有任何字典触达得到它——那个标签属于 `dsh-client-ui-conversation` 自己的 locale 命名空间，而 locale 注册表对已持有的命名空间/语言对会在第二次注册时抛错，因此任何插件都无法遮蔽另一个插件的键。两个客户端界面在宿主给出的预设名与内置默认不同时都会原样渲染，所以 overlay 用面向客户的名字重述整张预设表，这个词就同时离开了所有界面。`PresetSpec.name` 是单个字符串而不是语言映射，因此所有 locale 拿到同一个名字。

有一处泄漏没有缝可走：没有连接任何工作区时，`ConversationRoot` 会以 `placeholder.workspace` 渲染它那个不可用的输入框。它不是该隐藏的装饰——那个状态下输入框确实不能用，而这句占位文字是唯一在说明这件事的东西——部署侧的答案是：没有工作区的控制台本来就是空操作，因此服务线部署总是带着一个。有一个场景把这处泄漏钉在那唯一一句占位文字上，以免出现第二处而无人发现。

## 什么可以照抄上游，什么绝不可以

`recentWorkspace`——决定新会话落在哪个工作区——是 `ui-workspace/src/client/navigation.ts` 里的模块私有函数，`UiWorkspace` 接口上没有它的座位，而唯一用到它的公开动词 `startSession` 是发射后不管、不回传会话 id 的。`session-resolution.ts` 重述了它，而这处重述是一条既没有编译器、也没有克隆检测在守的维护耦合：抄岔了只会静默改变点击落到哪个工作区。它的单测逐分支钉住了每一条。

连接那个工作区则是委派而不是重述。`UiWorkspaceService.connectWorkspace` 持有一张按工作区索引的在途 Promise 表；重述它的空白会话复用逻辑就会丢掉这张表，而丢掉它不是外观问题——挂载期的自动落位与一次工作台点击会相隔数毫秒各造一个会话，因为第二个调用方重读到的工作区快照里还没有第一个调用方刚建的那个会话。本线遵循的规则是：可以重述一个上游没有暴露的决策，绝不重述一个协调机制。

## 本次迁移发现的上游缺口

三处，除门禁逼出来的那一处外本线都不修。`packages/attachment/attachment-spill` 的版本是 `0.1.2-alpha.2`、根版本是 `0.1.2-alpha.4`（`pnpm run constraints`），并且带着一个仓库自己的规则明令拒绝的空 invariant 伴生（`pnpm run verify-package-invariants`）；两条在干净的上游树上都能复现。`packages/experimental/client-ui-agent-team/src/css-modules.d.ts` 没有写进 `tsconfig.client.json` 的 include，因此 Client 聚合从不加载它；上游自己的 `scripts/client-tsconfig.spec.ts` 只检查两个包组、看不到它，把该 spec 扩到 experimental 组正是照出它的原因。第三条在这里修掉了，因为那个扩宽的门禁是本线自己的，留红就意味着要把上游那个包从检查里豁免出去。

## Alternatives considered

- **继续禁用 `ui-workspace`、给 `uiWorkspace` 打桩** —— 桩必须跟住上游一个七方法接口，而对话列依赖它的语义；上游每往接口上加一个方法，就变成一处静默缺口而不是一个编译错误。
- **用去术语样式表把输入框的权限 chip 藏掉** —— 那个 chip 是权限控件，藏掉它等于拿走一个选择（agent 可以写哪些文件）而不是改一个称呼。重述预设表换掉的是词，控件还在。
- **用 locale 语言包覆盖厂商标签** —— 注册表确实接受给已有命名空间注册一个新的语言 id，因此一个带 fallback 的派生 locale 可以遮蔽个别键。但它同时会往语言设置行里加进第二个「中文」条目，并且需要覆盖用户自己的语言偏好才会生效。
- **给 Vue 探针包一个自己的编译面**，让 Vue 2.7 的全局 `JSX` 增强永远进不了 Client 聚合 —— 这是本线唯一不得不改的那个上游测试的根治办法，但 `docs/development.md` 规定每个包只登记在两个聚合中的一个，因此第三个编译面是一个架构决定而不是一次迁移修复。
- **给双面包做逐包的 Host/Client 配置拆分** —— `docs/development.md` 把那种形状只留给 `api/remotes`；本次迁移真正需要的是重新推导每个包的 `references`。

## Consequences

这条线在新基座上编译得过、起得来、八个浏览器场景全过，九个包逐文件 100% 覆盖率，全仓零覆盖率违规。两个上游文件带着已登记的改动；Vue 那条在探针包拿到自己的编译面时退役，聚合那条在上游写进自己的声明文件时退役。`terminology-guard.ts` 现在带着一条承重规则而不是一条冗余规则，这正是它的场景要钉元素存在而不只是钉不可见的原因。重述的 `recentWorkspace` 在上游导出它、或把它放上 `UiWorkspace` 接口时退役。本线的两个会话事件（`content/shown`、`content-surface/dismissed`）仍是 required-on-read，因此一个由本组合写出的 `DSH_HOME` 被出厂 profile 重新打开时会拒读它的日志——这是本线既有的性质、本次未改变，值得在部署迁移前实测一次。
