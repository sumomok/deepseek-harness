# Agent Note: A direct request can require its answer to call an offered tool

Status: implemented

English | [中文](2026-09-26-llm-tool-choice.zh.md)

## Problem

An auxiliary direct call, such as a plugin judge that parses the answer, needs a machine-readable answer that stays on the question. A JSON response mode on the request covered this while the official DeepSeek adapter spoke chat completions. Upstream #4629 moved that adapter to Messages only and removed the chat-completions protocol, and the harness Messages request type has no JSON-mode field; whether the DeepSeek endpoint accepts an equivalent field has not been probed. Relying on the prompt alone fails in measured runs: one judge answer was 52 tokens of prose with no JSON, and 1 of 80 reviews returned invalid JSON.

## Decision

[`GenerateOptions`](../../../../packages/llm/llm/src/types.ts) gains `toolChoice?: { type: 'any' }`, placed after `toolHistory`. It is the only member. The field states four facts:

- The answer calls one of the offered tools; with one offered tool, it calls that tool. Text may appear before or after the call, and the answer may hold more than one call.
- The arguments remain model-generated JSON that the caller validates.
- An adapter that maps the field fails with `INVALID_REQUEST` when `tools` is empty or absent.
- An adapter whose provider cannot honor the field fails with `UNSUPPORTED_OPTION`, and the message names `GenerateOptions.toolChoice`.

The field is not part of `LlmCallConfig`. The session header has no member for it, so a loop request that carried it could not be reconstructed from the log. The agent-loop request invariant in [`invariant.ts`](../../../../packages/core/agent-loop/src/invariant.ts) therefore requires loop requests to leave it undefined. Only one-shot callers of `ctx.llm.stream()` set it.

Each in-tree adapter handles the field in a fixed way:

- `llm-deepseek` checks it in [`serialize.ts`](../../../../packages/llm/llm-deepseek/src/serialize.ts) and sends `tool_choice: { type: 'any' }` in the base request body.
- `llm-pi-ai` refuses it before any provider I/O. pi-ai owns the provider request body, and its common stream options choose only `auto` or `none`.
- The replay adapter ignores it, because replay reads recorded responses and sends no request.

The DeepSeek mapping applies at every reasoning effort, including the `off` effort a `session-title` request forces. It adds no thinking-mode check and never turns thinking off. On 2026-09-24, one offered tool with `tool_choice: {type: "any"}` returned `stop_reason: tool_use` with an object `input` in all six probe cases on `api.deepseek.com/anthropic`: thinking on and off, streaming and non-streaming, on `deepseek-flash` and `deepseek-v4-pro`. With thinking off, `deepseek-flash` answered with a text block before the `tool_use` block. A request without the field sends a byte-identical body.

## Alternatives considered

**Keep `responseFormat` on Messages.** The harness Messages request type has no such field, and no equivalent endpoint field has been probed.

**Register `tool_choice` through `ctx.deepseekLlmApiExtensions`.** That registry is for fields outside the model's messages, system prompt, and tool schemas, with no KV-cache effect, and `tool_choice` decides how the model answers. A provider's `prepare()` sees the body, purpose, and session id, so it could return the field for one request only; applicability is not the objection. Request extensions report `REQUEST_EXTENSION` only when the base body already carries `tool_choice`, so a request without `toolChoice` still accepts an extension's `tool_choice`. Since upstream #5168, a merged body that fails to serialize drops every extension field and sends the base body, so an extension field is not guaranteed to arrive. A first-class field is part of the base body and is never dropped.

**`{ type: 'tool', name }`.** With thinking on, the endpoint answers 400 "Thinking mode does not support this tool_choice".

**All four Anthropic members at once.** Only `any` has a producer, and the `GenerateOptions` vocabulary grows only when a producer lands.

**A member of `LlmCallConfig`.** Loop requests have no producer for it, and a config member would put it in every session header.

**Per-API request bodies in pi-ai.** `onPayload`, `samplingParams`, and runtime pass-through could inject `tool_choice`, but each API spells it differently, and writing each spelling would take request-body ownership away from pi-ai.

**Prompt instructions and text parsing only.** The in-tree auto-review parses text this way. The measured judge produced prose and invalid JSON under the same approach. The [dynamic-workflows note](2026-07-05-dynamic-workflows.md) rejected provider JSON mode for its capture tool on the same ground: valid JSON is not schema conformance.

**Turn thinking off while a tool is forced.** It would be a hidden default that callers cannot see in the request they built.

## Consequences

`toolChoice` applies to the tool list the route receives after runtime projection. A direct call carries no `toolHistory`, so on a route that declares a tool-update mode (`addition-only` or `in-history`) projection leaves its list unchanged, and a deferred tool counts as callable only once a `tool_addition` activates it. On a route without a tool-update mode, projection drops `deferLoading`, so every offered tool is callable. The `INVALID_REQUEST` check still looks only at an empty or absent `tools`, so a request offering only deferred tools reaches the endpoint.

A producer reads its result from the tool-call blocks and ignores text blocks. It accepts `finish.kind === 'tool-calls'`. When it receives an `UNSUPPORTED_OPTION` failure naming `toolChoice`, it resends once without the field and remembers the outcome per route and reasoning effort.

No shipped profile sets the field, so snapshots, recorded fixtures, and session logs do not change. The field is a core patch: each rolling sync ports it again until upstream `GenerateOptions` gains `toolChoice` or an equivalent tool-choice field.
