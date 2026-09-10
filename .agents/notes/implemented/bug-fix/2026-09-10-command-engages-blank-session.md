# Agent Note: A command declares whether it engages the session it runs in

Status: implemented

English | [中文](2026-09-10-command-engages-blank-session.zh.md)

## Problem

Sending `/btw <question>` as the very first message of a brand-new session left the window looking like nothing had happened. The host ran the command and logged it — `command/run` at seq 3, `command/done` at seq 4 in the acceptance session's log — but the centre column kept the Intent hero, rendered no command card, and the sidebar never listed the session. The only way to see the answer was to send an ordinary message afterwards.

Every surface was reading the same bit. `applySessionListMetadata` in [`packages/api/session-controller/src/list.ts`](../../../../packages/api/session-controller/src/list.ts) folded `blank` down on `turn/start` and nothing else, so the host summary of a command-only session still said `blank: true`. From there: `conversationPhase` stayed `'blank'`, so `ConversationRoot` kept the hero and `ConversationSession` returned `null` for the view; `sessionVisible` in [`packages/client/ui-workspace/src/client/tree.ts`](../../../../packages/client/ui-workspace/src/client/tree.ts) shows a blank session only while it is the current one, so no row survived a switch away; and `connectWorkspace`'s reuse scan still treated the session as the workspace's provisional New Session.

Clearing the bit for every command run is wrong in the other direction, and the Intent hero is where it shows. The hero's own access-mode chip runs `/permission` ([`PermissionSelect.tsx`](../../../../packages/client/ui-conversation/src/client/skeleton/PermissionSelect.tsx) through `ISession.command`), and `/plan` configures the agent the same way. A session that engages on those loses the hero the moment someone sets an access mode for a session they have not started — and the hero is the only place the workspace picker and the agent-preset chip exist ([`ConversationRoot.tsx`](../../../../packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx); the staged preset is dropped outright by [`seat-store.ts`](../../../../packages/client/ui-agent-preset/src/client/seat-store.ts) once the session is not blank). Leaving those commands to clear the bit on the host while no client lowers its mirror is worse still: the tab keeps the hero, the host lists the session, and the next launch shows an orphan row per launch — a folder-basename title over a transcript holding one permission card — while `+` mints another session beside it.

## Decision

A command declares whether running it engages the session. `CommandDefinition` in [`packages/interaction/commands/src/index.ts`](../../../../packages/interaction/commands/src/index.ts) gains `engages?: boolean`, defaulting to true; `false` marks a command that configures the session rather than contributing to the conversation. The registry writes `engages: false` into the `command/run` payload only when a definition declared it, so the member is absent on every ordinary run and on every log written before the declaration existed — the same shape `recordInput` already uses for its own opt-out.

`command/run` carries the declaration because the declaration has to survive the log. Both readers below fold events, not registrations: a session reopened next week resolves its own verdict from what its log says, with no registry to consult.

**The classified commands.** Every in-repo registration, and where it lands:

| Command | Package | `engages` | Why |
|---|---|---|---|
| `/permission` | `permission-presets` | `false` | Sets the sandbox mode and approval policy. The Intent hero's access-mode chip runs it. |
| `/plan` | `plan-mode` | `false` | Turns plan mode on or off for the agent that will run the conversation. |
| `/btw` and other out-of-repo commands | — | default | Answer a question in the transcript. |
| `/goal` | `command-goal` | default | Renders a rich command-input card the conversation is built around. |
| `/feedback` | `command-feedback` | default | Its acknowledgement row is the whole visible outcome. |
| `/compact` | `command-compact` | default | Rewrites the conversation; only reachable once there is one. |
| `/export` | `session-log-export` | default | Answers with an export row for a session that already holds a log. |

**The host fold.** `applySessionListMetadata` clears `blank` on `turn/start` and on a `command/run` whose payload does not say `engages: false`. `command/run` rather than `command/done` is the flip point: the executor appends it before the handler runs, the transcript renders it as the command node's first half, and a handler that fails or never returns has still produced a card.

**The projection version stays at 1.** The fold changed and the version did not, deliberately. The unit's state is `{blank, lastPromptAt}` under one row version; `viewCheckpoint` drops a row whose `ver` does not match, and the cold list path never refolds — `summarizeCold` serves rows from the cache alone and opens no Session body. Bumping the version would therefore drop `lastPromptAt` for every session that is never opened again, ordering and labelling the whole sidebar by creation time, in order to correct a `blank` verdict on the sessions that ran a command under an older build. Those sessions keep the verdict they were checkpointed with — the status quo they already had — and everything folded from now on is right.

**The client mirror engages on the event, not at a call site.** `Session.observeEngagement` in [`session.ts`](../../../../packages/api/session-controller/src/client/sessions/session.ts) runs over this session's own window — both the live tail and an installed history page — and lowers the blank bit on a `command/run` that is not declared `engages: false`. That is the one signal every entry point shares: the composer's typed line through `ui-commands`, the hero's access-mode chip and the `/permission` popup through `ISession.command`, and `ui-plan` calling `remote.commands.execute` directly all reach the client as this event and nothing else. `markEngaged` is private again, and no command call site touches the mirror.

`markEngaged` also latches `engaged`, which `handleBlank` consults. Without it an `api-session/added` frame minted before the command landed, or a list pull that raced it, would raise the bit back: `handleSessionAdded` passes the frame's own `blank` straight through.

## Testing

[`commands.spec.ts`](../../../../packages/interaction/commands/tests/commands.spec.ts) pins the recorded declaration: a declaring command logs `engages: false`, an ordinary one logs no member at all. [`validation.spec.ts`](../../../../packages/session/session-format-v0-to-v1/tests/validation.spec.ts) pins the format edge — absent, `false` and `true` are admitted, a non-boolean is refused — and [`migration.spec.ts`](../../../../packages/session/session-format-v1-to-v2/tests/migration.spec.ts) pins that the member survives into v2.

[`session-list-blank.host.spec.ts`](../../../../packages/api/session-controller/tests/session-list-blank.host.spec.ts) drives the projection through a real `Session`: configuration events keep the summary blank, a declared configuration command keeps it blank, an engaging command clears it, the first turn clears it; three direct folds pin `engages: false` against absent and `true`.

[`session.client.spec.ts`](../../../../packages/api/session-controller/tests/session.client.spec.ts) pins the mirror at the boundary that regressed: an observed engaging `command/run` engages once with no send marker and no pending first turn, an observed `/permission` run leaves it blank, a history page carrying the command engages as the live tail does, `ISession.command` admits a line without touching the mirror (the chip's path), and `handleBlank(true)` cannot re-raise an engaged session. [`service.client.spec.ts`](../../../../packages/client/ui-commands/tests/service.client.spec.ts) pins the negative for the typed path: an admitted line reaches the mirror through nothing in that package. [`skeleton.client.spec.tsx`](../../../../packages/client/ui-conversation/tests/skeleton.client.spec.tsx) already pins what a lost hero costs — the workspace chip and the agent-preset seat — and now says why a configuration command must not take it.

## Alternatives considered

**Clear `blank` on every `command/run`.** The rule needs no declaration, no payload member and no classification pass. It closes the Intent hero on the access-mode chip and the `/permission` popup, which is where the workspace picker and the agent-preset chip live and the only place they live; a person setting an access mode before typing loses both, and the session they had not started is listed and no longer reusable.

**Engage at the command call sites instead of on the event.** `CommandUiRuntime.execute` is one line away from the session, and the first version of this fix put the flip there. It covers the composer's typed line only. The hero chip and the `/permission` popup go through `ISession.command`, and `ui-plan` calls `remote.commands.execute` itself — three entry points, three flips to keep in agreement with a host fold, and any plugin adding a fourth silently disagreeing with the host.

**Keep the flag but leave it off the log, reading the registry at fold time.** A projection would ask the command registry whether the running command engages. The fold must be pure and replayable over a stored log with no registry present — a cold list read has no agent, and a session reopened after the command was renamed or uninstalled would fold to a different answer than the one its transcript shows.

**Bump `stateVersion` to 2 so old rows refold.** It is the ordinary response to a changed fold, and it was in the first version of this fix. `viewCheckpoint` drops a mismatched row and only an opened Session refolds; `summarizeCold` never opens one. Every never-reopened session would lose `lastPromptAt` permanently and sort and label by creation time — a visible, permanent regression for the whole sidebar, traded against a stale `blank` verdict on sessions that ran a command before this build.

**Clear `blank` on `command/done` instead.** It flips on a finished command rather than a started one. The transcript already shows the run, so a command that fails, is cancelled, or leaves its `command/done` behind would keep the hero over a card that is on screen.

**Give the summary a second column — "has something to show" — and leave `blank` turn-based.** It would let the conversation shell leave the hero while list visibility and reuse stayed as they are. All three consumers want the same answer for a command-only session: listed, opened on its transcript, not handed back as New Session. A second column makes each of them choose which bit to read, and the two must then be kept in agreement forever.

## Consequences

A session whose only content is an engaging command is an ordinary session: it holds a sidebar row, opens on its transcript, and is no longer the provisional New Session a Workspace connect reuses. A session that has only run `/permission` or `/plan` is unchanged — hidden, reusable, hero intact.

`command-feedback` loses its documented limitation. `/feedback` on a fresh session renders its acknowledgement row, because the session leaves the hero on the run that logged the command.

A command written outside this repository engages by default. That is the safe direction — a command whose output the user cannot see is the defect this fixes — but a third-party command that only configures the session will surface it until its author declares `engages: false`.

Sessions that ran a command before this build and were checkpointed keep `blank: true` in their cached row: the fold is right from now on, and the version deliberately did not move to re-derive the past. A session that is opened again refolds and corrects itself.

The rule lives in two folds, not one: the host projection reads `event.data.engages` typed, and the client mirror re-reads the same member structurally, because window entries may be compact history records. The client's read carries a comment naming the host fold as the other half.
