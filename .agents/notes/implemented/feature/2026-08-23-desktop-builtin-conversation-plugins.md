# Agent Note: The desktop ships quoting and edit-and-rerun

Status: implemented

English | [中文](2026-08-23-desktop-builtin-conversation-plugins.zh.md)

## Problem

Two operations on a conversation that is already open are missing from the web GUI, and both are things a user reaches for within the first hour.

**Citing an earlier passage.** The composer's `@` menu reaches workspace files and other sessions ([web file and session references](2026-07-27-web-file-and-session-references.md)), and it reaches nothing inside the conversation you are in. A pronoun in a long thread — "fix the second problem you listed" — costs the model a re-read of everything above and a guess about which item is meant, and the repair a user performs is to select the passage and paste it back by hand. Pasted text arrives with no indication that it is a quotation of the model's own earlier answer, so the citation the user meant to make is not one the model can see.

**Editing an earlier question.** The user bubble's edit button was removed as a stub that nothing backed, and [the note that removed it](../simplification/2026-07-31-drop-user-message-edit-stub.md) said to reintroduce the control together with the capability. Nothing did. The branch control on that same row cuts *after* the answer, which is the opposite of what editing a question means, so the two repairs the GUI actually offers are asking again at the bottom, which leaves the wrong exchange in the model's context, and starting over, which throws away the part that was working.

Both gaps are client-side, and neither is a harness gap: the seams that answer them — the input-trigger registry, the conversation slots, `sessions.fork` — are published and in this repository already. What was missing is a plugin that uses them and a way for a desktop user to get it without a terminal.

## Why not an existing plugin

The community registry was surveyed for both capabilities, and no candidate is simultaneously functional, secure, and maintained. Three reasons account for the rejections.

**DOM surgery and keystroke interception.** Candidates reach into host-rendered message bubbles with a `MutationObserver` and swallow the composer's Enter key, so a change to the web client's markup or key handling breaks them without any error, and the composer stops behaving like the host's own while the plugin is mounted.

**Custom session events without `ignorable: true`.** A plugin that writes its own event type into the session log makes every session it touched unreadable the moment it is uninstalled, because a `SessionEventMap` member is required-on-read by default and a build that does not know the type refuses the whole log rather than skipping the line.

**Unauthenticated self-update routes.** Candidates register a host route that fetches a new copy of themselves and writes it to disk, reachable by anything that can reach the server, which is arbitrary code execution on the machine the agent is already running on.

## Decision

Both plugins travel in the payload like the five built-ins before them, and neither adds a host surface of any kind.

**`@sumomok/dsh-quote-message` 0.1.0** puts earlier content of the open session into the composer through two entry points its README describes: selecting a passage in any chat message raises a `Quote` pill that appends a reference chip to the draft, and typing `@` adds a *Messages in this session* group that carries a whole message. The chip renders like the built-in `@file` and `@session` chips and expands only at submit time, into one markdown blockquote headed `[quote #12 assistant message msg_01J…]` — the session event position, the role, and the host's message id — capped at 4000 code points with a truncation note when the source is longer. The header follows the interface language at the moment of sending. What the host logs is the ordinary `user/message` the expanded prompt is.

**`@sumomok/dsh-edit-rerun` 0.1.0** puts two buttons on every completed turn's action row, beside copy and branch: one opens a child session with the question prefilled for editing, the other sends it immediately. The boundary rule is the whole of its semantics, and its README states it as one sentence: the child session contains everything up to and including the turn before the edited question, and no part of that question's own turn. Concretely it takes the `turn/end` of the last completed turn strictly before the question and calls `sessions.fork({ atSeq })` there, so the seeded log ends exactly where the replaced turn was about to begin and re-asking cannot duplicate the question. A question that opened the session's first turn has no earlier boundary, so the plugin connects the workspace's blank session with the question prefilled instead of forking. The original session is never modified.

**Both are client-only, and that is what makes them cheap to carry.** Each package's host half is an empty `apply` that exists so the loader mounts a real cordis plugin and the web plugin table finds its `dsh.client` declaration. Neither adds a host route, a remote namespace, a tool, a service, or a session event; neither reads the filesystem or opens a connection of its own. What they use is published client surface: `slots`, `sessions`, `locale`, plus `inputTriggers` for quoting and `workspaces` for the first-turn case, rendering into `conversation.chat.assistant-actions` and `conversation.input.dock`, and for quoting the `slash/input-insert-reference` event with a `ReferenceCodec`. Neither installs a `MutationObserver` or intercepts a keystroke; the one host-rendered attribute either reads is `data-chat-flow-key`, which the web client puts on every chat row for its own scroll anchoring.

**The payload carries them on the rules already in place.** `apps/desktop-server/package.json` declares each as a `file:` specifier naming a tarball committed under `vendor/`, because neither is published and `pnpm deploy` refuses a lockfile entry without an `integrity` hash. `scripts/bundle-closure.ts` keeps a package whole and external when its own manifest declares `dsh.bundle`, which is what stops the reachability walk from deleting a package nothing imports — and keeping them whole is what leaves each `lib/client.js` exactly as its client build left it, since rebundling one for `platform: 'node'` would put an `import ... from 'node:module'` on top of a file no browser can then reach.

**Nothing in the build gate needed changing, and what it proves grew.** `verifyClientModules` reads `dsh.client` from each built-in's manifest in the staged payload rather than from a list, so naming the two packages in `BUILTIN_WEB_BUNDLES` is the whole declaration: the count of built-ins it requires among the client modules the served index names goes from two to four, and each of the four must answer with a body that registers itself through `window.__ModuleLoader__` and imports no Node builtin. Its one floor — that at least one built-in declares `dsh.client`, so the check is not vacuous — is unchanged.

**Every module either browser half requires at run time is in the shell's static table.** `PLATFORM_MODULES` (`packages/client/web/src/platform.ts`) shares `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`, and `@deepseek-ai/dsh-client-ui-primitives` into the frozen module table, and those are exactly the specifiers the two bundles call `require` on. Neither declares `dsh.client.external`, which is the correct declaration for a package that requests nothing beyond that baseline. Their `dsh.client.inject` lists are informational graph metadata rather than module edges, and every package they name — `@deepseek-ai/dsh-client-runtime`, `-locale`, `-ui-conversation`, `-ui-input-trigger`, `-ui-slots` — is either mounted by `@deepseek-ai/dsh-web-app`'s patch layer or in that static table, and each is already named by `dsh-at-file` or `dsh-better-sidebar` today.

**Both names are seeded before `@haoran/dsh-default-model`**, which keeps that package the last bundle layer on a fresh profile, the position [it was given](2026-08-23-desktop-builtin-default-model.md) so it can settle entries the layers before it leave alone. The order costs nothing either way: both new layers only `insert` a plugin row and neither patches an id any other layer sets, so an existing profile that appends the two names after the default-model layer composes the same thing.

## What an existing installation sees

`seedBuiltinBundles` appends the two missing names to whatever `dsh.profile.bundles` already lists and links each package into `$DSH_HOME/profiles/node_modules`, and does nothing else. The profile's `cordis.patch.yml`, its dependencies, and every other manifest field are untouched, so a machine already running a desktop build gains both features on its next launch with no other change to its composition. Neither plugin has a `config` block for a deployment to vary, so there is nothing a user has to set afterwards.

Existing sessions are unaffected in both directions. Neither plugin reads or writes a session log format of its own, so nothing about an old session changes when they mount, and nothing about a session recorded with them mounted needs them to be readable later — a quote is a blockquote inside an ordinary `user/message`, and a rerun is an ordinary child session with the lineage the host records for every fork.

## Alternatives considered

**Leave it to `dsh plugin --profile desktop add`.** The supported install path, and it needs a terminal, a working pnpm, and a reachable copy of a tarball that is on no registry. It is the same argument the sidebar, `@` mentions, and the permission gateway were shipped in the payload for, and it fails for the same person: someone who installed the desktop client to avoid a terminal cannot follow it.

**Wait for the capabilities upstream.** Both belong in the web client eventually — the edit control is a seat the harness already cleared and documented as awaiting a capability, and quoting the current session is the missing third domain beside `@file` and `@session`. Rejected as a reason to ship nothing now: upstream owns published surface for every CLI install and has its own cadence, while these two are one deployment's product decision that costs the repository two tarballs and a handful of manifest lines. If either lands upstream, the built-in is removed and the seat it filled is the upstream one.

**Ship one and not the other.** Quoting is the smaller change and the safer one. Rejected because they answer the same complaint from opposite sides — one repairs a question that was wrong, the other avoids re-typing what was right — and shipping either alone leaves the other reachable only by the install path above.

## Consequences

Both plugins' versions are the installer's, like every other built-in: a new version means building it in the plugin workspace, committing the tarball, moving the `file:` specifier, and shipping a desktop build. The vendored tarball is the only update channel there is, because neither package is on any registry.

The payload gains two client bundles the page loads at boot, which is two more `/plugins/<name>/client.js` fetches on the browser's module graph and roughly 62 KB of committed archives in the repository.

The two plugins pin their peers at `>=0.1.0-rc.1 <0.2.0-0` and were built against `@deepseek-ai/*` `0.1.1-rc.2`. A host that moves past `0.2.0` puts them outside their declared range, and the failure that matters is not the range check but a renamed slot: `conversation.chat.assistant-actions` and `conversation.input.dock` are what edit-and-rerun registers into, and it fails loudly at registration rather than rendering into the wrong place. No gate in this repository checks either plugin against a slot rename, so the signal is the staged boot's client-module check plus opening a session.

Quoting appends to the end of the draft rather than inserting at the caret, because the input machine publishes draft text and a revision counter and nothing about caret position. Edit-and-rerun offers no button on a turn whose question carried an image or an attachment, and none on the earliest loaded turn of a transcript that is still paged, because forking there would cut at the wrong place. Both limits are the plugins' own and are recorded in their READMEs; neither is something this repository can lift without a host change.
