# Agent Note: descriptions that describe themselves, refusals that only say why

Status: implemented

English | [中文](2026-09-04-self-contained-tool-copy.zh.md)

## Problem

The content channel offers five tools, and until this change its copy positioned them against each other. `content_read`'s description said it was the read to start from and named `content_read_dom` and `content_read_attrs` as where to go when class tokens are not enough; `content_read_dom`'s said outright not to use it as the ordinary read and named `content_read` as that; both single-element reads said their ref comes from "a previous content_read or content_read_dom"; `content_act`'s said every target is a ref from a `content_read`. Refusals did the same thing one step later: an empty column said to call `content_show`, a stale ref said to call `content_read` for current refs, a claim timeout over a column that already held a page said `content_show cannot help here`.

On a real console the cross-references misrouted the model in the direction they were written to prevent. Asked what two unlabelled icons in a table's 操作 column were, the model's first move toward the markup was `content_read` with `mode: "dom"` — a value the tool's own enum refuses — and only then `content_read_dom`. It had read that `content_read` was the read to use and that a DOM read existed, and it combined them.

The refusals cost a second run outright. With the screen locked, the console's tab was open but `document.visibilityState` was `hidden`, so no seat claimed anything. Four reads in a row answered `No open console is showing this session's content column … Call content_show to put a page there, or ask the user to open the console` — the wrong diagnosis, since a console *was* open — and the model spent one `content_show` on it anyway, despite the sentence that said `content_show cannot help here`.

## Decision

Two rules, over every string this package puts in front of the model.

**A description describes its own tool, or its own parameter, and names no other tool.** No description says which sibling to prefer, which is cheaper, or which is where a ref comes from. The model chooses from the descriptions as a set.

**A failure states why the call was refused, and nothing else.** No `call X`, no `X cannot help here`, no `ask the user to …`, no `retry once`. A refusal may name this tool's own parameter where the parameter is the reason — `scope must be a ref like "e12" printed by an earlier read of this page` — because that is the reason and not a remedy. What to do next is read off the descriptions.

`SCOPE_DESCRIPTION` gained one fact under the first rule rather than in spite of it: omitting `scope` reads the whole page. Both arms of the A/B invented a value for it on a first call, and that is a fact about the parameter itself.

### What the rules collapsed

The old copy carried machinery whose only job was to let each tool name itself. `ToolVoice`, `readVoice` and the two `ACT_VOICE`/`READ_VOICE` constants existed so that the shared "entry in front is not a page" and "column is empty" endings could be worded per caller; with the remedy gone, both endings are one sentence and the type is gone with them. `noAgentRefusal(tool)` and `cancelledRefusal(tool)` became the constants `NO_AGENT_REFUSAL` and `CANCELLED_REFUSAL`, `awaitRead` no longer takes the caller's wire name, and `act-text.ts` no longer keeps its own copies of the two shared refusals. `moreTextMarker(ref)` became `MORE_TEXT_MARKER`, because the line it ends already opens with that ref.

### Where the rules do not reach

The request-context lines in `perception/text.ts` still name `content_read` and `content_show` (`content_read reads the entry in front; content_show puts a page in front.`). They are the model's map of the channel, which is what a description is; they are not a tool's own description and not a refusal, and [the perception note](2026-09-02-content-column-perception.md) owns them.

The `content_read` refusal for an invalid `mode` is the core schema validator's enum message and names the tool. It is not this package's string and is left alone.

### The fork rule

`.claude/CLAUDE.md`'s tool-parameter bullet asked for "failure text that names the remedy". It now asks for a description that describes its own tool and its own parameters and names no other, and failure text that states why the call was refused and names no remedy tool.

## Evidence

One A/B on a real console (ini-web2, 空间图层), same model and effort, same page, one fresh session per cell, two prompts, look-only. n = 1 per cell; temperature was not controlled.

| Arm | Prompt | Calls | `content_read` | `_dom` | `_attrs` | Errors | First misuse | Answer |
|---|---|---|---|---|---|---|---|---|
| Cross-referenced | A (DOM) | 13 | 7 | 3 | 3 | 1 (`content_read mode:"dom"`, refused by the enum) | guessed `mode: dom` before reaching the DOM read | correct |
| Cross-referenced | B (attributes) | 11 | 5 | 2 | 4 | 1 (`content_read scope:""`) | empty `scope` on the first call | correct |
| Self-contained | A (DOM) | 11 | 5 | 1 | 4 (+1 `_dom_content`) | 2 (`content_read mode:"find"`, refused by the enum) | reached `content_read_dom` directly; read `find` as a `mode` value | correct |
| Self-contained | B (attributes) | 9 | 6 | 1 | 2 | 1 (`content_read scope:"__page__"`) | guessed a `scope` value on the first call | correct |

The misroute the change targets — reaching for `content_read mode:"dom"` — did not recur in the self-contained arm. Call counts fell in both prompts (13→11, 11→9) and whole-tree DOM reads fell from 3→1 and 2→1, but with one session per cell those are observations, not measurements. Both arms invented a `scope` value on a first call and read a word as a `mode` value, neither of which the cross-referencing caused.

The refusal half rests on a separate recorded run rather than on the A/B: four `content_read` calls answered with the claim-timeout sentence while the screen was locked, one `content_show` spent against a sentence that said it could not help, and the model finally asking the user about the browser connection.

## Alternatives considered

**Keep the cross-references but front-load them.** Move `content_read_dom`'s "this is not the ordinary read" to the first sentence, and `content_read`'s pointer to the markup reads before the table paragraph. Rejected by the owner's ruling: it keeps every description a function of its siblings, so the next tool added to the channel edits four descriptions, and the A/B's misroute came from a model combining two true cross-references rather than from missing one.

**Name remedy tools in refusals only, keeping descriptions self-contained.** This is what the A/B write-up itself recommended: a refusal is directional guidance at the moment of failure, which is a different thing from positioning at the moment of choice. Rejected by the owner's ruling, and the locked-screen run is why it is not obviously safe: a refusal that names a remedy is a diagnosis, and a wrong diagnosis sends the model somewhere no description would have.

**Two facts were dropped rather than reworded**, because neither can be stated without naming a sibling. `content_read` no longer says it costs a fraction of the page's own markup, and `content_read_dom` no longer says it costs an order of magnitude more than a listing. Both are relative costs, and a relative cost has a second tool in it by definition. What remains against a model spending a page's budget on markup is `content_read_dom`'s required `scope`.

## Consequences

**Tool choice now rests entirely on the descriptions.** Nothing in a result or a refusal steers the next call. A model that reads one description and acts has less to go on than before; a model that reads all five has the same information, minus the two relative costs.

**Refusals no longer diagnose.** They report a condition — the column is empty, no visible console tab claimed the call within the wait, the answer came to N characters past the budget — and stop. The claim-timeout sentence also says *visible* now, which is what the seat actually requires and what the locked-screen run proved the old sentence got wrong.

**The map listing keeps its parameter and loses the call spelling.** `Read a part with scope, e.g. content_read({ scope: "e1" }).` is now `Read a part with scope "e1".`

**One gate, mechanically checked.** [`tests/self-contained-copy.client.spec.ts`](../../../../packages/experimental/content-frame/tests/self-contained-copy.client.spec.ts) walks the whole export surface of `text.ts` and `act-text.ts` — every string, and every function called with recorded arguments — and drives a real read to a map listing so `render.ts`'s private closing line is covered too. It also assembles the six tool definitions and reads every `description` each one carries — its own, its parameter schema's at any depth, and its output schema's — which is what covers the lines composed in `tool.ts`, `read-tool.ts`, `markup-tool.ts`, `act-tool.ts` and `read-value.ts` rather than exported as sentences. An exported function with no arguments recorded fails the walk, so a sentence added later is covered the day it is written. The tool names come from `wire.ts` and `tool.ts` rather than from literals, which is why `content_show`'s wire name is now the exported `CONTENT_SHOW_TOOL_NAME`.

**Four Web fixtures carry the tool schemas and the refusals**, so the copy change is visible in the assembled transcript rather than only in unit pins.

## Testing

`pnpm exec vitest run packages/experimental/content-frame` — 700 tests, including the new gate spec and the updated verbatim pins in `content-read-tool`, `content-markup-tool`, `content-act-tool`, `content-act-text`, `content-act-executor`, `content-read-executor`, `content-read-routes`, `markup` and `snapshot`.

Per-file coverage over this package's `src`, which stays at 100%:

```sh
pnpm exec vitest run --coverage --coverage.include='packages/experimental/content-frame/src/**/*.{ts,tsx}' \
  packages/experimental/content-frame
```

The four Web fixtures are refreshed keylessly and replayed:

```sh
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/content-read.e2e.ts \
  apps/web/tests/content-act.e2e.ts apps/web/tests/content-read-dom.e2e.ts apps/web/tests/content-read-attrs.e2e.ts
```

The gate spec's own rejection was proved by reintroducing `Call content_show to put a page there.` in `EMPTY_COLUMN_REFUSAL` and the old call spelling in `render.ts`'s closing line: the walk reported both, and the listing check reported `content_read`.
