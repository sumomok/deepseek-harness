---
description: "An experimental decision ledger: recorded decisions become constants the model cannot rewrite, and the host assembles the delivered proposal."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-decision-state

English | [中文](README.zh.md)

## Summary

Records the complete effective decisions of a work scope as experimental plugin records, folds them into a per-scope state, contributes a bounded runtime-context view, validates model submissions against that state, and assembles the delivered proposal from decisions plus accepted open dispositions.

A decision settles units. Decided units are constants: a submission that rewrites one, or dispatches one into a task again, is rejected with a structured error. Submissions must carry the current revision, dispose every open unit, and cover every `new` unit with a task. The accepted proposal is assembled by the host, so the model never writes the decided part.

The tool schema is static, so a decided unit remains addressable; the host rejects it on submission. The guarantee lives at the submission and delivery boundary, not in the schema.

## Use this package

```yaml
- name: '@deepseek-ai/dsh-experimental-decision-state'
  config:
    scopes:
      demo:
        units: [a, b, c, d]
```

The host records a change when it observes one, for example after the user accepts a plan:

```ts
ctx.decisionState.record(agent, {
  scope: 'demo',
  decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [42] }],
  supersedes: [],
})
```

From then on, `propose_open_work` is the model's only writable path into the scope: it carries the current revision, dispositions of the remaining units, and the task grouping. An accepted proposal concludes the turn; a rejected one returns the error codes the model must fix.

## Model Experience

### What the model sees

One runtime-context section per configured scope: the current revision, one line per active decision (bounded), and the open unit ids (up to 200 per scope). The section is required, is not prompt-interpolated, and is regenerated after compaction.

### Token effect

`viewLimit` bounds decided rows and `viewBudget` bounds the section's characters; both are configuration. Omission counts are explicit.

## Known Limitations and Deferred Work

- The decided part of a delivered proposal is only as correct as the record the host wrote. The host records at decision time; this package does not detect decisions by itself.
- Scope catalogs are static configuration. Units cannot be added at runtime, and a scope whose latest record fails validation blocks submissions until the host restores it with `repair()` or a later valid record replaces it. The service folds every change before appending, so its own writes cannot create that block.
- Open unit ids are listed up to 200 per scope; a larger catalog needs a read path that this package does not provide. One submission carries at most 100 entries with 200-character identifiers.
- Enforcement covers the controlled submission and its rendered result. Free prose and side-channel actions stay outside this boundary.
- A surface replacement and a real automatic pressure compaction leave the record and the view intact in tests, and a `cordis.yml` Loader boot is tested through a source shim; the committed `lib/` entry and an isolated-profile run are not verified yet.

## Dev Note

- `src/types.ts` — decision and record types plus the `plugin:decision-state/record` declaration.
- `src/state.ts` — fold of complete records, open/decided sets, replacement by id.
- `src/projection.ts` — folds records per scope; unreadable or contradictory records mark the scope corrupt instead of reopening units.
- `src/service.ts` — immediate host recording, the bounded view and the scope catalog.
- `src/tool.ts` — `propose_open_work` validation, assembly and rendered results.
- `tests/` — fold, validation, view, projection, the package entry contract, a Loader boot, a real Agent-loop integration test, a surface replacement and an automatic pressure compaction; run `pnpm exec vitest run packages/experimental/decision-state`.
