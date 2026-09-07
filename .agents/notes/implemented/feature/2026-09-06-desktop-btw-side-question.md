# Agent Note: A side question that leaves the conversation as it was

Status: implemented

English | [中文](2026-09-06-desktop-btw-side-question.zh.md)

## Problem

Asking the assistant about the work in progress — why a step was taken, what a term means, whether an approach is sound — costs the conversation twice. The assistant answers instead of continuing, and the question and its answer sit in the context of every request after it, paid for on every later turn. There was no way to ask without both.

## Decision

`@haoran/dsh-btw` 0.1.0 joins the desktop built-ins listed in [`apps/desktop/README.md`](../../../../apps/desktop/README.md), vendored as `apps/desktop-server/vendor/haoran-dsh-btw-0.1.0.tgz` (sha256 `ab585bb293edf7c01e725a5a393e2a3cc36823ab53bb99479aa4af9a7090fc6b`). It registers one command: `/btw <question>` sends the conversation so far plus the question, shows the answer in a row of its own, and leaves the conversation exactly as it was.

**The isolation is structural.** The question and the answer are the command registry's own two events — `command/run` carries `name: 'btw'` and the question verbatim in `args`, and `command/done` carries the answer, or the reason there is none, in `text`. Neither is a surface event type, and `Session.deriveMessages()` — the one function that builds a model request's message list — folds only over surface nodes. Nothing this plugin writes can reach a later request, and nothing has to remember not to.

**Recording them is not optional.** The question goes into a model request, and the harness's rule is that anything a model request sees is reconstructable from the session log.

**It declares no session event of its own.** A richer record — question, answer, model, token usage in one payload — would need an event type this plugin declares, and it cannot have one: `SessionEventMap` is generated from this repository, a log carrying an event type outside that vocabulary refuses reconstruction unless the envelope is marked `ignorable: true`, and `Session.append(type, data, ...opts)` ([`packages/core/session/src/index.ts`](../../../../packages/core/session/src/index.ts)) has no parameter that writes that field. An out-of-repository plugin that declared one would make every session that used it unreadable after a restart, and unreadable again for anyone who uninstalled the plugin. The model id therefore rides at the end of the answer on an attribution line, which the row turns into a subtitle; token usage is not recorded.

**One request on the conversation's own route.** No summarizing pass and no second model: the input is the whole conversation plus the question, so a side question in a long conversation costs what a turn in that conversation costs, and each one is billed at that full length on its own. `provider` and `model` are absent from the shipped config, which is what makes the route follow the conversation — a model switch carries over with no configuration, and a `/btw` typed before the conversation has a route of its own follows the deployment's default model. The system prompt in the config is the only thing telling the model what kind of answer is wanted: a side question arrives with the conversation as context but without the agent's own system prompt and without tools.

**The answer is not streamed.** It appears complete rather than word by word, because the only channel that could carry the increments to the browser is a session event, and this plugin writes none of its own. A Typert stream remote is the second seam that would carry them, and it is not built.

**Stop is the registry's, and the row reads it.** Pressing stop aborts the request — the model call is cut off rather than left running for tokens nobody will read — and the registry settles the command with `signal.reason` as the message, superseding this plugin's own "Cancelled" line. That stored text is English and technical (`This operation was aborted`, or the registry's `command aborted` fallback), so a failed `/btw` whose text carries the word "abort" is drawn as **Cancelled** in the interface language with the stored text on hover. The recognition lives in the row rather than in what is written, because the stored text is not this plugin's to write and a deployment without its browser half falls back to the generic command card, which shows the original.

## Alternatives considered

**Answer in the conversation and compact it away afterwards.** It needs no plugin and reuses the compaction the harness already has. Compaction is lossy and scheduled by pressure, not by intent: the exchange still enters every request until something compacts it, and what survives compaction is not the caller's decision. The cost this exists to remove is the one it would leave in place.

**Summarize the conversation first and ask the smaller model that summary.** It is the cheaper request, and it answers a summary rather than the conversation. A side question is usually about a detail — an argument, an error string, a step's exact wording — which is what a summary drops first. Two requests would also cost more than one for anything but a very long conversation.

**Declare an event type of its own, carrying the question, answer, model, and usage.** It is the record this feature deserves. It is unavailable to an out-of-repository plugin for the reason above, and the failure mode is the worst kind: sessions that read correctly until the plugin is uninstalled or the log is reloaded by a build that does not know the type.

**A sub-Session, so the exchange has a log of its own.** It would carry usage and streaming without touching the parent's message list. It is a much larger surface — a session to create, name, project, list, and clean up — for a question whose whole value is that it leaves nothing behind, and its rows would show up wherever sessions are listed.

## Consequences

The plugin declares `dsh.client`, so the packaging boot gate requires its `client.js` among the client modules the served index names; without that half the generic command card shows the host's own text instead of the row.

A side question is a full-price request. Asking one does not make the next cheaper, and it rides on nothing the ongoing conversation has already cached, so a long conversation is where the feature is both most useful and most expensive.

The record a `/btw` leaves is two events and an attribution line. Anything wanting per-question token accounting has to read the provider's own usage, not the session log.

The host half's own lines are bilingual, Chinese first, because they are durable and are shown verbatim by the generic command card wherever this plugin's browser half is absent. Only the row's chrome — the title, the close control, "Answering…", "Answered by …", "Cancelled" — follows the interface language.

## Related

[The desktop installer ships plugins and seeds them into a profile of its own](2026-08-21-desktop-builtin-plugins.md) owns why the built-ins are in the payload. [The session-log version mechanism](../architecture/2026-08-10-session-log-version-mechanism.md) owns why an event type outside the generated vocabulary refuses reconstruction.
