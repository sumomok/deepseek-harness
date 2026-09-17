# Agent Note: llm seam 请求上的 JSON 应答格式

Status: implemented

[English](2026-09-17-llm-response-format.md) | 中文

## Problem

`@haoran/dsh-llm-permission-gateway` 让第二个模型（判官）判定一次工具调用，并把那条回答按 JSON 解析。2026-09-17 22:54 的一次判官调用用 52 个 token 的散文作答而不是 JSON，解析失败，这道门走了失败关闭那条路——一次判官从未拒绝过的工具调用被拒，模型收到的说法是用户拒绝了它。

DeepSeek 的 chat-completions 端点用 `response_format: { type: 'json_object' }` 恰好消除这种失败，而 harness 里没有任何东西能把该字段送上线。`GenerateOptions`——每个适配器收到的完整装配后请求——没有应答格式字段，而 `dsh-llm-deepseek` 只从 `GenerateOptions` 的字段装配请求体。插件可以经 `llm/stream` 瀑布替换或改道一次请求，但它交出去的仍是一个 `GenerateOptions`，因此没有字段可设。唯一能添加 DeepSeek 顶层字段的注册表 `ctx.deepseekLlmApiExtensions` 的定义是提供方专用、留在模型输入之外的字段；`response_format` 约束的是模型产出的那条回答，端点从请求体里读它，与其他模型输入一样。[dsh-llm README](../../../../packages/llm/llm/README.zh.md#known-limitations-and-deferred-work) 写明了本次改动满足的条件：有产生方需要时才添加请求字段。

## Decision

`GenerateOptions.responseFormat?: { type: 'json_object' }` 是提供方无关的应答格式约束，声明在 `stop` 旁边，并承载调用方依赖的四条事实：

- 提供方保证 assistant 文本是一个合法 JSON 值。
- 提示词仍然必须要求 JSON。这是端点的要求：不这样做，模型可以一直流出空白字符直到输出上限。
- 空回答与在 `maxTokens` 处被截断的回答都仍然可能。调用方要校验自己解析的内容，而不是只信这条保证。
- 提供方无法支持该格式的适配器以 `LlmError` code `UNSUPPORTED_OPTION` 让请求失败，而不是静默发送纯文本——[adding-an-llm-adapter](../../../../docs/cookbook/adding-an-llm-adapter.zh.md) 对 `stop` 已经写下的规则。

DeepSeek 文档对 JSON 模式的约束正是其中前三条：提示词必须含有 `json` 一词并应给出预期输出的示例，`max_tokens` 必须留出容纳完整值的空间，端点偶尔会返回空内容。它的思考模式文档把 `temperature`、`presence_penalty`、`frequency_penalty` 列为思考模型忽略的参数；`response_format` 不在其中，因此判官可以在保持推理开启的同时拿到 JSON。

`dsh-llm-deepseek` 在 `requestWithMessages` 里把该字段映射为线上的 `response_format`——纯文本与图片两条请求装配路径共用的那一处。缺省时什么都不发，与该请求体里其它每个可选字段一致：请求绝不携带 `response_format: null`。

该字段刻意不进 `LlmCallConfig`。agent loop 把 `header.config` 展开进每一个循环构建的请求，所以会话请求无从获得应答格式，被记录的 request header 也继续能重建模型看到的那一个请求。agent-loop 的请求重建不变式逐字段枚举这条等式，现在要求 `responseFormat === undefined`，于是这份缺席是被检查的、而不只是被安排的：携带应答格式的循环请求以 `diverges from the folded request header` 失败。只有直接调用 `ctx.llm.stream()` 的一方——判官，以及在它之前的标题与压缩提供方——才能设置它，而那些辅助调用本就在循环的记录 header 之外。

### 树内的适配器

有两个适配器发出请求体：`DeepSeekAdapter` 映射该字段，`PiAiAdapter` 拒绝它。pi-ai 的 `SimpleStreamOptions` 没有应答格式成员——它的通用流式选项带的是 `toolChoice`、`reasoning`、`deferred` 与 `thinkingBudgets`——而请求体归 pi-ai 所有，适配器不绕开 `streamSimple` 就加不上该字段。这条拒绝紧挨 `streamWithSnapshot` 中已有的 `GenerateOptions.stop` 拒绝，位于任何提供方 I/O 之前，用的是同一个 `UNSUPPORTED_OPTION` code。

`llm-replay` 的 `ReplayAdapter` 是测试之外第三个 `LlmAdapter` 子类。它从录制好的流作答、不发出任何提供方请求，因此不支持任何请求字段——它同样忽略 `stop`、`temperature` 与 `maxTokens`，而录好的回答本就是原请求所要求的样子。在那里拒绝 `responseFormat` 会让 JSON 模式的流程无法录制，却什么也保护不了。

## Alternatives considered

**解析失败就重试判官，保留失败关闭那条路。**否决：每次失手都要多付一次完整的判官调用，而它重试的失败是模型选择了散文——重试不会让这件事更少发生，JSON 模式则在提供方那一侧消除了它。

**改强判官的提示词而不是请求。**否决的理由是不够，而不是不对：这道门的提示词已经在要求 JSON，而 JSON 模式要求它继续这样要求。提示词已经在要求了，失效的正是「要求」这件事本身。

**经 `ctx.deepseekLlmApiExtensions` 注册 `response_format`。**否决：该注册表的约定是模型输入之外的提供方专用字段，且它按注册作用于每一个 `deepseek-official` 请求，而不是作用于想要 JSON 的那一次调用。它还会把该约束锁死在一个提供方上，而 seam 上的字段能让第二个适配器大声拒绝它。

**把类型放宽到 DeepSeek 的其它格式，或加一个 `json_schema` 变体。**否决：没有产生方。接纳 `responseFormat` 的同一条规则，也让这个联合在有调用方需要之前只保留一个成员。

**把该字段放进 `LlmCallConfig`，让循环也能设置它。**否决：call config 是循环记录并据以重建请求的会话级 header，而应答格式属于一次辅助调用，不属于一个会话纪元。放进去还会往记录 header 里塞进一个没有产生方设置的、影响模型的新字段。

**让 pi-ai 适配器手工装配携带该字段的提供方请求体。**否决：pi-ai 拥有它所服务的每一条路由的请求装配，为一个字段伸手越过 `streamSimple`，会把这份所有权对所有路由一起分叉。

## Consequences

这是对上游核心包的 fork overlay。上游的 `GenerateOptions` 出现 `responseFormat` 或等价的应答格式字段即退役，届时 fork 的这道门改为适配上游形式。判据只读声明点——`git grep -n "responseFormat" upstream/master -- packages/llm/llm/src/types.ts`，今天零命中——因为整个 `packages/llm` 路径已经命中 pi-ai 一份模型清单 fixture 里的三条 `supported_parameters`。非零命中是要人去读的信号，不是结论。在此之前每一轮滚动同步都要重新移植，因为它落在上游每次扩充请求字段集时都会改的那个类型里。

设置该字段的产生方欠它的每条路由一个兜底。`LlmRuntime` 把适配器的抛出变成终止性 `error` finish，所以在 pi-ai 路由上——Models 页可为任何模型选它——设置 `responseFormat` 的判官每一次调用都拿到 `UNSUPPORTED_OPTION`，每一次工具调用都失败关闭，比这个字段要消除的那一次散文回答更糟。这份义务归产生方：识别该 code，同一请求不带该字段重试一次，并按路由缓存结论。网关自 0.4.6 起承担它，桌面载荷随包分发的就是这一版。

`packages/bundle/*` 的任何 profile 都不设置该字段——产生方是桌面载荷挂载的一个随包插件——因此没有会话日志、快照或录制 fixture 发生变化：缺省的 `responseFormat` 序列化结果逐字节不变。证据在读取它的那三个包里——`llm-deepseek` 的 `serialize.spec.ts` 钉住映射后的线上字段以及请求未命名格式时它的缺席，同包的 `adapter.spec.ts` 在一次 `ctx.llm.stream()` 真正送上线的 body 上钉住同一对事实，`llm-pi-ai` 的 `adapter.spec.ts` 钉住发出任何请求之前的 `UNSUPPORTED_OPTION` 失败，`agent-loop` 的 `invariant.spec.ts` 钉住循环请求被拒。
