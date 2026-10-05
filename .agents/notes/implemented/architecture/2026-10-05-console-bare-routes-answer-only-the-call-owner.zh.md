# Agent Note: 控制台的页面读取与图表汇报路由只为所点名调用的归属成员作答

Status: implemented

[English](2026-10-05-console-bare-routes-answer-only-the-call-owner.md) | 中文

## Problem

`@deepseek-ai/dsh-experimental-content-frame` 的页面通道走三条裸 webserver 路由——`/content-frame/claim`、`/content-frame/report` 和 `/content-frame/image`——`@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc` 在 `/show-chart/report` 上收渲染判定。它们经 `webServer.register` 注册，任何 `connection` 钩子都看不到；每条路由只检查同站与 JSON 内容类型，然后凭工具执行的 `callId`（页面通道还带 `tabId`）认出要处理的调用。在一个服务多位成员的控制台进程里，知道别的成员调用 id 的控制台能认领那位成员的 `content_read` 或 `content_act`、用自己的列表应答它、往里面存图片，或用伪造的判定结算那位成员的 `show_chart`。调用 id 只进入它所属会话的投影流，但按成员核对会话访问是另一道检查；一个离开了那条流的调用 id——导出的日志、共享的屏幕、按序号给调用编号的供应商——不应足以操作别的成员的回合。

## Decision

**每一行都多一个 Config 字段 `perMember`，默认 false，不是 volatile。** 为 false 时每条路由保持原样：每次投递都可作答每个调用，对应只服务一个人的进程。content-frame 在加载时拒绝设了它却没有 `pageAccess` 的行，因为只有页面读取路由读它，而那样的行一条都不注册。

**设了 `perMember`，路由在读正文之前先认出发送者。** 它在请求到达时读 `ctx.get('consoleMembers')`，没有成员目录在运行时答 503，`principalOfRequest` 认不出任何成员时答 401。拒绝文案写明包名、路由和缺的那一样——`<包名>: the <路由> needs the consoleMembers service, which is not running` 与 `<包名>: the <路由> could not tell which member sent this request`——不带请求里的任何值。这两道检查排在方法、同站与 JSON 三道检查之后，与 auth-gate 的 token 路由一样。页面座位对这两个状态码的处理与对路由前面代理的答复一样——再出价、汇报再发一次——因为它们针对的是发送者而不是文档，所以不进 `ROUTE_REFUSAL_STATUSES`。

**读完正文之后，路由拿发送者自己的会话核对这个调用。** `PendingCalls.sessionOf(callId)` 与 `PendingCharts.sessionOf(callId)` 答出调用是对着哪个会话开的，这个会话从 `exec.agent.session.header.id` 以 `SessionId` 带下来；content-frame 记着的最近已结算调用 id 也各自记下所属会话。路由再比较 `principalOfSession(那个会话)` 与发送者的成员；子会话归它的父会话所归的那位成员，这是成员目录的规则。

**点名别的成员的调用的投递，按点名未知调用作答。** 会话归别的成员、不归任何人，或者——对 `show_chart`——在任何 agent 之外发起的调用，得到的答复与未知调用 id 得到的一样，状态码相同、字节相同：认领路由答 `{"claimed":false,"reason":"unknown"}`，汇报路由答 `{"accepted":false}`。content-frame 让两种情形取同一个共享值作答，show-chart 让两种情形走同一个表达式，所以两者不会各自走样。图片路由在拿走调用的结算之前就核对，所以针对别的成员调用的投递什么都不存。发送者自己已结算的调用仍读作 `settled`，别的成员的读作 `unknown`。

**Loader 树稳定之后，配置不匹配会记日志。** 设了 `perMember` 却没有成员目录在运行的行，和没设 `perMember` 却身边有成员目录在运行的行，各记一行 error 日志，因为后者会悄悄为每个会话作答每位成员的投递。

503 与 401 的判断在两个包里各自写。`pnpm run duplication` 没有为它们报克隆，所以没有提取到共用的包里。

这扩展了[成员目录 Note](2026-10-05-console-members-hold-customer-tokens.zh.md)的规则——fork 的路由取请求的成员只经 `principalOfRequest`，别无他途：这几条路由还拿 `principalOfSession` 核对它们所点名的调用。

## Alternatives considered

**对别的成员的调用答 403。** 一个单独的状态码或文案会告诉试探的控制台，这个调用 id 是活的、属于别人，路由就成了探测别的成员回合的预言机。按未知调用作答不新增状态码、不新增文案，座位本来就处理 `unknown`。

**把路由挪到 `connection.fetch.register` 下面。** fetch 路由挂在 `/api` 之下，P2 的路由表按路径判定它们，所以按调用核对归属仍然少不了：路由表认得路由，不认得一个调用 id 指向谁的会话。挪过去还会改动两个浏览器半边投递的路径和部署代理转发的路径。路由留在原处，经 `principalOfRequest` 认出发送者。

**已结算的调用只记 id、不记会话。** 那样一来，表对每个已结算 id 只能给所有发送者同一个答复：都答 `settled` 会告诉别的成员曾有这个调用，都答 `unknown` 会让归属者自己的控制台为一个已经结束的调用再出价。在每个记着的 id 旁边记下会话，归属者得到的答复就保持不变。

**把认出成员的逻辑提取到 `@deepseek-ai/dsh-experimental-content-surface`。** 两个包都已依赖它，但提取会让它为两个重复门禁不报的小函数多一个 `console-members` 依赖。

**成员目录缺失时退回为每次投递作答。** 配置错了的按成员进程就会让任何控制台作答任何会话的调用，这正是这里要堵上的失败；路由改答 503，与 auth-gate 的 token 路由一样。

## Consequences

在两行都设了 `perMember` 的控制台里，别的成员的控制台既不能认领、汇报、往里存图片，也不能结算某位成员的会话或其子会话的图表调用，它就某个调用得到的答复也不会告诉它那个调用是否存在。座位见到 `unknown` 会再出价，但只针对它所展示的会话待办列表上的调用，所以把别的成员的 `settled` 改成 `unknown`，只改变列着这个调用的控制台的出价。

content-frame 有两张表仍是整个进程共用的：最近 64 个已结算的 callId，和最近读过的 64 个会话的首选标签页。一位成员看到自己已结算的调用变成 `unknown`，就能知道此后在所有成员的会话里大约又结算了 64 个调用；一位成员在超过 64 个会话里读取，会挤掉其他成员的标签页记录；两者都不说出任何调用或会话。按序号给调用编号的供应商可能让两位成员同时进行的调用同 id：content-frame 拒绝第二个等待，show-chart 的第二个等待顶掉第一个，第一个调用以未确认作答。两者都不让一位成员结算另一位成员的调用。

不归任何人的调用没有控制台能作答：工作目录不在任何已登记根目录下的会话里的 `content_read` 或 `content_act` 在认领窗口到期时结束，在任何 agent 之外、或在这种会话里发起的 `show_chart` 以未确认作答。

两行都从 `@deepseek-ai/dsh-experimental-console-members` 导入成员目录的类型，`ctx.get('consoleMembers')` 读的正是它的 `Context.consoleMembers` 合并；稳定后组合的检查用到 `@deepseek-ai/cordis-plugin-loader`。没有已发布的 profile 设 `perMember`，所以没有录制会话快照覆盖它。`packages/experimental/content-frame/tests/content-read-members.client.spec.ts` 与 `packages/experimental/vue2-echarts-tool-poc/tests/show-chart-members.client.spec.ts` 各自经 Loader 启动这一行和测试专用的成员目录，覆盖读正文之前的 401 与 503、别的成员的调用按未知调用作答、子会话、不归任何人的会话、两条日志和销毁；`packages/experimental/component-kit/tests/abilities-members.client.spec.ts` 覆盖 auth-gate 按成员解析器下的能力路由。
