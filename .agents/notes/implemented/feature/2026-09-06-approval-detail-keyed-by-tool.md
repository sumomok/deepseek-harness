# Agent Note: The approval card's detail is keyed by tool name, so a file mutation previews its diff

Status: implemented

English | [中文](2026-09-06-approval-detail-keyed-by-tool.zh.md)

## Problem

An approval request reaching the browser carries only `toolName`, `callId`, `reason` and a cancellation signal ([`ApprovalPresentationRequest`](../../../../packages/client/ui-approval/src/client/contract/slots.ts)). The card draws that reason plus whatever occupies its `conversation.approval.detail` child slot, and the slot was `single`: exactly one registration for every tool. The lone occupant was `ui-chat`'s `ApprovalCommand`, which parses the correlated call's arguments and returns `args.command` when it is a string. Only `bash` and `pwsh` carry that field, so every other tool's card body was the reason line alone.

For `write`, `edit` and `str_replace_editor` that reason is the model's own `justification` — one sentence about a file the user cannot see. The user is asked to allow a sandbox escalation whose whole point is writing content, and the content is nowhere on the card. The chat row for the same pending call already draws the intended diff (`diffCardModel` returns the argument-derived hunk for an unsettled block), so the information was in the page, one component away from the decision.

A `single` slot cannot be extended from outside without taking it over: entries at distinct priorities coexist, but only the lowest renders and there is no fall-through, so shadowing the slot to add a diff renderer means re-implementing the shell branch too — a copy of `commandOf` and of `intendedDiff`'s escalation-field, `replace_all` and `str_replace_editor` sub-command validation, drifting silently whenever upstream changes either.

## Decision

`conversation.approval.detail` becomes `keyed`, dispatched by the wire tool name — the same shape `tool.call.toolview` already has for chat rows, with the same open key domain (any wire tool name; a key with no entry renders nothing, which is what every tool showed before any entry existed).

`ApprovalPanel` passes `{ entryKey: approval.toolName }`; `ui-chat` registers `ApprovalCommand` under `bash` and `pwsh` (the wire names of both the one-shot and the persistent shells — the persistent tools register the same two names); and `ui-tool` adds [`approval-diff-row.tsx`](../../../../packages/client/ui-tool/src/client/tool/toolviews/approval-diff-row.tsx), registered under `write`, `edit` and `str_replace_editor`. It reads the correlated unsettled call off the Chat snapshot exactly as `ApprovalCommand` does, hands it to the same-package `diffCardModel`, and draws the result with `DiffBlock`. Nothing is re-derived: the preview and the chat row's own pending diff come from one function, and a change to the argument validation reaches both through the compiler.

`APPROVAL_DIFF_MAX_LINES` is 40, against the chat row's 8 and the primitive's default 16. A chat row is a summary the reader scrolls past; the approval card is where the reader decides, and the card body already scrolls at the composer's height, so a long preview cannot push the buttons out of reach. `DiffBlock`'s fold toggle reaches the rest.

Hunk paths display relative to the session workspace when they are rooted there and verbatim otherwise, so a write that leaves the workspace shows the absolute path it will touch. The card adds no title of its own: `DiffBlock` opens with the path and the reason line above it already says what is being asked.

A `write` shows its whole content as added lines, because the browser cannot know at approval time whether the target exists — the client has no filesystem read, and `intendedDiff` has always modelled a write as `oldText: null`. The card therefore claims only what it can: this path, this content.

This is a core patch because the slot declaration, its dispatch site and its shell occupant are three upstream packages; a fork plugin can only shadow the slot, which is the copying this change exists to avoid. It is registered in [`.claude/core-patches.md`](../../../../.claude/core-patches.md) and retires when upstream renders an approval's detail per tool, or opens an equivalent seat.

## Alternatives considered

**A fork plugin shadowing the `single` slot.** No upstream file changes, and it is how every other fork UI addition ships. It costs a verbatim copy of `commandOf` plus `intendedDiff` — around fifty lines whose validation rules (the escalation field pair, `replace_all`'s type, the two `str_replace_editor` sub-commands) are exactly the parts that change upstream, with no compiler pointing at the copy when they do. `jscpd` would report the clone, and the plugin cannot import `diffCardModel` because `ui-tool` does not export it.

**Consuming the tools' own `presentCall(args)`.** `edit`, `write` and `str_replace_editor` each declare a pure `presentCall` returning `{ card: 'diff', diffs, locations }` — the render intent the tool itself owns. The web client never calls it: it re-derives the same diff in `diff-card-model.ts`. Routing the client through `presentCall` is the better long-term shape and a much larger change (a Host-to-Client transport for render intent), unrelated to whether the approval card can show one.

**Carrying the arguments on the approval request.** `ApprovalRequestEvent` could gain `argsRaw`, which would let the approval package render without reaching into the Chat snapshot. It widens a Host-side interaction contract, duplicates data the session log already holds, and makes the approval package a consumer of tool argument formats — the thing keying by tool name specifically avoids.

**Registering the shell keys as a `fallback` at the dispatch site instead.** `renderSlot`'s keyed form takes a `fallback` for an unoccupied key, and putting `ApprovalCommand` there would keep today's behavior for every unregistered tool. `ui-approval` cannot reference it: `ui-chat` depends on `ui-approval`, not the other way round, and the fallback would re-introduce the "one renderer decides for all tools" shape at the owner.

**A larger cap, or no cap.** The body scrolls, so an uncapped diff is readable. The fold keeps the decision buttons' distance from the top of the card bounded for a thousand-line write, and 40 lines is what fits before scrolling becomes the only way to see the whole thing.

## Consequences

`str_replace_editor` approvals previously showed their `command` argument — the literal word `create` or `str_replace` — because `commandOf` accepts any string under that key. They now show the diff instead. Any other tool whose arguments happen to carry a string `command` lost that incidental line; among shipped tools there is none besides the shells and `str_replace_editor`.

`ui-tool` gains a type-only dependency on `ui-approval` for the slot declaration merge, mirroring `ui-chat`'s. The dependency direction is unchanged: `ui-tool` → `ui-chat` → `ui-approval`, and no runtime value crosses.

The generated Client slot catalog now advertises the key domain (`open: … already taken: bash, edit, pwsh, str_replace_editor, write`) and lists five occupants, so a plugin adding an approval preview for its own tool sees the seat without reading this note.

Package tests cover the dispatch and the renderer: `ui-approval` asserts the `entryKey` for a registered and an unregistered tool name, `ui-chat` asserts its two keys, and `ui-tool`'s [`approval-diff-row.client.spec.tsx`](../../../../packages/client/ui-tool/tests/approval-diff-row.client.spec.tsx) covers write, edit, both previewable `str_replace_editor` sub-commands, an out-of-workspace and a workspace-less path, the absent/uncorrelated/settled call, arguments that describe no change yet, and the three registrations.

The assembled evidence is [`apps/web/tests/approval-preview-diff.e2e.ts`](../../../../apps/web/tests/approval-preview-diff.e2e.ts), a keyless lane: an authored replay script issues one `write` carrying `sandbox_permissions: workspace-write` under Read Only, and the golden records the card showing `notes.txt`, its three added lines and the `+3 -0 · 1 file` footer beside the escalation reason, followed by the file on disk matching those lines exactly. The script is authored rather than recorded because the scenario is one deterministic call, which keeps the lane runnable without a model key. `approval-composer`'s recorded golden is unchanged, which is the shell branch's regression evidence.
