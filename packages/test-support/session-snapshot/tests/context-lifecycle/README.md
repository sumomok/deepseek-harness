# Context-lifecycle fixtures (CTX-B4)

English | [中文](README.zh.md)

Five corpora plus one fixture generator, used by the focused acceptance of B1/B3. Design rationale: `.claude-tmp/context-redesign/evidence/dsh-test-harness.md` in the task workspace.

## Files

| Path | Source | Size | Covers |
|---|---|---|---|
| `fixtures/sample-small/` | derived | 154 KB / 515 events | First turn of the real session: compaction failure, tool calls, pairing |
| `fixtures/control-healthy/` | derived | 97 KB / 315 events | Turns 15–17: one **successful** compaction, zero failures |
| `fixtures/boundary-b-consecutive/` | derived | 7.1 KB / 24 events | A successful compaction **immediately followed** by a failed one |
| `fixtures/boundary-c-midexit/` | derived + **authored tail** | 1.1 KB / 13 events | Unclosed `compaction/start` plus a `session/end-seed` restart boundary |
| `boundaries.spec.ts` | test | — | 23 assertions (below) |
| `project.ts` | tool | — | Structure-preserving redaction projector |

Fixture A (parallel/delayed tool results) is **not a file**: the sample holds no delayed result, so `boundaries.spec.ts` builds it in code and marks it authored.

## Generating the fixtures

The source sample is a read-only copy of a live session (sha256 `2b455df98ad82a62a0f27bb58de78991829ece0e1cb2f6c4fd5c911c3545cf96`, 4,998 events). Never generate from the live file, never modify it.

```sh
W=<repo>/dsh-context-lifecycle
RAW=<work>/sample/live-copy.v4.jsonl          # the zstd -d read-only copy
FIX=$W/packages/test-support/session-snapshot/tests/context-lifecycle/fixtures

cd "$W"
# In this worktree `pnpm exec` runs an install first (it currently fails on a package under edit); call tsx directly.
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/sample-small"            --name sample-small            --seq-range 1:514
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/control-healthy"         --name control-healthy         --seq-range 2673:2986
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/boundary-b-consecutive"  --name boundary-b-consecutive  --seq-range 1568:1590
node_modules/.bin/tsx packages/test-support/session-snapshot/tests/context-lifecycle/project.ts \
  "$RAW" "$FIX/boundary-c-midexit"      --name boundary-c-midexit      --seq-range 1568:1573
# Fixture C's tail (session/end-seed plus one ordinary turn) is appended by hand, see below.
```

Running the tests:

```sh
cd "$W" && node_modules/.bin/vitest run packages/test-support/session-snapshot/tests/context-lifecycle/boundaries.spec.ts
```

## Projection rules (project.ts)

- **Structure is preserved**: event type and order, `turn`/`step`, `surfaceOp`, `sourceEventSeqs`, `shadowedSeqs`, `shadowedTokenCount`, `shadowedRange`, `contextWindow`, and `maxTokens` all survive; `callId`/`jobId`/`compactionId` and friends are re-minted as `call-0001`… consistently across events.
- **Content becomes `<redacted:class:bytes>`**: the original UTF-8 **byte length** is kept, so a fixture still proves shrink and budget arithmetic. Classes: `text` / `path` / `model` / `provider` / `arguments` / `error` / `summary` / `header`. `meta.json` totals them per class in `redactedBytes`.
- **Identities are forbidden by default**: `harvestIdentities()` collects every `provider`/`model` value from the input and the self-check **rejects** any that survives projection, matching whole string values rather than substrings.
- **Size is bounded**: one line ≤ 4096 B; `request/header` keeps only `reason`/`startsSeries`; an assistant `stream` keeps its first and last segments; message content keeps 1–2 blocks; a `tool/result` `meta` array keeps 3 entries per level.
- **Six self-checks** (`assertSanitized`, any failure throws): zero path hits, every line ≤ 4096 B, zero forbidden identities, no unredacted content, no orphan call, no orphan result.

## Assertions (boundaries.spec.ts, 23)

**Projector, 6**: byte length kept, path classified, identities forbidden by default including the `harvestIdentities` negative case, `assertSanitized` rejects a surviving identity, rejects unredacted content, rejects an orphan call.

**Fixture A, 3** (authored): a result that arrives a step late still pairs; cutting between a call and its late result is **not** balanced; the pairs close once the late result lands.

**Fixture B, 5**: a successful compaction is immediately followed by a failed one (`previous.end + 1 === next.start`); the failed attempt **does not rewrite the surface** (no `replace` after it); failure **does not retry on every step** (exactly one failed start); pairing holds with both attempts present; every bracket closes.

**Fixture C, 4**: the truncation point leaves exactly one unclosed bracket; `session/end-seed` comes **after** the unclosed start; the abandoned attempt has no `replace`; the restart boundary is followed by a normal `turn/start`…`turn/end`.

**Recorded corpora, 5**: `sample-small` and `control-healthy` each pass the six self-checks with intact pairing; `control-healthy` holds a successful compaction and **no** failed one.

## Known boundaries

- Fixture C's `session/end-seed` and trailing turn are **constructed**: all 25 compactions in the real sample closed, and none crossed a restart. `meta.json` records this in `authoredTail`.
- These are **package-level** fixtures: they drive a scripted adapter and never the `dsh` profile. Promoting them to committed snapshot scenarios goes through `scripts/session-snapshot-corpus-policy.ts` separately.
- The fixtures cover only the event types this sample contains (about 30) and are not a general-purpose redactor.

## Engine-driven measurements (task-31)

| File | Assertions | State |
|---|---|---|
| `measurements.spec.ts` | 11: reclaimed tokens on the recorded corpus, surface span, failure reclaims nothing, fixed-prefix origin, retained tail, consecutive lineage, summary route | All pass |
| `engine.spec.ts` | 13: fixed-prefix precheck, insufficient-reclaim suppression, semantic tail, consecutive brackets, **stale route through a real adapter observing GenerateOptions**, **circuit seeding across a restart**, **durable lock at three interruption points** | All pass |

Running them:

```sh
node_modules/.bin/vitest run packages/test-support/session-snapshot/tests/context-lifecycle
```

`engine.spec.ts` drives the real `BasicCompactionEngine.compactIfNeeded(agent,'pressure',signal)` and stubs nothing under test; `RecordingEngine` overrides only `summarize()` to record calls.

`resume.spec.ts` covers **process-level resume**: seed through the real `JsonlSessionPersistence`, `fiber.dispose()`, a fresh Context, then `agents.resume({ resumeSessionId })`. Five cases cover the durable lock at each interruption point and assert no half-applied replacement, an append-only log, and a stale start that does not block. One case seeds the todo list and an open job **inside** the compacted range, mounts `dsh-compaction-rehydration`, and asserts the checkpoint shadows them while the first pre-step after resume writes exactly one rebuild message and the next adds none.

The JSONL backend locks through `native/system/packages/<platform>-<arch>/bin/system.node`, a **prebuilt artifact** of the package. The worktree carries it, so the cases run; `resume.spec.ts` keeps a `skipIf` at the top so a missing artifact skips with its own explanation instead of failing.

The three **engine-level** interruption cases stay in `engine.spec.ts`, do not need that artifact, and always run.

**For B2 (task-26)**: a case still marked `it.fails` states a target behavior that has not landed; flipping it to `it` once the implementation arrives is the acceptance flip.
