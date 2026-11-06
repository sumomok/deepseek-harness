---
description: "The ⌘F Workspace search overlay: matched Workspaces and Sessions from the client catalogs, then cursor-paged Host message hits, grouped by kind with matched-span highlighting and one keyboard path through all of them."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-search

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-search` puts one search field over the Workspace. Typing lists matching Workspaces and Sessions from the client catalogs immediately, then reads the Host's indexed message content page by page under a cursor the Host minted. Results are grouped into Workspaces, Sessions, and Messages; Enter opens the selected Workspace, Session, or message. The panel debounces message keystrokes, cancels the superseded read, and keeps the previous page visible while the next one loads.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Press ⌘F on macOS, or Ctrl+F on Windows and Linux, anywhere in the desktop window. The browser build uses ⌘⌥F, because ⌘F and ⌘⇧F belong to the browser and to the existing Session search there; both entry points are the same command, `search.messages`, so remapping one remaps the other.

The overlay owns four pieces of state: the query, the name rows the client catalogs yield, the message rows accumulated from every page read so far, and the selection. It never owns transport state — every message read goes through the session data layer, which folds a failed call into a result the panel renders as a failure with a retry.

Name matching is local and instant: each keystroke re-filters Workspace display titles and Session titles, so a name hit appears while the message read is still debounced. The Workspace service opens a matched Workspace; opening a matched Session or message selects that Session, and a message carries its position so the Chat view can land on it.

## Understand the implementation

`src/client/local.ts` derives the name rows: case-insensitive substring spans over Workspace display titles and Session titles, Workspaces in Host order then Sessions newest first, with blank, subagent, and archived Sessions excluded the same way the Workspace browser excludes them.

`src/client/index.ts` holds the plugin body: it registers the dictionaries, the shortcut, and the `shell.overlay` entry, composes the name rows ahead of the Host message rows, and owns the debounced read sequence. A sequence counter discards any reply that a newer keystroke or a dismissal already superseded, so a slow page can never overwrite a fresh one.

`src/client/state.ts` carries the panel state, the row union, and the wire-derived cursor type. `src/client/SearchPanel.tsx` is pure presentation: it receives the snapshot and the callbacks through the slot's inject face and holds no service of its own.

Paging follows the Host: `nextCursor` is opaque, and the panel stops asking when it is absent. Scrolling to the bottom of the list asks for the next page only while the sequence is settled, so a pending read is never doubled.

## Further Exploration

- [Session query](../../session-query/session-query/README.md) owns the index and the message search it serves.
- [Session controller](../../api/session-controller/README.md) owns the `session.searchMessages` Remote and its cursor envelope.
- [Workspace browser](../ui-workspace/README.md) owns the Session catalog, Workspace labels, and the local search it runs over the same data.
- [Web client](../../../docs/subsystems/web-client.md) describes the slot and inject conventions this package follows.

## Model Experience

None, as this package renders search results for a human and touches no prompt, message, schema, stream, or tool result. The indexed content it displays belongs to Sessions the model already sees through their own transcripts.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- Name matching is a client-side substring match over the loaded Session and Workspace catalogs. It does not match Session ids, Workspace paths, or content the catalogs do not list.
- Opening a message result opens its Session. Landing on the matched message and highlighting it needs an event-to-node mapping the Conversation does not expose yet; assistant messages merge into grouped nodes, so a `seq` does not name one.
- The panel reads the Host's index as it stands. Sessions the Host never indexed are reported through the coverage field and surface as an incomplete-result warning, never as a silent omission.
- Message results are flat rather than grouped by Session; the grouping alternative was drawn and deferred.
- Archived Sessions are hidden from every section, matching the sidebar; there is no "include archived" option yet.
- An excerpt is the Host's raw text. The matched spans index that raw string, so presentation that removes markup needs a position mapping before it can replace the literal render.
- The panel mounts only where the Host's message index is open. The stock Web profile keeps it closed, so the bundle row is disabled there; a deployment that enables content search adds the row beside its `openAt` override.

### Dev Note

The dictionaries own every visible string, so the panel carries no literal copy. Row highlighting derives from the match ranges the Host returns, which are already clipped to the excerpt window, or from the spans computed for a name by `local.ts`; the panel only splits a string into runs and never searches it again.