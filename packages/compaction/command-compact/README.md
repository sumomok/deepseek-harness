---
description: "The on-demand /compact command for interactive compositions: what it does, what you see, and how to mount it."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-compact

English | [中文](README.zh.md)

## Summary

`dsh-command-compact` adds a `/compact` command to chat UIs: type it and the conversation condenses on demand — the older history is replaced by one summary even before automatic pressure triggers. It works with any condensation backend, consumes no model turn, and reports how many history items were condensed and the estimated tokens saved. Typed during a turn, it waits for the turn's end or, if a timing setting says so, its next step boundary. Prompts you send while it runs start after it finishes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Type `/compact` in a chat UI when the conversation has grown long and you want to condense it immediately. The shipped `dsh` base mounts the command next to the default backend, so it is usually already available.

### Using the command

| Input | Result |
|---|---|
| `/compact` | Condense one useful balanced older span even below automatic pressure, then report the replaced history-item count and estimated tokens. |
| `/compact` with no compactable history | `No compactable history yet.` — nothing changes. |
| `/compact <anything>` | `Usage: /compact (no arguments)` — the command takes no arguments. |
| `/compact` while a turn runs | Waits and compacts at the boundary the mounted `ctx.manualCompactionTiming` names: `turn-end` after the turn, before any queued turn's first request; `next-step` at the turn's next step boundary, or after the turn when none follows. Without that provider it is refused as below. |

### What you see

The command turns each expected failure into a stable message you can show directly; the situation on the left is what produced the message on the right.

| Situation | Message you see |
|---|---|
| Compaction already running, another request waiting, or the agent mid-turn with no timing provider | `Compaction is unavailable because this process has an active compaction, or the agent is not idle.` |
| The history changed while condensing | `The history selected for compaction changed before it could be replaced. The attempt is recorded in the session log.` |
| No useful summary could be produced | `Compaction could not produce a useful summary. The attempt is recorded in the session log.` |
| Condensation did not finish cleanly | `Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.` |
| The conversation could not be saved | `Compaction finished, but the session could not be saved.` |

Cancelling the command stops the wait: the backend finishes its required cleanup, and the command settles as `Compaction cancelled.` while the UI stops waiting. A request waiting for a running turn settles the same way when Stop ends that turn, when the invoking UI request closes, or when this plugin stops. The fixed texts in these tables are exported from the cordis-free `@deepseek-ai/dsh-command-compact/result-text` leaf so a client can recognize and localize them. Failures other than these expected cases surface as errors rather than being silently converted.

### Composing the command

Mount the command registry, one condensation backend, and this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
```

The shipped `dsh` base mounts it beside the default backend, and the Web client provides the command adapter; the Web Chat plugin also provides `ctx.manualCompactionTiming` from Settings → General → Compaction while busy. Automation surfaces that compose no command adapter keep automatic condensation only.

### What happens to the conversation

When the command succeeds, the selected older span is replaced by one summary and the recent history is untouched; the command reports the number of condensed items and estimated tokens. Prompts you submit while condensation runs are accepted and start only after it finishes — they are not lost or reordered. The command lifecycle is recorded in the session log but never enters model history.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the command; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The command is built on three commitments:

- **Backend-independent control.** The handler depends only on `compactNow(agent, signal, commandId, whileBusy)`, so it works with any `CompactionEngine` implementation. The invoking agent is the exact target, the dispatching UI's cancellation signal is forwarded through the seam, and `whileBusy` is the optional provider's live answer, read once per request.
- **The command lifecycle stays out of model history.** `command/run` and `command/done` are log-only events; `sourceEventSeq` correlates the successful result with the `compaction/summary` event without relying on text or row adjacency.
- **Quiescent teardown.** The lifecycle effect unregisters `/compact`, aborts the signal every handler forwards, and then drains already-started handlers, so a request still waiting for a turn settles and an aborted command's close and flush work finishes before root disposal completes.

### Lifecycle and correlation

Every resolved invocation records the executor-owned log-only pair `command/run` / `command/done`; neither event joins model history. On success, `command/done.sourceEventSeq` names the transaction's `compaction/summary` event so a presentation can fold the command lifecycle into its checkpoint without parsing result text or assuming adjacent rows. The busy outcome is intentionally process-scoped: a live unmatched marker blocks, while a marker older than the newest `session/end-seed` is stale and does not. The plugin tracks each real handler promise and unregisters `/compact` before aborting and draining handlers that already started, so root teardown cannot pass an aborted command's close or flush boundary, and a request waiting for a turn cannot hold the drain open. Prompts submitted while compaction runs remain accepted in the agent's ordinary FIFO and start only after the compaction's explicit durability checkpoint and admission release; idle injected context may sit between `compaction/start` and `compaction/end` and stays visible after the checkpoint.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `/compact` registration, argument rejection, busy-state timing, error-code mapping, lifecycle drain |
| [`src/result-text.ts`](src/result-text.ts) | Cordis-free fixed result texts, exported as `./result-text` |
| — | No runtime invariant companion is published; this command adapter owns no state or event stream; the compaction seam owns the balanced durable transaction and the command registry owns registration and dispatch lifecycle. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the command to the seam, the shipped backend, and the design decisions.

- [Compaction seam](../compaction/README.md) — the condensation contract this command triggers.
- [Compaction basic backend](../compaction-basic/README.md) — the shipped backend that condenses automatically and on demand.
- [Commands package](../../interaction/commands/README.md) — the registry and dispatch contract behind chat commands.
- [Compaction subsystem reference](../../../docs/subsystems/compaction.md) — the condensation vocabulary, results, and service behavior.
- [Queued manual compaction Agent Note](../../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md) — how on-demand condensation serializes against running turns.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/compact` control

#### What the model sees

The slash input and direct result never enter a model request. An accepted compaction separately replaces an older span with the backend's user-role checkpoint inside a `compaction/*` bracket: standalone `turn: null` between turns, or owned by the running turn when a waiting request compacts at its step boundary.

#### Token effect

The command lifecycle adds no model tokens. A successful compaction reduces later requests by replacing the selected span with one framed summary; summarization itself is one auxiliary request.

#### KV Cache effect

Discovery and command bookkeeping do not affect the cache. The accepted surface replacement invalidates reuse from the first shadowed history token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the command is a poor fit; they are the current package constraints.

- **Waiting needs a timing provider** — without `ctx.manualCompactionTiming`, `/compact` reports that condensation is unavailable while a turn or an accepted waking prompt has right of way. With it, one request per agent waits; closing the invoking UI request (for example reloading the page) cancels it.
- **No range or policy arguments** — the argument-free form keeps behavior stable across command adapters. Explicit ranges remain the programmatic `compactRegion()` path.
- **Command adapters only** — surfaces without `ctx.commands` cannot invoke it and rely on automatic pressure compaction.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Range and policy arguments, undecided** — argument-free stability is deliberate; adding arguments would need a shared grammar across every command adapter.

</details>
