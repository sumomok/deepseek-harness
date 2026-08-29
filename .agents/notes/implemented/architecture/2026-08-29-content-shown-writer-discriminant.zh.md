# Agent Note: `content/shown` gets a `by` writer discriminant instead of a second event or kind

Status: implemented

[English](2026-08-29-content-shown-writer-discriminant.md) | 中文

## Problem

在此之前，`content/shown` 只有唯一一个写入者：`content_show` 工具，代表 agent 写入。`@deepseek-ai/dsh-experimental-server-sidebar` 的页面路由菜单需要第二条同样合规、可重放的通路，让*用户*把同一类页面放上台面——点一下菜单项，不涉及任何模型轮次——而结果必须落到每一个既有读取方已经在看的那个地方：[`content-surface`](../../../../packages/experimental/content-surface/README.zh.md) 的 `page` extractor（在其 `page` kind 内按页面 id 去重）与 content-frame 的 `content` projection（那个单一的「当前展示什么」值）。两个写入者落到两个不同的地方，会把这一栏的历史一分为二：用户打开的页面与 agent 选定的页面，对每一个消费者而言明明是同一件事，却会各占一行、各给出一个「当前页面」的答案。

## Decision

**一个事件，一个字段。** `content/shown` 新增 `by: 'agent' | 'user'`，由两个调用 `session.append('content/shown', ...)` 的地方各自写入——`content_show` 工具（写 `'agent'`）与 server-sidebar 的 node 半边针对 content-frame 自己的 `PageIndex` 注册的新命令 `show-content-page`（写 `'user'`；这个事件所喂给的 extractor 机制见 [content-surface router 那篇 Agent Note](../feature/2026-08-24-content-surface-router.zh.md)）。这个字段出现之前写下的日志两者都没有，任何读取方都把这种情况默认成 `'agent'`——那时候工具确实是唯一的写入者，这不是一个猜测出来的默认值，而是日志当时确实想表达的意思。

**这个字段的作用范围止步于 extractor，不进入 projection。** `content-surface/src/surface.ts` 的 `page` extractor 在其存储的 `data` 与解析后的 `payload` 里都保留了 `by`，这正是它的 `dataVersion` 从 1 升到 2 的原因——存储形状变了，按 [session-log-version-mechanism 那篇 Agent Note](2026-08-10-session-log-version-mechanism.zh.md) 的规则，这会使按旧形状构建的任何持久检查点失效，逼出一次重新折叠。`content-frame/src/projection.ts` 的 `content` projection 刻意**不**携带 `by`：它回答的是一个问题——「这一栏当前展示什么」——这个问题没有区分写入者的答案，今天也没有任何消费者需要在那里区分写入者。`resolveShownPage()` 这个被 extractor 与 projection 共用的辅助函数，其签名保持完全不变——extractor 在这个共用调用之外自行把结果包上 `by`，而不是扩大每一个调用该共用辅助函数的调用方所收到的东西。

**不新建事件，也不新建 kind。** 一个新的事件类型需要它自己的 `content-surface` extractor 注册，并且会悄悄地不再与 `content_show` 自己写下的记录去重——agent 展示过一次、用户又点开一次的同一个页面，会在切换器里变成两行而不是一行，这恰恰违背了 content-surface 的设计笔记里点出的「一个概念一个 kind」式去重的本意。`SESSION_FORMAT_VERSION` 不会移动：这是对既有事件的词汇扩展（一个带有明确缺省默认值的可选字段），不是对会话日志读取方必须已知的结构做改动。

## Alternatives considered

**新增一个事件类型 `content/shown-by-user`。** 拒绝：这会为一个判别位复制整个 `content/shown` 的 schema，逼着每一个既有读取方（invariant、两个 extractor 的 `read()`、projection 的 `apply()`）都要在两个事件类型之间分支而不是判断一个字段——更糟的是，这会创建第二个 `content-surface` kind，它不会与 agent 自己对同一页面 id 的写入去重。

**让 `content` projection 解析后的值也携带 `by`。** 拒绝：今天没有任何东西在那里读取它，往这个包里最小、最稳定的 wire 值（`content_show` 自己的测试逐字节钉住的那个东西）上加一个没人用的字段，正是本仓库的约定要求在真正的消费者出现之前避免的那种投机性表面。extractor 才是未来某个渲染器真正会需要它的那条路径。

**从上下文推断写入者，而不是把它记下来**（例如「没有命令执行包着这次追加，那就一定是工具写的」）。拒绝：这会把这个区分变成从证据缺失推断出的猜测，而不是记下来的事实，一旦出现第三个写入者（一次计划任务、一个子代理），这套推断立刻失效，也没有办法在不重新定义「缺失意味着什么」的前提下追溯地加上第三个值。

**提升 `SESSION_FORMAT_VERSION`。** 按 session-log-version-mechanism 笔记自己的规则拒绝：只有结构性的格式改动才提升它，而一个带有文档化、向后兼容默认值的可选字段正是那套机制存在的目的所在——就是不让这种情况非得靠版本提升才能通过。

## Consequences

`content/shown` 的每一个既有读取方，针对一份旧日志都能照常编译、照常运行：`by` 在读取时是可选的，extractor 的 `read()` 与工具自己的写入都把缺失值默认成 `'agent'`。`content_show` 工具自己的测试与模型可见文本未受触碰——它始终写 `by: 'agent'`，其结果文本也不提这个字段。

这个决定唯一留下的可见缺口在呈现层面：`page` extractor 把 `by`一路带到了它解析后的 payload 里，但目前没有任何东西渲染它——content-frame 的 frame 视图不论谁展示的都画同一个 iframe。这个缺口是刻意留下的，记录在两个包各自的 README 里，而不是在这里补上；与之并列记录的还有另一重张力：[`content-surface`](../../../../packages/experimental/content-surface/README.zh.md) 那条与 kind 无关的 `ON_DISPLAY_RULE` prompt 文本——它是钉死、经过测量的文本，不因这次改动而改一个字——仍然告诉模型要更新「你已经产出的东西」，这对一个用户手动打开的页面读起来有些别扭。补上这两个缺口中的任何一个，都是以后一次独立的改动；这篇笔记的决定，只需要让补上它们所需的事实变得可用。
