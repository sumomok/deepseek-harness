# Agent Note: 控制台快照泳道搬到 snapshots/console，骑在 acp 剖面上

Status: implemented

[English](2026-09-07-console-snapshot-lane.md) | 中文

## Problem

`examples/content-console` 曾是控制台的无密钥快照泳道：一套无头 ACP 组合，加十一个手写场景，钉住 `show_chart` 与 `show_component` 模型可见的全部内容——两把工具的 schema、content-surface 的提示词段落、每一次录下的参数与结果行，以及一份工具会拒绝的配置视图在启动期被挡下这件事。

[并进 0.1.2-rc.1 的那次合并](2026-09-06-console-merge-forward.zh.md)把它留在了原地，并写明了这一点。那个基座没有 `examples/` 这套约定：这棵树不匹配 `pnpm-workspace.yaml` 里的任何 glob，没有任何 vitest 配置点名这个目录，而它的 `cordis.yml` 组合的是 `@deepseek-ai/dsh-acp-demo`——rc.1 基座里没有这个包。这条泳道被提交着、跑不起来、也没有门禁看着：这是最会悄悄腐坏的一种证据，因为它坏掉的时候什么都不会报错。它还扛着这个基座上仅有的两条 `pnpm run lint` 错误，因为它的适配器命中了类型感知的 `examples/**` oxlint 覆盖规则，而它的导入根本解析不出类型。

## Decision

**这条泳道成为 `snapshots/console/`，并按这棵树里其余每条泳道的方式组合：发行的 `dsh` CLI 加 `--profile acp`，再加本泳道自己的补丁。**

`snapshots/` 正是录制会话测试该住的地方，`vitest.snapshot.config.ts` 已经收录了 `snapshots/**/*.snapshot.ts`，而 [snapshots/AGENTS.md](../../../../snapshots/AGENTS.md) 要求的正是这种启动形态。十一个场景目录、两份配置、适配器与双语 README 整体搬过去；`examples/` 被删除，这棵树的 `package.json` 一并消失，因为语料目录不是工作区成员。

### rc.1 组合替换掉了什么

退役的 `dsh-acp-demo` 是一行插件，它自己装配出一套骨干并接收配置开关。发行剖面把每一部分都作为独立的行来组合，所以 [`cordis.yml`](../../../../snapshots/console/cordis.yml) 改为逐项写明：

| 那一行 demo 做的事 | 补丁做的事 |
|---|---|
| 装配智能体骨干、ACP 桥接、JSONL 持久化 | 由 `acp` 剖面提供；补丁只重述持久化根目录与收割所需的 `compression: none` |
| `skills: {enabled: false}`、`goals: false`、`toolJobs: false` | 直接关掉那些工具行——bash、pwsh、fs、fs-search、str-replace-editor、jobs、skill、goal、todo、web、workflow、ralph、四个子智能体行，以及 plan-mode |
| `workspaceContext: false` | 关掉 `agent-instructions` |
| `persona:` | base 里 `system-prompt` 行的 `persona` |
| 点名投影注册表与命令注册表 | base 捆绑包已经把两者都挂上了 |

原封不动留下来的是「提供给模型的是什么」：模型拿到的恰好是 `show_chart` 与 `show_component`，这正是把上游对其他任何工具描述的改动挡在本泳道基线之外的东西。其余各行——DeepSeek 适配器、`content-surface`、监听系统分配端口的 `host-webserver`、认证网关、图表工具那一秒的回执期限，以及带着目录和配置 `views` 条目的组件工具——照旧写明。

补丁点名的四个 experimental 插件成为 `apps/cli` 的 devDependencies，与那里已有的 `dsh-host-webserver` 和 agent-team 各行并列。剖面加载器会把 dsh 安装的依赖闭包镜像进 `$DSH_HOME/profiles/node_modules`，所以那份清单就是补丁够得着「CLI 并不发行的插件」的通路——`snapshots/acp` 的钩子行走的也是同一条。

场景元数据从适配器里搬进每场景一份的 `snapshot.yml`，并像 `snapshots/acp` 读自己那份一样经 `parseSnapshotManifest` 读取。`input.json` 留下：它是 ACP 协议脚本，套件工厂要读它、它的基线守卫要求它存在，而语料门禁恰好对 ACP 驱动的泳道断言它存在。留在适配器里的只有动态值——假后端的基址，以及投递令牌那些场景所绑的两个端口，它们在收集期才选定，写不进文件。

### 基线刷新改了什么

`DSH_SNAPSHOT=refresh` 跑在已提交的模型脚本上，不需要密钥。每一处基线 diff 都落在下面四类之一，没有一处是行为变化：

| 类别 | 动了什么 | 落在哪 |
|---|---|---|
| 纯搬迁 | 什么都没动：每份 `input.json` 逐字节相同，表头基线的 `system-prompt.expected.md` 与 `tool-schemas.expected.json` 也是 | 全部十一个场景 |
| 工具包归一化 | 裸 UUID 变成带类型的 `{{session:N}}` / `{{message:N}}` 记号；`sourceEventSeqs` 收拢成区间 | 每份 `session.jsonl` |
| 发行剖面的组合 | 剖面的沙箱与权限行在会话开头写下的 `permission/preset`、`sandbox/mode`、`approval/policy` 事件，以及随之出现在运行时上下文消息里的文件策略段落 | 每份 `session.jsonl` |
| rc.1 ACP 协议 | `tool_call` 与 `tool_call_update` 帧、`mcpCapabilities`、`sessionCapabilities`、`newSession` 的模型 `configOptions`，以及智能体消息的 `messageId` | 每份 `stdout.expected.jsonl` |

逐字节相同的表头基线是那个承重结论：它证明了「打在发行剖面上的一份补丁」组合出的模型可见内容，与手搓的 demo 骨干组合出来的是同一份。每一次工具调用的参数与每一段工具结果文本也都逐字节存活——`show_component` 描述里那段 `dataSource`（含「`gridItems` 可以不写」那句与 `page.currentPage`）、`show-default-columns-turn` 那张不点名任何列的审批卡、它那句以 `Page 1 of 1.` 收尾的结果行，以及 `empty-datasource-turn` 的零行句子，读起来与从前一模一样。

旧基线并不是语料门禁要求的那种归一化不动点，因为它们早于带类型的记号，也早于区间收拢。这就是这次刷新是必须而非可选的原因。

### 语料门禁现在看着什么

[`scripts/session-snapshot-corpus.corpus.ts`](../../../../scripts/session-snapshot-corpus.corpus.ts) 把 `*.snapshot.ts` 这个后缀保留给一份具名适配器清单，并走遍 `snapshots/` 来落实它，所以这条泳道必须登记进去，否则光是它的适配器就会让门禁失败。

登记之后，门禁现在会读全部十一份 `snapshot.yml`：每份声明自己的场景名、剖面、组合、录制策略与表头类；每个「组合 + 类」恰好有一个场景钉住表头；钉子的两份边车存在；每份 `session.jsonl` 都是带类型身份的不动点，且系统提示词与工具 schema 都已被刷成记号；以及 `input.json` 存在，因为这条泳道由 ACP 驱动。

最后那项检查原本以语料目录名为准，而目录名已经决定不了剖面了。现在有一张 `profileByLane` 表把每个目录映射到它的场景所声明的剖面——`console` 骑在 `acp` 上，正如 `session` 骑在 `headless` 上——输入与转录两项断言改为查这张表，而不是看目录。

## Alternatives considered

**把这棵树留在 `examples/`，再往某个 vitest 配置里加上它。** 否决：`snapshots/AGENTS.md` 持有录制会话测试，而语料门禁只走 `snapshots/`，所以这条泳道会跑起来却没有门禁看着——同一种悄悄腐坏换个形式而已。这个基座上 `examples/` 也没有别的住户；为一棵树保留它，等于保留一套基座已经退役的约定。

**删掉这条泳道。** 否决：它是两把工具的描述、目录、参数与结果文本唯一的装配态转录证据。Playwright 泳道证明浏览器画出什么，包内测试证明每个分支，但两者都不展示模型实际拿到手的是什么。

**把这些场景并进 `snapshots/acp/`。** 否决：它们组合的是另一份补丁，因而是另一个表头类。acp 泳道的基础补丁是发行的写码骨干，带 bash、文件系统与子智能体工具；控制台那份恰好相反，把两者并到一个目录下，会让读者预期一份组合、却看到两份互不相干的。

**复活一个 `acp-demo` 形态的 bin，让适配器保住自己的入口。** 否决：`snapshots/AGENTS.md` 禁止再加一个应用入口、隐藏 CLI 模式或可执行场景驱动器，而那个 demo bin 正是这条规则点名的东西。组合发行剖面，也正是让这条泳道的证据关于发行产品本身的原因。

**把 `snapshots/console/` 做成带自己 `package.json` 的 pnpm 工作区成员，好让补丁里的插件名从本地 `node_modules` 解析。** 否决：剖面加载器本来就从 dsh 安装的闭包解析插件名，这正是今天 `dsh-host-webserver` 与 agent-team 插件挂在 `apps/cli` devDependencies 下的原因。在 `snapshots/` 下加一层清单，等于为一个目录添出第二条解析路径，并把一份包清单放进一棵本来没有清单的语料树。

**关掉剖面的沙箱与权限行，让会话日志与旧的完全一致。** 否决：那是拿被测组合的一项真实性质去换基线的观感。控制台跑在一个带文件沙箱的剖面上，而一条把这件事藏起来的泳道，描述的是没人发行的组合。

**按 `snapshots/AGENTS.md` 的一次性场景规则丢掉 `input.json`。** 否决：那条规则说的是「用户任务与回放脚本可从会话日志推导出来」的一次性场景。ACP 场景的 `input.json` 两者都不是——它是协议脚本，带着 initialize、newSession 各步与审批答复，而语料门禁对 ACP 驱动的泳道断言它存在，正因为它不是副本。

## Consequences

控制台模型可见的内容重新被门禁看着了。对任一把工具的描述、拼进描述的组件目录、某个参数描述，或 `content-surface` 提示词段落的改动，现在都会在必需的快照泳道里落成一处需要过目的基线 diff，而不是无声地抵达模型——这正是这条泳道当初为之而建、后来却不再做的事。

`pnpm run lint` 在这个基座上第一次全绿。那两条常驻错误并不是适配器的缺陷：这个文件命中了类型感知的 `examples/**` oxlint 覆盖规则，同时又落在所有 tsconfig 程序之外，于是 `@deepseek-ai/dsh-session-snapshot` 解析成 `error` 类型，对它的每一次使用都被报成不安全。离开那棵树就是全部的修法：`.oxlintrc.json` 在任何一条覆盖规则里都没有提到 `snapshots`，所以这个适配器落在所有类型感知规则集之外，正是 `snapshots/acp/acp.snapshot.ts`、`snapshots/sdk/sdk.snapshot.ts` 与 `snapshots/session/headless.snapshot.ts` 早就待着的位置。

代价是这条泳道的会话基线现在带上了发行剖面的权限与沙箱事件，以及随之而来的文件策略段落。那是控制台并不关心的三行，而上游一旦改动那段文字，就会冲刷十一份会话日志。表头基线——描述控制台的那部分——与此隔离，因为工具行是逐行关掉的，而不是交给某个骨干开关。

`examples/` 被删除，`docs/AGENTS.md` 也去掉了那条为「这个基座从来没有过的 `examples/AGENTS.md`」写的字数预算。`.gitignore` 与 `.oxlintrc.json` 里的 `examples/` 模式与 glob 原封不动：上游自己也没有 `examples/` 目录，却带着同样这些条目，它们在这里同样什么都匹配不到；而本分叉只在不得已时才改上游拥有的文件——每一处这样的改动，都是下一次同步时的一个冲突块。

## Testing

`pnpm run test:snapshot snapshots/console`：十一个场景加七道基线守卫，全部通过，不需要密钥。这条泳道确实能分辨：把 `packages/experimental/component-surface` 里 `show_component` 描述改掉一个词，十一个场景全部失败——因为每个同类场景装配出的请求头都要与那份钉子比对——而且每一处失败都点名了被改动的那句话。改回来即恢复。

`pnpm vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts`、`pnpm run lint`、`pnpm run verify-cordis-config`、`pnpm run doc-sync`、`pnpm run hygiene` 与 `pnpm run build` 全绿。
