# Agent Note: A JSON answer format on the llm seam's request

Status: implemented

English | [中文](2026-09-17-llm-response-format.zh.md)

## Problem

`@haoran/dsh-llm-permission-gateway` asks a second model to judge one tool call and parses that answer as JSON. On 2026-09-17 at 22:54 one judge call answered with 52 tokens of prose instead of JSON, the parse failed, and the gateway took its fail-closed path — a tool call the judge never rejected was refused, and the model was told the user rejected it.

DeepSeek's chat-completions endpoint removes exactly this failure with `response_format: { type: 'json_object' }`, and nothing in the harness could put that field on the wire. `GenerateOptions` — the fully assembled request every adapter receives — had no answer-format field, and `dsh-llm-deepseek` builds its request body from `GenerateOptions` fields alone. A plugin can replace or reroute a request through the `llm/stream` waterfall, but the request it hands on is still a `GenerateOptions`, so it has no field to set. The one registry that does add top-level DeepSeek fields, `ctx.deepseekLlmApiExtensions`, is defined for provider-specific fields that stay outside model input; `response_format` governs the answer the model produces, which is model input's other half. The [dsh-llm README](../../../../packages/llm/llm/README.md#known-limitations-and-deferred-work) states the condition this change satisfies: a request field is added once a producer needs it.

## Decision

`GenerateOptions.responseFormat?: { type: 'json_object' }` is the provider-neutral answer-format constraint, declared beside `stop` and carrying four facts callers depend on:

- The provider guarantees the assistant text is one valid JSON value.
- The prompt still has to ask for JSON. This is DeepSeek's own requirement, not adapter politeness: without it the model can stream whitespace until the output cap.
- An empty answer, and one cut short at `maxTokens`, both stay possible. Callers validate what they parse rather than trusting the guarantee alone.
- An adapter whose provider cannot honor the format fails the request with `LlmError` code `UNSUPPORTED_OPTION` instead of silently sending plain text — the rule [adding-an-llm-adapter](../../../../docs/cookbook/adding-an-llm-adapter.md) already states for `stop`.

DeepSeek's documented constraints on JSON mode are the first three of those: the prompt must contain the word `json` and should show the intended output as an example, `max_tokens` must leave room for a complete value, and the endpoint can occasionally return empty content. Its thinking-mode documentation lists `temperature`, `presence_penalty`, and `frequency_penalty` as the parameters a thinking model ignores; `response_format` is not among them, so the judge can keep reasoning enabled and still get JSON.

`dsh-llm-deepseek` maps the field to the wire `response_format` in `requestWithMessages`, the one place both the text-only and image-capable request builders assemble shared fields. Omission sends nothing, matching every other optional field in that body: the request never carries `response_format: null`.

The field is deliberately absent from `LlmCallConfig`. The agent loop spreads `header.config` into every loop-built request, so a conversation request cannot acquire an answer format, and the logged request header keeps reconstructing the exact request the model saw. Only a direct `ctx.llm.stream()` caller — the judge, like the title and compaction providers before it — can set it, and those auxiliary calls already sit outside the loop's logged header.

### Adapters in this tree

Two adapters ship request bodies: `DeepSeekAdapter` maps the field, and `PiAiAdapter` rejects it. pi-ai's `SimpleStreamOptions` has no answer-format member — its common streaming options carry `toolChoice`, `reasoning`, `deferred`, and `thinkingBudgets` — and pi-ai owns the provider body, so the adapter cannot add the field without bypassing `streamSimple`. The rejection sits beside the existing `GenerateOptions.stop` rejection in `streamWithSnapshot`, before any provider I/O, and uses the same `UNSUPPORTED_OPTION` code.

`llm-replay`'s `ReplayAdapter` is the third `LlmAdapter` subclass outside tests. It answers from a recorded stream and sends no provider request, so it honors no request field — it ignores `stop`, `temperature`, and `maxTokens` alike, and the recorded answer already is whatever the original request asked for. Rejecting `responseFormat` there would make a JSON-mode flow unrecordable while protecting nothing.

## Alternatives considered

**Retry the judge on a parse failure and keep the fail-closed path.** Rejected: it pays for a second full judge call on every miss, and the failure it retries is a model that chose prose — a retry does not make that less likely, while JSON mode removes the failure at the provider.

**Strengthen the judge's prompt instead of the request.** Rejected as insufficient rather than wrong: the gateway's prompt already asks for JSON, and JSON mode requires that it keep doing so. The prompt is the half that already failed.

**Register `response_format` through `ctx.deepseekLlmApiExtensions`.** Rejected: that registry's contract is provider-specific fields outside model input, and it applies per registration to every `deepseek-official` request rather than to the one call that wants JSON. It also locks the constraint to one provider, where a seam field lets a second adapter refuse it loudly.

**Widen the type to DeepSeek's other formats, or to a `json_schema` variant.** Rejected: no producer. The same rule that admits `responseFormat` keeps the union at one member until a caller needs more.

**Put the field on `LlmCallConfig` so the loop can set it too.** Rejected: call config is the conversation-level header the loop logs and rebuilds requests from, and an answer format belongs to one auxiliary call, not to a conversation epoch. Adding it there would also put a new model-affecting field into the logged header with no producer that sets it.

**Have the pi-ai adapter hand-build a provider body carrying the field.** Rejected: pi-ai owns request assembly for every route it serves, and reaching past `streamSimple` for one field would fork that ownership for all of them.

## Consequences

This is a fork overlay on an upstream core package. It retires when upstream's `GenerateOptions` gains `responseFormat` or an equivalent answer-format field — `git grep -n "responseFormat\|response_format" upstream/master -- packages/llm` — at which point the fork's gateway adapts to upstream's form. Until then it is re-ported on every rolling sync, because it lands in the type upstream edits whenever the request field set grows.

No shipped composition sets the field, so no session log, snapshot, or recorded fixture changes: an absent `responseFormat` serializes byte-for-byte as before. The evidence is in the two packages that read it — `serialize.spec.ts` pins the mapped wire field and its absence when the request names no format, and `adapter.spec.ts` pins that pi-ai fails with `UNSUPPORTED_OPTION` before it makes any request.
