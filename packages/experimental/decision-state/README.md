---
description: "An experimental decision ledger: recorded decisions become constants the model cannot rewrite, and the host assembles the delivered proposal."
kind: "package-reference"
---

# @deepseek-ai/dsh-decision-state

English | [中文](README.zh.md)

## Summary

Records versioned decisions about a scope's units as durable Session messages, folds them into an effective state, validates model submissions against that state, and assembles the delivered proposal from decisions plus accepted open dispositions.

A decision settles units. Decided units are constants: a submission that rewrites one, or dispatches one into a task again, is rejected with a structured error. Submissions must carry the current revision, dispose every open unit, and cover every `new` unit with a task. `assemble()` merges the effective decisions back into the delivered proposal, so the model never writes the decided part.

This package currently exposes the pure fold, validation, assembly and bounded view. The service, projection, context provider and tool registration follow on the same branch.

## Use this package

```ts
import { applyLedgerEntry, EMPTY_SCOPE, validateSubmission, assemble, renderView } from '@deepseek-ai/dsh-decision-state'

const state = applyLedgerEntry(EMPTY_SCOPE, entry)
const result = validateSubmission(submission, state, catalog)
if (result.ok) deliver(assemble(state, submission))
```

## Model Experience

### What the model sees

`renderView()` returns one line per active decision plus the number of open units, bounded by a row limit with an explicit omission count. The view is for visibility only; enforcement happens on the submission, not on the text.

### Token effect

The view is bounded by the caller's row limit; omission counts are explicit rather than silent truncation.

## Known Limitations and Deferred Work

- The decided part of a delivered proposal is only as correct as the ledger entry that recorded it. The host records entries at decision time; this package does not detect decisions by itself.
- Rules that cannot be expressed as a unit disposition remain context-only.
- Enforcement covers the controlled submission. Free prose and side-channel actions stay outside this boundary.
- The view reaches the request one step after the ledger message commits, because it is assembled from committed events; hosts record between turns in practice.

## Dev Note

- `src/state.ts` — deterministic fold; stale entries return the previous reference.
- `src/validate.ts` — submission validation, host assembly, bounded view.
- `src/types.ts` — decision and ledger types plus the `decision-state` message source.
- `src/projection.ts` — fold of `decision-state` messages into per-scope state.
- `src/service.ts` — queued host recording flushed as durable messages on pre-step.
- `src/tool.ts` — `propose_open_work`, the model's only writable path into a scope.
- `tests/integration.spec.ts` — real Agent loop, tools and projections: the ledger message, the injected view, a rejected rewrite and an accepted, turn-concluding submission.
- `tests/` — fold, validation and view behavior; run `pnpm exec vitest run packages/experimental/decision-state`.
