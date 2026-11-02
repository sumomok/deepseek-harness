---
description: "The ⌘F message search overlay: cursor-paged Host full-text results rendered as addressable messages, with matched-span highlighting and keyboard navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-search

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-search` puts one search field over every Session in the Workspace. Typing reads the Host's indexed message content, page by page under a cursor the Host minted, and paints each hit as a message that belongs to a Session rather than as a Session that once mentioned the phrase. Enter opens the selected hit; Escape dismisses the overlay. The panel debounces keystrokes, cancels the superseded read, and keeps the previous page visible while the next one loads.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Press ⌘F on macOS, or Ctrl+F on Windows and Linux, anywhere in the desktop window. The browser build uses ⌘⌥F, because ⌘F and ⌘⇧F belong to the browser and to the existing Session search there; both entry points are the same command, `search.messages`, so remapping one remaps the other.

The overlay owns three pieces of state: the query, the rows accumulated from every page read so far, and the selection. It never owns transport state — every read goes through the session data layer, which folds a failed call into a result the panel renders as a failure with a retry.

## Understand the implementation

`src/client/index.ts` holds the plugin body: it registers the dictionaries, the shortcut, and the `shell.overlay` entry, and owns the debounced read sequence. A sequence counter discards any reply that a newer keystroke or a dismissal already superseded, so a slow page can never overwrite a fresh one.

`src/client/state.ts` carries the panel state and the wire-derived cursor type. `src/client/SearchPanel.tsx` is pure presentation: it receives the snapshot and the callbacks through the slot's inject face and holds no service of its own.

Paging follows the Host: `nextCursor` is opaque, and the panel stops asking when it is absent. Scrolling to the bottom of the list asks for the next page only while the sequence is settled, so a pending read is never doubled.

## Further Exploration

- [Session query](../../session-query/session-query/README.md) owns the index and the message search it serves.
- [Session controller](../../api/session-controller/README.md) owns the `session.searchMessages` Remote and its cursor envelope.
- [Web client](../../../docs/subsystems/web-client.md) describes the slot and inject conventions this package follows.

## Model Experience

None, as this package renders search results for a human and touches no prompt, message, schema, stream, or tool result. The indexed content it displays belongs to Sessions the model already sees through their own transcripts.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- Opening a result opens its Session. Landing on the matched message and highlighting it needs an event-to-node mapping the Conversation does not expose yet; assistant messages merge into grouped nodes, so a `seq` does not name one.
- The panel reads the Host's index as it stands. Sessions the Host never indexed are reported through the coverage field and surface as an incomplete-result warning, never as a silent omission.
- Results are flat rather than grouped by Session; the grouping alternative was drawn and deferred.

### Dev Note

The dictionaries own every visible string, so the panel carries no literal copy. Row highlighting derives from the match ranges the Host returns, which are already clipped to the excerpt window; the panel only splits the excerpt into runs and never searches it again.
