# Agent Note: `content/shown` gets a `by` writer discriminant instead of a second event or kind

Status: implemented

English | [中文](2026-08-29-content-shown-writer-discriminant.zh.md)

## Problem

Until now, exactly one thing ever wrote `content/shown`: the `content_show` tool, on the agent's behalf. `@deepseek-ai/dsh-experimental-server-sidebar`'s page-routes menu needed a second, compliant, replayable way for a *user* to put the same kind of page on display — clicking a menu entry, with no model turn involved — and the result had to land in the exact same place every existing reader already looks: [`content-surface`](../../../../packages/experimental/content-surface/README.md)'s `page` extractor (deduplicated by page id within its `page` kind) and content-frame's `content` projection (the single "what's on display" value). Two writers landing in two different places would fork the column's history in two: a page a user opened and a page the agent chose would occupy separate rows and separate current-page answers for what is, to every consumer, the identical fact.

## Decision

**One event, one field.** `content/shown` gains `by: 'agent' | 'user'`, written by both callers of `session.append('content/shown', ...)` — the `content_show` tool (`by: 'agent'`) and the new `show-content-page` command (`by: 'user'`) that server-sidebar's node half registers on content-frame's own `PageIndex` (see [the content-surface router note](../feature/2026-08-24-content-surface-router.md) for the extractor mechanism this event feeds). A log entry written before this field existed carries neither key, and every reader defaults that case to `'agent'` — the tool was the only writer then, so the default is not a guess, it is what the log actually meant.

**The field's scope stops at the extractor, not the projection.** `content-surface/src/surface.ts`'s `page` extractor keeps `by` in both its stored `data` and its resolved `payload`, which is why its `dataVersion` moves from 1 to 2 — the stored shape changed, which per [the session-log-version-mechanism note](2026-08-10-session-log-version-mechanism.md) invalidates any persisted checkpoint built under the old shape and forces a refold. `content-frame/src/projection.ts`'s `content` projection deliberately does **not** carry `by`: it answers one question, "what page is on display," which has no writer-shaped answer, and nothing today consumes a writer distinction there. `resolveShownPage()`, the helper both the extractor and the projection share, keeps its exact signature unchanged — the extractor wraps its own result with `by` outside that shared call rather than widening what every caller of the shared helper receives.

**No new event, no new kind.** A second event type would need its own `content-surface` extractor registration and would silently stop deduplicating against `content_show`'s own writes — the same page shown once by the agent and once by a user click would become two rows in the switcher instead of one, which is exactly the deduplication-by-entryId behavior `content-surface`'s design note calls out as the point of one kind per concept. `SESSION_FORMAT_VERSION` does not move: this is vocabulary growth on an existing event (an optional field with a defined default for its absence), not a structural change to what a session-log reader must already know how to parse.

## Alternatives considered

**A second event type, `content/shown-by-user`.** Rejected: it duplicates the entire `content/shown` schema for one discriminant bit, forces every existing reader (the invariant, both extractors' `read()`, the projection's `apply()`) to branch on two event types instead of one field, and — worse — creates a second `content-surface` kind that would not deduplicate against the agent's own writes for the same page id.

**Carry `by` on the `content` projection's resolved value too.** Rejected: nothing reads it there today, and adding an unused field to the smallest, most stable wire value in the package (the thing `content_show`'s own tests pin byte-for-byte) is exactly the kind of speculative surface this repository's conventions ask to avoid until a real consumer exists. The extractor is the one path a future renderer would actually need it from.

**Infer the writer from context instead of logging it** (e.g., "no command execution wrapped this append, so it must be the tool"). Rejected: it makes the distinction a derived guess from absence of evidence rather than a recorded fact, and it would break the instant a third writer appeared (a scheduled job, a subagent) with no way to add a third value without redefining what "absence" means retroactively.

**Bump `SESSION_FORMAT_VERSION`.** Rejected per the session-log-version-mechanism note's own rule: only structural format changes bump it, and an optional field with a documented backward-compatible default is vocabulary growth, the exact case that mechanism exists to NOT gate behind a version bump.

## Consequences

Every existing reader of `content/shown` compiles and behaves unchanged against an old log: `by` is optional on read, and both the extractor's `read()` and the tool's own emission default an absent value to `'agent'`. The `content_show` tool's own tests and model-visible text are untouched — it always writes `by: 'agent'` and its result text does not mention the field.

The one place this decision leaves a visible gap is presentation: the `page` extractor carries `by` all the way to its resolved payload, and nothing renders it yet — content-frame's frame view draws the identical iframe regardless of who showed the page. That gap is deliberate and recorded in both packages' READMEs rather than closed here, alongside the separately recorded tension that [`content-surface`](../../../../packages/experimental/content-surface/README.md)'s kind-agnostic `ON_DISPLAY_RULE` prompt text — pinned and measured, not to be edited for this change — still tells the model to update "something you have already produced," which reads oddly for a page a user opened by hand. Closing either gap is a future, independent change; this note's decision only had to make the fact available to close them with.
