# Agent Note：直接请求可以要求回答调用某个已提供的工具

Status: implemented

[English](2026-09-26-llm-tool-choice.md) | 中文

## Problem

一次辅助性的直接调用——例如一个解析回答的插件判官——需要一个机器可读、不偏离问题的回答。官方 DeepSeek 适配器走 chat completions 时，请求上的 JSON 应答模式能满足这一点。上游 #4629 把该适配器改为只走 Messages，并删除了 chat-completions 协议；harness 的 Messages 请求类型里没有 JSON 模式字段，DeepSeek 端点是否接受等价字段没有探测过。只靠提示词在实测中会失败：判官的一次回答是 52 个 token 的散文、没有 JSON，80 次审查里有 1 次返回非法 JSON。

## Decision

[`GenerateOptions`](../../../../packages/llm/llm/src/types.ts) 新增 `toolChoice?: { type: 'any' }`，放在 `toolHistory` 之后。它是唯一的成员。该字段声明四条事实：

- 回答会调用某个已提供的工具；只提供一个工具时，调用的就是它。调用前后可能有文字，回答里也可能不止一个调用。
- arguments 仍是模型生成的 JSON，由调用方校验。
- 映射该字段的适配器在 `tools` 为空或缺省时以 `INVALID_REQUEST` 失败。
- 提供方无法支持该字段的适配器以 `UNSUPPORTED_OPTION` 失败，消息点名 `GenerateOptions.toolChoice`。

该字段不属于 `LlmCallConfig`。会话请求头没有对应成员，所以一次带着它的 loop 请求无法从日志重建。因此 agent loop 构造请求时不设置它。只有 `ctx.llm.stream()` 的一次性调用方会设置它。

树内每个适配器对该字段的处理是确定的：

- `llm-deepseek` 在 [`serialize.ts`](../../../../packages/llm/llm-deepseek/src/serialize.ts) 中检查它，并在基础请求体里发送 `tool_choice: { type: 'any' }`。
- `llm-pi-ai` 在任何提供方 I/O 之前拒收它。提供方请求体归 pi-ai 所有，其通用流式选项只能选 `auto` 或 `none`。
- 回放适配器忽略它，因为回放读取录制的响应，不发送请求。

DeepSeek 映射在每个推理档位都生效，包括 `session-title` 请求强制的 `off` 档位。它不加思考模式检查，也从不关闭 thinking。2026-09-24 在 `api.deepseek.com/anthropic` 上，只提供一个工具并带 `tool_choice: {type: "any"}` 的全部六个探测用例都返回了 `stop_reason: tool_use` 且 `input` 是对象：覆盖 thinking 开与关、流式与非流式、`deepseek-flash` 与 `deepseek-v4-pro`。thinking 关闭时，`deepseek-flash` 在 `tool_use` 块之前先回答了一个 text 块。不带该字段的请求发送逐字节相同的请求体。

## Alternatives considered

**在 Messages 上保留 `responseFormat`。** harness 的 Messages 请求类型没有这个字段，也没有探测过端点的等价字段。

**经 `ctx.deepseekLlmApiExtensions` 注册 `tool_choice`。** 该注册表用于模型消息、系统提示词和工具 schema 之外的字段，且对 KV 缓存无影响，而 `tool_choice` 决定模型如何作答。提供方的 `prepare()` 能看到请求体、purpose 和会话 id，因此可以只对某一次请求返回该字段；适用范围不是否决理由。请求扩展只在基础请求体已带 `tool_choice` 时报 `REQUEST_EXTENSION`，所以不带 `toolChoice` 的请求仍会接受扩展注入的 `tool_choice`。自上游 #5168 起，合并后的请求体序列化失败时会丢掉全部扩展字段、只发送基础请求体，因此扩展字段不保证送达。一等字段属于基础请求体，永远不会被丢掉。

**`{ type: 'tool', name }`。** thinking 开启时，端点返回 400 "Thinking mode does not support this tool_choice"。

**一次加齐 Anthropic 的四个成员。** 只有 `any` 有产生方，而 `GenerateOptions` 的词汇只在产生方落地时增长。

**作为 `LlmCallConfig` 的成员。** loop 请求没有它的产生方，而放进调用配置会让它进入每个会话请求头。

**在 pi-ai 里按 API 分别构造请求体。** `onPayload`、`samplingParams` 和运行时透传都能注入 `tool_choice`，但每个 API 的写法不同，逐个书写会拿走 pi-ai 对请求体的所有权。

**只靠提示词加文本解析。** 树内的 auto-review 就是这样解析文本的。实测的判官在同样做法下产出过散文和非法 JSON。[dynamic-workflows note](../../archived/feature/2026-07-05-dynamic-workflows.md) 以同样的理由为其捕获工具否决了提供方 JSON 模式：合法 JSON 不等于符合 schema。

**强制工具时关闭 thinking。** 那是一个隐藏的默认值，调用方在自己构造的请求里看不到。

## Consequences

`toolChoice` 作用于运行时投影之后路由收到的工具表。直接调用不带 `toolHistory`，因此在声明了工具更新模式（`addition-only` 或 `in-history`）的路由上，投影不改变它的工具表，延迟加载的工具只有在 `tool_addition` 激活之后才算可调用。在没有工具更新模式的路由上，投影会去掉 `deferLoading`，每个已提供的工具都可调用。`INVALID_REQUEST` 检查仍只看 `tools` 是否为空或缺省，所以只提供延迟加载工具的请求会到达端点。

产生方从 tool-call 块读取结果，忽略 text 块，并接受 `finish.kind === 'tool-calls'`。收到点名 `toolChoice` 的 `UNSUPPORTED_OPTION` 失败时，它去掉该字段重发一次，并按路由与推理档位记住这个结果。

没有任何随包 profile 设置该字段，因此快照、录制夹具和会话日志都不变。该字段是一个核心补丁：每一轮滚动同步都要重新移植它，直到上游 `GenerateOptions` 出现 `toolChoice` 或等价的工具选择字段。
