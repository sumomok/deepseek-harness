# Agent Note：控制台在 60% 处自动压缩，自己画压缩行，并遮蔽三个不该给客户用的设置条目

Status: implemented

[English](2026-10-03-console-auto-compact-and-withheld-compaction-rows.md) | 中文

## Problem

控制台对话是一段长的数据会话：页面读取、组件结果与工具输出不断累积，直到某次请求逼近模型上下文窗口的边缘。控制台原先没有组合任何主动压缩，唯一的保护是压缩后端自己的步间压力检查——它会在之后的每一步重试一次失败的摘要——以及它的溢出恢复。桌面线已经随附 `@haoran/dsh-auto-compact`：一个仓外插件，在一次模型请求会超过窗口某个比例时先行压缩，每轮失败一次后就退避；它通过 [`auto-compaction-policy-seat`](2026-09-14-auto-compaction-policy-seat.zh.md) 给 `compaction-basic` 加上的 `compactionPolicy` 席位读取这个比例。

设置 → 通用设置里有两行向客户提供控制台已经定下的选择。`dsh-client-ui-chat` 的「繁忙时的压缩行为」行决定回答进行中输入的 `/compact` 何时执行，用的是写给开发者的词汇。自动压缩插件带来自己的开关加滑块行，内容是上下文窗口的一个百分比。设置页标题栏还有第三个条目，`ui-settings-general` 的**打开配置文件**动作，控制台的 `ownsHost` 让它对登录门放行的每个访客都真实可用；[`console-mcp-default-and-settings-trim`](../architecture/2026-09-20-console-mcp-default-and-settings-trim.zh.md) 用一条 CSS 规则把它藏起来，依据是列表槽位不接受别的插件撤回。`ui-chat` 不能禁用，因为它画出整个 Chat 栏，而这三个条目所属的包都留在组合里。

控制台的 Agent 预设把 `compaction-basic` 挂在一个隔离的 `compaction` 组里，host 平面的行注入不到这个引擎。

## Decision

**控制台 bundle 以 `enabled: true` 与 `thresholdPercent: 60` 组合 `@haoran/dsh-auto-compact` 0.5.1。** 这一行位于 bundle 层 [`cordis.patch.yml`](../../../../packages/experimental/console-profile/cordis.patch.yml)，在 profile 补丁之下：两个字段都是 volatile，所以 60% 是继承值，保存进 profile 补丁的设置写入会覆盖它。插件是 host 平面的行，经 `ctx.agentPresets.serviceFor(agent, 'compaction')` 为每个 agent 找到它的引擎，能够到 `console` 预设及其 `standard` 孪生预设的 `compaction` 组；一旦够到一个引擎，它的 `compactionPolicy` 就回答 `isEnabled(): false`，`compaction-basic` 随之关掉自己的步间检查。插件的检查在一轮里的每一次模型请求之前运行，第一次也不例外。溢出恢复不变。

**插件以 vendored tarball 的形式进来。** `console-profile` 声明 `"@haoran/dsh-auto-compact": "file:./vendor/haoran-dsh-auto-compact-0.5.1.tgz"`，与 `component-kit` 引入它那几个 tarball 的写法相同。tarball 由插件仓库已推送的 `main` 的干净副本构建后打包。该包把它用到的 harness 包声明为可选 peer；`console-profile` 把插件运行时导入的 `@deepseek-ai/schemastery` 列在 `dependencies`，只用于类型的 peer 列在 `devDependencies`，工作区安装因而把每个 peer 都链接到工作区里的那一份。

**三个设置条目都靠遮蔽它们的列表 id 隐去。** `settings.general.item` 与 `settings.action` 都是列表槽位，格子就是条目 id，只有格子里优先级最低的条目才会渲染。`server-sidebar` 的 [`settings-entries.ts`](../../../../packages/experimental/server-sidebar/src/client/settings-entries.ts) 在 `busy-compaction`、`auto-compact` 与 `open-document` 下各以优先级 -1 注册一个什么都不渲染的条目，所属包在默认优先级 0 注册的条目于是永不挂载；打开配置文件动作原先那条 CSS 规则由此取代。各个包都保留各自的 Config：`busyCompaction` 保持默认值 `turn-end`，自动压缩按 60% 运行。压缩在对话里画出的进行中那一行仍属于 `ui-chat`，来自 [`auto-compaction-running-card`](2026-09-18-auto-compaction-running-card.zh.md)。

**压缩落定与压缩失败的行是控制台自己的。** `conversation.chat.node` 是键控槽位，每个键下只有优先级最低的条目才会渲染，所以 `server-sidebar` 的 [`CompactionRows.tsx`](../../../../packages/experimental/server-sidebar/src/client/CompactionRows.tsx) 在 `compaction` 与 `compaction-failure` 两个键下各以优先级 -1 注册一行，用它自己的语言表：「已压缩较早的对话」（Earlier conversation compacted）与「较早的对话压缩失败」（Couldn’t compact the earlier conversation）。两行都不显示计数或 token 数，也都打不开摘要。这一行放在一轮里的哪个位置仍由 `ui-chat` 决定。

## Alternatives considered

**禁用 `ui-chat` 来去掉它的行。** 这个包画出整个 Chat 栏；禁用它就去掉了对话本身。

**用去术语化守卫的 CSS 隐藏这些条目。** CSS 规则耦合在渲染出的类名上，还会把控件留在 DOM 里，键盘仍能聚焦到它。遮蔽条目只耦合在列表 id 上，控件根本不会挂载。

**保留 `ui-chat` 的落定行与失败行。** 那个标记写出被压缩的历史条数与 token 数，点开是英文写的摘要；失败行许诺稍后再试，而插件在同一轮内不会再试：这些数字、这种语言和这个许诺，控制台客户都用不上。

**用核心补丁改 `ui-chat` 的行。** 出厂 Web profile 与桌面线都保留原样的标记，而键控槽位不打补丁就能换上控制台的措辞。

**把 `auto-compact` 行组合进锁 overlay。** 在 profile 补丁之上，config-editor 会拒绝对这两个字段的每一次写入，部署要改比例就只能改锁。放在 bundle 层，60% 是控制台的默认值，而 profile 补丁仍能带上部署自己的比例。

**让插件自己的行留在页面上。** 客户会看到一个上下文窗口百分比——在控制台的词汇里没有意义的数字——而这个值部署已经定好了。

**从工作检出直接打包插件。** `pnpm pack` 按原样打包 `lib/`，而工作检出的 `lib/` 可能比它的源码和 manifest 旧，tarball 就会以较新的版本号带上旧代码。tarball 由一个已推送提交的干净副本构建后打包。

**`link:` 到插件仓库。** 被链接的包会解析出它自己的 `@deepseek-ai/cordis`，第二份 Cordis 会破坏服务身份。

**不声明那些 peer。** pnpm 会从 registry 解析缺少的可选 peer，在工作区那一套旁边再装进一套已发布的 harness 包。

## Consequences

控制台对话会在一次会占用窗口 60% 以上的模型请求之前被压缩，一轮的第一次请求也算；若模型的窗口减去预留输出与后端余量后更小，则更早压缩；一次失败的尝试在同一轮内不再重复。从那次请求起，模型读到的是截成首尾两段的过长工具结果，不够时还有一段更早历史的摘要。

客户看到的压缩：进行中是 `ui-chat` 的「正在压缩…」；落定后，这一轮的过程行里出现「已压缩较早的对话」；摘要失败时则单独一行显示「较早的对话压缩失败」。`compaction-basic` 按其摘要提示词的要求用英文写下的摘要，客户够不到；`ui-chat` 改掉的键不再被遮蔽，那一行会恢复原样。在输入框里手动输入的 `/compact` 仍画出 `ui-chat` 的命令卡片，带着计数和摘要。

页面上没有这三项设置的任何控件。`busyCompaction`、`enabled` 与 `thresholdPercent` 仍是 volatile，所以 `remote.settings` 方法仍接受部署放行的任何浏览器对它们的写入。

tarball 需要手工更新：插件出新版本时，构建一份干净副本、打包、替换文件，再更新 `file:` 说明符、`tests/profile.spec.ts` 与第三方声明所指的归档路径（`scripts/gen-third-party-notices.ts` 的 `OVERRIDES`，登记在 core-patch 记录 `console-vendored-plugin-notice` 下）。Web e2e 脚手架在安装 profile 的 bundle 之前就算好了运行时解析，所以 `apps/web/tests/server-sidebar.e2e.ts` 像链接实验包一样，把解包出来的那一份链接进它的 profile。

Web 快照 `console-auto-compact` 钉住这一行为。一段编写好的对话经由控制台组合、在 200,000 token 的窗口上重放：第二次回复报告占用窗口 62.5% 之后，第三轮的第一次请求之前发生压缩，而后端自己的检查会放过这个占用——它在窗口的 80% 与窗口减去余量两者中较小的那个处触发，这里是 134,464 token；一次 57.5% 的无 key 运行什么都不压缩，`standard` 孪生预设在 62.5% 时同样压缩。同一个快照还钉住控制台组合的系统提示词与工具 schema。

所属包一旦改掉 id，那个 id 就不再被遮蔽，那个条目会重新出现；控制台 e2e 场景检查打开的设置页里没有那两行的文字，并且标题栏的动作行为空。
