# Agent Note: 只描述自己的描述，只说理由的拒绝

Status: implemented

[English](2026-09-04-self-contained-tool-copy.md) | 中文

## Problem

内容通道提供五件工具，而在这次改动之前，它的文案把它们互相摆位。`content_read` 的描述说自己是起手要用的那一读，并点名 `content_read_dom` 与 `content_read_attrs` 是「class 词不够用时去哪里」；`content_read_dom` 的描述直说不要拿它当默认读法，并点名 `content_read` 才是；两件单元素读取都说自己的 ref 来自「先前的 content_read 或 content_read_dom」；`content_act` 的描述说每个目标都是来自 `content_read` 的 ref。拒绝文案在下一步做了同样的事：空栏叫人去调 `content_show`，失效的 ref 叫人去调 `content_read` 取新的 ref，栏里已经有页面时的认领超时则写着 `content_show cannot help here`。

在真机上，这些互相点名把模型引向了它们本想防止的方向。被问到某张表 操作 列里两个没有标签的图标是什么时，模型朝原文迈的第一步是给 `content_read` 传 `mode: "dom"`——一个被这件工具自己的 enum 拒掉的取值——之后才用 `content_read_dom`。它读到了「`content_read` 是要用的那一读」和「存在一种 DOM 读取」，然后把两者拼在了一起。

拒绝文案直接毁掉了另一次运行。屏幕锁定时，控制台的标签页是开着的，但 `document.visibilityState` 是 `hidden`，于是没有席位认领任何调用。连续四次读取回的都是 `No open console is showing this session's content column … Call content_show to put a page there, or ask the user to open the console`——一个错误的归因，因为控制台**确实**开着——而模型仍然为此花掉一次 `content_show`，尽管那句话写着 `content_show cannot help here`。

## Decision

两条规则，覆盖这个包放到模型面前的每一个字符串。

**一段描述只描述它自己那件工具，或者它自己那个参数，不点名任何别的工具。** 没有哪段描述会说该偏好哪个同伴、哪个更便宜、或者 ref 从哪里来。模型是把这些描述当作一整套来挑选的。

**一句失败只说这次调用为何被拒，别的都不说。** 不写 `call X`、不写 `X cannot help here`、不写 `ask the user to …`、不写 `retry once`。当参数本身就是理由时，拒绝可以点名这件工具自己的参数——比如 `scope must be a ref like "e12" printed by an earlier read of this page`——因为那是理由，不是补救。下一步做什么，从描述里读。

`SCOPE_DESCRIPTION` 在第一条规则之下反而多了一个事实：不传 `scope` 即读整页。A/B 的两条臂都在首调时替它编了一个值，而这是关于这个参数自身的事实。

### 两条规则拆掉了什么

旧文案里有一套机制，唯一的用处就是让每件工具在句子里点自己的名。`ToolVoice`、`readVoice` 以及 `ACT_VOICE`/`READ_VOICE` 两个常量的存在，是为了让共用的「在前面那一项不是页面」和「栏是空的」两种结局按调用方分别措辞；补救去掉之后，这两种结局各只剩一句话，那个类型也随之消失。`noAgentRefusal(tool)` 与 `cancelledRefusal(tool)` 变成了常量 `NO_AGENT_REFUSAL` 与 `CANCELLED_REFUSAL`，`awaitRead` 不再收调用方的 wire 名，`act-text.ts` 也不再保留那两句共用拒绝的副本。`moreTextMarker(ref)` 变成了 `MORE_TEXT_MARKER`，因为它结尾的那一行开头已经写着那个 ref。

<a id="where-the-rules-do-not-reach"></a>
### 两条规则够不到的地方

`perception/text.ts` 里的请求上下文仍然点名 `content_read` 与 `content_show`（`content_read reads the entry in front; content_show puts a page in front.`）。它们是模型对这条通道的地图，而地图正是描述做的事；它们既不是某件工具自己的描述，也不是拒绝，归 [感知那篇 Agent Note](2026-09-02-content-column-perception.zh.md) 所有。

`content_read` 对非法 `mode` 的拒绝来自内核 schema 校验器的 enum 消息，其中点名了这件工具。那不是这个包的字符串，保持原样。

### fork 规则

`.claude/CLAUDE.md` 的工具参数那一条原本要求「点名补救办法的失败文案」。现在它要求：一段只描述自己那件工具与自己参数、不点名任何别的工具的描述，以及一段只说这次调用为何被拒、不点名任何补救工具的失败文案。

## Evidence

真机（ini-web2，空间图层）上的一次 A/B：同模型同 effort、同页面、每格一个全新会话、两条提示、只查不点。每格 n = 1；温度未控。

| 臂 | 提示 | 调用总数 | `content_read` | `_dom` | `_attrs` | 错误 | 首个误用 | 答案 |
|---|---|---|---|---|---|---|---|---|
| 互相点名 | A（DOM） | 13 | 7 | 3 | 3 | 1（`content_read mode:"dom"`，被 enum 拒） | 到 DOM 读取之前先猜 `mode: dom` | 正确 |
| 互相点名 | B（属性） | 11 | 5 | 2 | 4 | 1（`content_read scope:""`） | 首调传空 `scope` | 正确 |
| 只写自身 | A（DOM） | 11 | 5 | 1 | 4（另有 1 次 `_dom_content`） | 2（`content_read mode:"find"`，被 enum 拒） | 直接用了 `content_read_dom`；把 `find` 当成了 `mode` 取值 | 正确 |
| 只写自身 | B（属性） | 9 | 6 | 1 | 2 | 1（`content_read scope:"__page__"`） | 首调猜了一个 `scope` 值 | 正确 |

这次改动针对的那个误路由——伸手去要 `content_read mode:"dom"`——在只写自身那条臂没有复现。两条提示的调用总数都下降了（13→11、11→9），整树 DOM 读取从 3→1、2→1；但每格只有一个会话，这些是观察，不是测量。两条臂都在首调时替 `scope` 编了一个值，也都把一个词当成了 `mode` 取值，这两者都不是互相点名造成的。

拒绝文案那一半依据的是另一次记录下来的运行，而不是这次 A/B：屏幕锁定期间四次 `content_read` 都回了认领超时那句话，一次 `content_show` 花在了一句写着「它帮不上忙」的文案上，模型最后才转去问用户浏览器连接的事。

## Alternatives considered

**保留互相点名，但把它们前置。** 把 `content_read_dom` 的「这不是默认读法」挪到第一句，把 `content_read` 指向原文读取的那句挪到表格那一段之前。按你的裁定否决：这样每段描述仍是同伴的函数，通道里再加一件工具就要改四段描述；而且 A/B 里的误路由来自模型把两条**都为真**的互相点名拼在一起，而不是来自漏读了哪一条。

**只在拒绝里点名补救工具，描述保持只写自身。** 这正是 A/B 记录本身给出的建议：失败当下的定向指引，与选择当下的摆位，是两回事。按你的裁定否决；而锁屏那次运行说明它并不显然安全：点名补救的拒绝是一次归因，而一次错误的归因会把模型送去任何描述都不会送它去的地方。

**有两个事实是被删掉而不是改写的**，因为它们没法不点名同伴地表达。`content_read` 不再说自己只花页面原文的一小部分，`content_read_dom` 也不再说自己比清单贵一个数量级。两者都是相对代价，而相对代价按定义里面就有第二件工具。挡住模型把一页预算花在原文上的，仍然是 `content_read_dom` 必填的 `scope`。

## Consequences

**工具的选择现在完全落在描述上。** 结果和拒绝里没有任何东西引导下一次调用。只读一段描述就动手的模型比以前掌握得少；把五段都读完的模型信息量与以前相同，只少了那两条相对代价。

**拒绝不再做归因。** 它只报告一个状况——栏是空的、等待窗口内没有可见的控制台标签页认领、答案比预算多出 N 个字符——然后停住。认领超时那句话现在还写明了**可见**，那正是席位真正要求的东西，也正是锁屏那次运行证明旧文案说错了的地方。

**骨架清单保住了参数，丢掉了调用写法。** `Read a part with scope, e.g. content_read({ scope: "e1" }).` 现在是 `Read a part with scope "e1".`。

**一道机械可查的门禁。** [`tests/self-contained-copy.client.spec.ts`](../../../../packages/experimental/content-frame/tests/self-contained-copy.client.spec.ts) 走遍 `text.ts` 与 `act-text.ts` 的整个导出面——每个字符串，以及每个用记录参数调用过的函数——并驱动一次真实读取直到骨架清单，从而覆盖 `render.ts` 里那句私有的收尾行。它还会装配六件工具的定义，读出每件定义里的每一段 `description`——工具自己的、参数 schema 里任意深度的、以及输出 schema 里的——由此覆盖 `tool.ts`、`read-tool.ts`、`markup-tool.ts`、`act-tool.ts` 与 `read-value.ts` 里那些装配时才拼出、并未作为句子导出的说明。没有在这里登记参数的导出函数会让这次遍历失败，因此后来添加的句子在写下来的当天就被覆盖。工具名取自 `wire.ts` 与 `tool.ts` 而不是字面量，这也是 `content_show` 的 wire 名现在成为导出常量 `CONTENT_SHOW_TOOL_NAME` 的原因。

**四个 Web fixture 承载着工具 schema 与拒绝文案**，因此这次文案改动在装配后的完整对话里可见，而不只是在单测的逐字断言里。

## Testing

`pnpm exec vitest run packages/experimental/content-frame`——700 条测试，包含新增的门禁 spec，以及 `content-read-tool`、`content-markup-tool`、`content-act-tool`、`content-act-text`、`content-act-executor`、`content-read-executor`、`content-read-routes`、`markup`、`snapshot` 里更新过的逐字断言。

这个包 `src` 的逐文件覆盖率，仍是 100%：

```sh
pnpm exec vitest run --coverage --coverage.include='packages/experimental/content-frame/src/**/*.{ts,tsx}' \
  packages/experimental/content-frame
```

四个 Web fixture 无密钥刷新并回放：

```sh
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
```

门禁 spec 自身会拒绝非法情形，这一点是这样验的：在 `EMPTY_COLUMN_REFUSAL` 里重新塞回 `Call content_show to put a page there.`，并把 `render.ts` 的收尾行改回旧的调用写法——遍历把两处都报了出来，清单那一项报出了 `content_read`。
