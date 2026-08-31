# @deepseek-ai/dsh-experimental-content-column

English | [中文](README.zh.md)

The browser half of the content surface. It claims the service-line shell's `content` column, lists the session's entries in a switcher strip of Chrome-style tabs, and hands the selected one to a keyed slot dispatched by the entry's kind. What it draws is the `contentSurface` projection that [`content-surface`](../content-surface/README.md) publishes; this package reads no configuration, serves no route, and knows nothing about any particular kind.

The node half is an empty plugin. It exists so the row appears in the host `cordis.yml`, which is what makes the browser bundle discoverable through `dsh.client`.

## The column and its kind slot

`content` is the shell's `single`, `root` column, so this registration is its only occupant. Every kind that wants the column registers into the child slot instead of competing for the seat:

`'content.surface.kind': { kind: 'keyed'; scope: 'root'; owner: { sessionId, entry } }`

The key domain is open — it is whatever kind a host extractor produces — so contributing a renderer is additive, and an unclaimed kind renders the column's own "nothing renders this" notice.

**Every registered kind's seat stays mounted for the page's lifetime**, hidden with `visibility` rather than unmounted while another kind is on display. That is the whole reason the slot is root-scoped: a renderer may hold DOM the column must not destroy — a live iframe is the case this was built around — and unmounting the page seat while a chart is selected would reload every one of them. The seat list is append-only for the same reason: React moves a keyed child whose position changes, and moving an iframe reloads it. A seat is therefore rendered far more often than it is selected, and reads `entry` (present only when the selection is its own) to know which it is.

## Choosing an entry

Above the seats, a switcher strip lists the session's entries newest first as `title` plus the kind key. Selecting one is a UI-local act: the choice lives in component state keyed by session id, defaults to the newest entry, falls back to the newest when the entry it named is replaced, and never reaches the session log. A session that has produced nothing gets the empty-state notice, and so does a browser with no current session.

## Closing an entry's tab

Each tab is a Chrome-style pair of sibling `<button>`s inside one wrapper `<div>` — a selection button (`data-content-surface-entry`, `data-content-surface-selected`) and a close button (`data-content-surface-dismiss`, both carrying the same `<kind> <entryId>` key) — never a button nested inside a button. Clicking the close button executes `/dismiss-content-entry <kind> <entryId>` against the current session through `ctx.remote.commands.execute` (`dismiss.ts`), the same command seam `dsh-experimental-server-sidebar`'s page-navigation menu uses for `show-content-page`. `dsh-experimental-content-surface`'s node half owns the command and the fold that removes the record; this package only dispatches and renders the result.

Closing a tab does not blank the column: once the dismissed entry leaves `entries`, `selectedEntry`'s existing "picked entry no longer live" fallback — previously exercised only by a replaced entry — selects the newest surviving one, exactly as it would for any other entry that dropped out of the stream.

This package also registers an empty `conversation.chat.commandview` entry for `dismiss-content-entry`, plus the stylesheet collapsing the empty row it leaves behind, mirroring `content-frame`'s identical mechanism for `show-content-page` under its own `STYLE_ID` — the durable dismissal record is the point, not a chat message narrating a tab the user just closed. This is why the package now also depends on `dsh-client-ui-conversation` and requires `remote`/`remote.commands`.

## Composition

This row and [`content-surface`](../content-surface/README.md) are two halves of one thing: composing either alone leaves the column empty or the stream undrawn. Three overlays compose both — [`content-frame`](../content-frame/overlay/content-column.patch.yml)'s, [`vue2-echarts-tool-poc`](../vue2-echarts-tool-poc/overlay/show-chart-three-column.patch.yml)'s, and [content-surface's own](../content-surface/overlay/full-surface.patch.yml) everything demo. Neither half is part of any shipped bundle.

## Model Experience

None, as this row is a browser placement and registers no tool, prompt, or result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No pinning** — the column shows one entry at a time and the selection is a single choice per session. There is no way to keep an entry beside another, and no split view.
- **The selection is per browser tab** — it lives in component state, so a reload, a second tab, and a second device each start from the newest entry. Making it durable would be a new logged fact, which the column deliberately does not have.
- **The switcher badges the raw kind key** — `page`, `chart`. The column cannot localize a name for a kind it does not know, and no per-kind label contribution exists yet; the product copy around it is Chinese while the badge is not.
- **A seat is never released** — a kind that appeared once keeps its mounted seat for the page's lifetime, even after the session that produced it is gone. That is the keepalive guarantee, and its cost is that a long-lived tab accumulates one mounted renderer per kind it has ever seen.
- **The hidden command row is coupled to a DOM shape this package does not own** — `hide-empty-command-row.ts`'s selector reaches through `ChatNodeSeat.tsx`'s `data-chat-flow-kind` attribute and `dsh-client-ui-renderer`'s `data-slot` anchor wrapper, neither a contract this package can rely on staying stable; a shape change on either side silently un-collapses the row instead of failing loud (the same fragility `content-frame`'s identical mechanism already carries).
- **A dismissal is dispatched with no confirmation UI** — clicking the close button fires the command immediately; there is no undo affordance beyond re-navigating to (or having the agent redraw) the same `(kind, entryId)`, which the fold treats as an ordinary fresh entry.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
