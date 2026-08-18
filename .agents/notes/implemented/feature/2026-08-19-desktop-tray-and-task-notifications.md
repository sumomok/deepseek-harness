# Agent Note: Desktop tray residency and task notifications

Status: implemented

English | [中文](2026-08-19-desktop-tray-and-task-notifications.zh.md)

## Problem

The desktop client is a window in front of a running agent, and both of its ends were wrong for that.

Closing the window quit the app on Windows, and quitting tears down the embedded server — so the close button, which in every other browser-shaped window means "I am done looking at this", ended whatever the agent was doing. There was no way to put the client away and leave the work running.

Nothing ever told the user to come back. An agent that finishes a task, or stops to ask for an approval or an answer, produces exactly the same silence as one still working, so the only way to learn that a session wants attention was to keep the window in front and watch it. That is the opposite of what a background agent is for, and it is what makes the first problem hurt: a client you cannot walk away from does not need a tray.

## Decision

### Closing the window asks, once, and remembers

On Windows the close button raises one dialog: 「最小化到托盘」 or 「退出应用」, with a 「记住我的选择」 checkbox. Answering without the checkbox decides that one close. Answering with it writes `closeAction` into `desktop-state.json`, and every later close acts on it without asking. The tray menu's 「关闭时询问」 clears it again.

The minimize button is untouched — it is the ordinary taskbar minimize, and a window that means to stay on the taskbar has to be able to say so.

The tray icon is created at launch, not on the first hide, so 「最小化到托盘」 names something already on screen and 检查更新 / 退出 stay reachable from a hidden window. Its menu is 打开 / 检查更新 / 关闭时询问 / 退出, localized by `app.getLocale()` like the menu bar — `src/menu-text.ts` now owns both label sets, because a tray menu in a different language from the menu bar above it is one product speaking twice.

**Every quit goes through `app.quit()`, and therefore through the `before-quit` teardown that stops the server.** The close handler never destroys a window itself: a window destroyed behind that chain's back leaves the server process tree running, which is exactly the orphan the Windows updater cannot install past. `guardWindowClose` also stands aside entirely while `isQuitting()` is true, so a quit that closes windows as part of its own teardown is not intercepted by the thing it is tearing down.

**A window in the tray changes what a dialog is.** `dialog.showMessageBox` attached to a hidden parent is window-modal to a window with no taskbar button: it can be neither seen nor found. Every updater dialog goes through `ask()`, which now shows the window before attaching, so 「发现新版本」 and 「重启安装」 arrive somewhere the user can answer them. That is the same fault the parentless dialog had, one step further along, and 「没有用户的决定就不会发生安装」 only holds while the decision is visible.

### The state file grew one field

`desktop-state.json` under the user data directory now holds two things, and `src/desktop-state.ts` owns both:

| Field | Meaning |
|---|---|
| `lastRunVersion` | The build that ran last, which is how a launch after an update knows to print 「已更新到 vX.Y.Z」. |
| `closeAction` | `tray` or `quit` — the remembered answer to the close dialog. Absent means ask. |

Reads tolerate a missing or unreadable file and writes tolerate failing, in both directions: this file is a convenience the shell keeps for itself, never a precondition for running.

### The shell subscribes to the server it already started

Two moments interrupt: a session **finished running**, and a session is **waiting for an answer**. Both are read from the running `dsh web` over the two downlink WebSockets the browser UI itself consumes, opened against the loopback URL `startServer` already reported. **No upstream package changed.**

- `/api/events.host` carries `host/session-status`, whose `running` bit is the only true "the agent stopped" edge. The durable `turn/end` log event is not that edge — a turn can be followed immediately by another — and the bit stays `running` while a tool waits for an approval, which is what keeps the two cases from overlapping.
- `/api/events.mux` carries `approval/requested`, `question/requested`, and their `resolved` counterparts, plus every session event, of which only `session/title` is kept: as the name to put in the message.

Both streams are all-sessions with no subscribe handshake, and both are **downlink only** — a client that sends anything is closed with 1008, so nothing in `src/notifications.ts` ever writes to a socket.

Three properties of those streams are load-bearing and none of them is obvious:

**SSE is not available, by the server's own decision.** `GET` on either path is answered `426 Upgrade Required` by the connection plugin before the fetch handler runs, so the SSE branches behind them are reachable only from the in-process carrier. WebSocket is not the preferred transport here; it is the only one.

**A Node client passes the trust fence by sending no `Origin`.** The fence requires a loopback `Host` (satisfied) and accepts an absent `Origin`, while an `Origin` that is not exactly the served authority is refused with a raw 403. So no header is set on these sockets, and none may be.

**Reopening a stream replays what is still pending**, so every request is remembered by id and a repeat is dropped rather than announced twice — `approvalId` for approvals, and the session id for questions, because `question/resolved` names the answered request by its rpc id rather than by the question ids that were asked.

The idle edge is armed the same way: a session announces that it finished only if this shell saw it start. A stream that opens onto sessions already idle would otherwise announce history.

Electron 43's main process is Node 24 with a global `WebSocket`, so all of this costs no dependency.

### The two platforms are told differently

Windows gets a system toast that raises the window when clicked. `app.setAppUserModelId` is set to the `appId` from electron-builder.yml — the same value the installer writes onto the shortcut — because a process whose AUMID does not match a registered shortcut has its toasts silently dropped.

macOS gets a Dock badge and one bounce, and no notification centre entry. This is a product decision, not a platform limitation: an agent that finishes a dozen turns would leave a dozen banners to dismiss, while the badge says how many and where, and clears the moment the window is focused.

Nothing is announced while the window is focused, on either platform.

### A notification cannot open the session it is about

**The web UI has no URL routing.** There is no router library, no `history` use, and the only query parameter read anywhere in the client is `?fixture`; the selected session is in-memory client state. So clicking a notification shows and focuses the window, and stops there — the session that wants attention is then one click away in the sidebar, which already renders a pending-interaction dot and a completed dot for exactly this.

Deep-linking is not a desktop-side gap and cannot be closed from the desktop side. It needs the web client to accept a session in its URL, at which point the shell passes one to `loadURL` and nothing else here changes. Reaching into client internals through `executeJavaScript` was available and rejected: it would make the shell depend on the private shape of a React component tree with no contract to hold it stable.

## Alternatives considered

**Hide to tray without asking, or quit without asking.** Both are wrong for a different half of the user base, and neither is recoverable by the person who guessed wrong: a silent hide loses people who wanted the server stopped, and a silent quit kills the work of people who wanted it kept. Asking once and remembering costs one dialog in the lifetime of an install.

**A tray on macOS too.** Closing the window there already leaves the app in the Dock, `window-all-closed` does not quit, and `activate` reopens the window. A menu-bar icon would be a second control for a state the Dock already shows. macOS keeps its own idiom; the tray is Windows-only.

**`turn/end` as the "task finished" event.** It is the durable log event with the right name and the wrong meaning: turns chain, so a multi-turn task would announce itself several times. `host/session-status` is the bridged form of the agent's own `idle`/`running` status and fires once per stop.

**Polling `session.list`.** Available, unary, and wrong: it would trade a push the server already offers for a timer that is either too slow to be useful or too frequent to be honest, and it still could not see an approval prompt open and close between two polls.

**Injecting a `webserver.tapIndex` transform or a small upstream plugin to expose a session route.** This would make deep-linking work properly and is the right eventual answer, but it is an upstream change, and this round is explicitly a desktop-shell round. Recorded here so the next round starts from the finding rather than rediscovering it.

**Notification centre entries on macOS.** Rejected on volume, above.

## Consequences

The close button now has a meaning the app chose rather than one the window manager imposed, and the embedded server outlives the window that started it. The cost is a dialog on first close and a state file field that can disagree with what the user wants today, which the tray menu exists to fix.

Notifications make the client usable in the background, which is the posture it was built for and could not previously hold. They also bind the shell to a wire format it does not own: `MuxFrame` and `HostFrame` are upstream types, read here by field name through a defensive reader rather than a shared type, because the desktop package deliberately carries no workspace dependencies (it ships `lib/` alone). A frame that changes shape upstream degrades to a missing notification rather than a crash — the switch falls through a documented default and every field read is guarded — but nothing in the repository fails when that happens. That is the honest cost of subscribing from outside the process, and the gate against it is this note plus the frame table above.

Clicking a notification lands the user in the app but not in the session. Until the web client accepts a session in its URL, the sidebar's own pending and completed markers are what finish the journey.

## Testing

Verified against a live `dsh web` on macOS: both sockets accept an origin-less Electron-Node client, `host/session-status` reports `running: true` on prompt and `running: false` on cancel, and `session/title` arrives twice (fallback then LLM provider) with the latest winning.

The notifier itself was then run as shipped — `lib/notifications.js` inside a real Electron main process — against a stub speaking the verified envelope. It announced the approval, the plan review, and the completion; it stayed silent for a replayed `approval/requested` and for a `running: false` with no preceding `running: true`; and the macOS Dock badge read `3` while the window was minimized and cleared when it was focused.

Windows tray residency, the close dialog, and toast delivery are structurally complete and unverified on hardware: they need a real Windows machine, like every other Windows behavior this client ships.
