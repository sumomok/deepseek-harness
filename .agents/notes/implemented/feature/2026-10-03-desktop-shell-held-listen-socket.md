# Agent Note: Desktop shell: the shell holds the served UI's loopback socket, so a crash rebind keeps the origin

Status: implemented

English | [中文](2026-10-03-desktop-shell-held-listen-socket.zh.md)

## Problem

An unexpected server exit moved the window to a new origin. The [stable-origin decision](2026-09-27-desktop-shell-stable-origin.md) kept one port across launches, but a crash rebind started the server on a port the system picks, and everything the web client keeps is per-origin localStorage: the open session (`dsh.sessions.current`, `packages/client/ui-workspace/src/client/navigation.ts`), the draft being typed (`dsh.conversation.<sessionId>`), shortcuts and layouts. The client puts nothing in the URL, so no reload argument can carry them, and an origin without a selected session reuses or creates a blank one. One macOS log showed two crash rebinds in a day, 52520 → 62913 → 63222.

The new port was the security response, not an accident. The `dsh-auth-*` cookie names its authority and is signed with a secret the Harness home keeps, so it stays valid for any later server on the same port. While no server runs, the window and the shell's own notification stream keep connecting to the port, so a local process that binds it can receive the cookie or answer the window: render a forged approval or settings form, or have the page run its script in that origin. Taking the same port again naively is worse than a new one: a script that ran there can register a service worker that takes the next `/?token=` navigation and a 30-day cookie with the whole agent API.

## Decision

### The shell holds the socket

At launch, after `choosePort` and before the first server starts, the shell binds `127.0.0.1:<port>` itself with `net._createServerHandle`, the bind Node's cluster primary uses, and keeps it until the process exits (`apps/desktop-shell/src/listen-socket.ts`). It never listens or accepts on it. A handle is accepted only when `getsockname` reports `127.0.0.1` and the asked port: libuv defers `EADDRINUSE` to the listen, and a child listening on such an unbound handle binds `0.0.0.0` on a port the system picks (observed on macOS). When the chosen port does not hold, a port the system picks is held instead and the launch starts on a new origin, as before.

Every server child is started with `--import lib/listen-handoff.mjs`, an IPC channel, and `DSH_DESKTOP_LISTEN_HANDOFF_PORT`. The preload (`src/listen-handoff.mts`) does nothing in a worker thread or without the variable, and otherwise:

- removes the variable, registers its `message` listener, and writes `dsh-desktop listen handoff: ready`; the shell sends the socket on that line, because a message that arrives before a listener exists is dropped (observed);
- closes the IPC channel as soon as the socket arrived, before any server code runs, so nothing the server runs can write into the shell's main process or inherit the channel; the shell never registers a `message` listener;
- replaces `net.Server.prototype.listen` so the first call for the handed port on `127.0.0.1` (positional, the form `@deepseek-ai/dsh-host-webserver` uses, or an options object) listens on the socket, and passes every other call through;
- after that listen, checks the server listens on `127.0.0.1` and the handed port and writes `dsh-desktop listen handoff: listening on 127.0.0.1:<port>` before the CLI's URL line, on the same stream;
- on any failure writes `dsh-desktop listen handoff failed: <reason>` and exits 1, including a second listen for the held port: its own copy of the socket is closed by then.

The shell (`startServer` in `src/server.ts`) accepts a URL line only after the `listening` line and on the held port. A failure line, a send error, an exit before the socket was taken, or a URL line without the `listening` line rejects with `ListenHandoffFailed`. The shell does not close the channel from its side: after a parent-side `disconnect()`, Node 24 never emits the child's `close`, so every exit would wait out the 2 s output-drain bound.

### The crash path on the held socket

From the moment the bind is held until the shell exits, a connection to `127.0.0.1:<port>` is accepted by the shell's current server child or waits in the socket's queue; no other process accepts it. It rests on one fact: the address stays bound by the shell, so another bind of it fails with `EADDRINUSE` while no child runs, and a wildcard bind on the same port receives none of the loopback connections (both observed on macOS from Node 24.15 and from a real Electron 43.4.0 main process). A second fact affects only what the user sees: the socket keeps listening after a child dies, so a request made meanwhile is answered by the next child (observed on macOS). On Windows libuv sets neither `SO_REUSEADDR` nor `SO_EXCLUSIVEADDRUSE`, so an ordinary bind fails the same way, while a process of the same user that sets `SO_REUSEADDR` can bind over the address, as it can over a running server's socket. On Linux, where a socket that sets `SO_REUSEADDR` (libuv sets it on every bind there) may bind an address no socket listens on, the first fact holds only from the first child's listen on; the app is packaged for macOS and Windows.

So an unexpected exit (`respondToCrash` in `src/server-lifecycle.ts`) stops the notification stream, keeps the remembered port, removes the cookies, and runs the ladder; a rebind (`rebindOnHeldSocket`) starts the next child on the same socket, and the window reloads into the same origin with the new launch token. The restart after a failed install uses the socket directly, since `choosePort`'s probe would find the shell's own bind and report the port taken. A whole-app relaunch releases the socket with the process; the next instance asks for the remembered port like any launch, while no window is open.

### Fallback

A start on the socket that fails with `ListenHandoffFailed`, or with `listen EADDRINUSE` (the preload did not take the call and the server's own bind met the shell's), closes the socket, logs `[desktop] listen handoff unavailable (<reason>); this run changes origin on every crash rebind`, and starts the server as the shell would without the socket at that point: the chosen port at launch, a port the system picks in a crash rebind (after forgetting the remembered port, before the socket is closed), the held port at a restart after a failed install. That run then behaves as before this decision. No bind held at launch leads to the same state.

### Rules that hold either way

- The notification stream stops at every unexpected exit, before the ladder (`stopNotifications`). Before this decision a stream that had been ready kept its in-memory cookie, reconnected to the dead port every few seconds, and minted another cookie from the old launch token, until a rebind replaced it, and never after the stop dialog was dismissed.
- Once the stopped-server dialog was dismissed, a reveal with no window open — the macOS Dock — shows the dialog again instead of a window that would wait on a stopped server.
- A profile change that restarts the web server's row makes it listen a second time; with a held socket the process then exits and the ladder rebinds on the same socket. A run in a scratch home with the built CLI did this when the `webserver` row's config changed, and did not for an unrelated row or for the row restated unchanged.

### Packaging and checks

electron-builder unpacks `lib/listen-handoff.mjs` to `app.asar.unpacked`, since the bundled Node cannot read the asar; it is an `.mjs` so it loads as ESM without a package.json above it, and `scripts/after-pack.cjs` fails the build without it. `scripts/staged-boot-gate.ts`'s `verifyHeldSocketBoot` boots the staged payload twice on one held socket through the shell's own `startServer`, so an upstream change to the web server's listen fails the build rather than degrading every installation. `scripts/listen-handoff-smoke.mjs`, run by `render-smoke`, repeats the handoff from Electron's main process. `tests/listen-handoff.spec.ts` runs both halves with real processes.

## Alternatives considered

**Carry localStorage to the new origin.** A prototype read the old origin and wrote the new one in-process through a `data:` document committed under each origin with `baseURLForDataURL`, with no request to either port. It loses on the security property: a process holding the old port can run its script in the abandoned origin — a manual reload, or the client HMR `EventSource` reconnecting and receiving a graph frame that imports a same-origin script — and write any key, which the carry then moves into the signed-in origin, again at every crash. It remains a candidate for the launch fallback only, where no window has been on the old origin in this run.

**A forwarder: the shell holds the stable port and forwards to a child's own port.** The hop to the child's port repeats the race, now with the stable port's cookie going to whoever takes the child's port, and every byte crosses Electron's main thread.

**Bind the port again after seeing the exit.** The kernel frees the port when the child dies, and the shell hears of it up to 2 s later; a process binding in a loop wins. It also still needs a handoff to give the socket to the next child.

**An inherited-socket listen option in `@deepseek-ai/dsh-host-webserver`.** It removes the preload's coupling, but it is an upstream change (config, startup flag, CLI argument, bundle patch) that the fork carries on every sync, while the preload does the same from the fork-owned shell and degrades with one log line.

**Start the rebind on the same port without holding it.** Unsafe for the service-worker reason in Problem.

## Consequences

A crash rebind keeps the origin, so the window comes back to the open session with the draft, including what was typed while no server ran; a whole-app relaunch keeps it when the port is still free. During the gap no other process can accept on the port, which is stronger than before, when the port was free from the moment the child died.

The cost is a preload coupled to the web server's `listen(port, '127.0.0.1')` call, one file outside the asar, and a server process that is started with an IPC channel for the first milliseconds of its life. A change in that call degrades a run to the earlier behavior with one log line, and the staged boot fails the build first. A profile change that restarts the web server's row now costs a server restart and a window reload, counted by the ladder as an unexpected exit. A launch whose remembered port is held elsewhere still starts on an empty origin. The Windows behavior of both facts, and the handoff from a packaged Windows build, are checked on a Windows machine before release; if the first fact does not hold there, this decision is replaced by the carry with a block on requests to the abandoned origin.
