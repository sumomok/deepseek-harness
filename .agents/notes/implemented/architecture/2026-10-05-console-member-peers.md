# Agent Note: One Host serving several members

Status: implemented

English | [中文](2026-10-05-console-member-peers.zh.md)

Related: [Remote duplex stream](2026-09-19-remote-duplex-stream.md) (partially superseded — "This Host has exactly one Peer" and "The operator is the only Peer" describe a Host with no Peer admitter installed; this note adds the admitter, the lookup by id, and the Peer open and close events that note reserved for the first consumer needing a second Peer).

## Problem

The fork's server console serves several members, each signed in through the customer's own system, from one Host process. Upstream `dsh-client-connection` has exactly one Peer, the operator. `connection.admit()` answers every trusted, authenticated request with it; the `/api` interceptor and dedicated RPC channels bind it when they are registered; and exact Fetch routes and `bridge()` receive no Peer at all. A Remote method therefore cannot tell which member called it, and a plugin cannot influence WebSocket admission or label a unary call: the `connection/request` waterfall runs after admission and cannot change the Peer, and the upgrade route belongs to the Gateway.

The duplex-stream note reserves three extension points for the first consumer that needs a second Peer: an admitter in `admit`, lookup of a Peer by id, and Peer open and close events, all inside `dsh-client-connection`. The console is that consumer. This record covers Connection's member Peers and the Gateway's socket events, carried as the fork core patch `connection-member-peers`.

## Decision

### One Peer per member

`ctx.connection.peers` holds member Peers. `open()` creates a `ConnectionPeer` scope under Connection's own plugin context with `createScope(connectionCtx, peer)`, the mechanism that also builds the operator; `OperatorPeer` is the `ConnectionPeer` constructed without a close callback. `get(id)` and `list()` return member Peers whose `dispose()` has not been called; neither ever returns the operator. A member Peer lives until its `dispose()` or until Connection unloads, which disposes every member Peer still open.

The unit is a member, not a socket. A unary HTTP request belongs to no WebSocket, so a Peer per socket would leave calls such as `session/prompt` with no Peer to speak for. Whether a member is online is answered by the socket events below, not by the Peer's lifetime.

### Admission and default deny

`peers.admitWith(admitter)` installs the sole `PeerAdmitter`; a second installation throws, and the registration is an effect of the installing fiber. `admit(request)` then decides in this order:

1. Connection's own Host/Origin checks and browser authentication run first; a refusal there returns 403 or 401 and the admitter is not called. An admitter can only narrow admission.
2. With no admitter, the request speaks for the operator, as upstream, unless Connection's Config sets `requireAdmitter`, which refuses it with 401 (see below).
3. With an admitter, a live Peer that `peers.open()` returned is admitted; 401 or 403 from the admitter is returned as the refusal; `undefined`, a released Peer, the operator, or any other object is refused with 401 and logged as one error line that carries no header values.

So once an admitter is installed, no HTTP request or WebSocket upgrade speaks for the operator: a browser cookie alone does not reach Host authority. `requestRejection(request)` is defined as the verdict of `admit(request)`, so routes that gate on it alone, such as the inspector and open-in-app routes, also refuse a cookie holder the admitter does not recognize. Disposing the admitter's registration restores admission without an admitter.

Default deny holds only while an admitter is installed, and two windows have none: between Connection's apply and the admitter plugin's apply, and while the admitter plugin restarts, because its disposer removes the admitter. Connection's Config field `requireAdmitter`, default `false`, closes both: when it is true, `admit` refuses with 401 a request that passes the Host/Origin checks and browser authentication while no admitter is installed, so `requestRejection` returns 401 for it as well; index authorization is unaffected. These refusals write no log line, because they are the expected answer during startup. The refusal is 401, so `ConnectionRequestRejection` has two statuses, 401 and 403. A composition that sets the field without an admitter plugin refuses every such request, which is the intended fail-closed result. `peers.requireAdmitter` exposes the resolved value; the admitter's plugin reads it at load and refuses to start when it is false, because a later configuration layer replaces the whole Connection row and can drop a field an earlier layer set.

The admitted Peer reaches every carrier: the `/api` route and dedicated channels pass `admission.peer` to `bridge(req, res, handler, maxBytes, peer)`; `ConnectionFetchHandler.fetch(request, peer?)` defaults to the operator when a shell-owned carrier names no Peer; `ConnectionFetchRoute.fetch(request, peer)` receives it; RPC channel handlers receive the Peer of each call; and the Gateway's upgrade route hands `admission.peer` to the mux. Each Peer parameter is the last parameter, so a route or handler that ignores it is a valid implementation, and a carrier that omits an optional one speaks for the operator.

### `admit()` stays synchronous

`admit()` returns a `PeerAdmission`, not a promise, and the admitter is synchronous. The `connection/request` waterfall signature carries no Peer; a waterfall listener or a fork route that needs the caller recovers it by calling `admit(req)` again on the same request. That only works if admission is synchronous and gives the same answer for the same headers, which the admitter contract requires. The upgrade route and `requestRejection` callers are synchronous too. Recognizing a member from a signed request header needs no I/O.

### Lifecycle events

Connection emits `connection/peer-opened(peer)` before `open()` returns and `connection/peer-closed(peer)` once, after the first `dispose()` call has quiesced the scope, however many `dispose()` calls race. The operator emits neither.

The Gateway's `RemoteStreamMuxServer` takes an optional socket observer, and the Gateway uses it to emit `remote-stream/socket-opened(peer, socketId)` after the socket is bound to its Peer and `remote-stream/socket-closed(peer, socketId)` after the socket has closed and its streams have finished. Disposing a Peer closes its sockets with 1001; the close request is synchronous but the closing handshake completes later, so `connection/peer-closed` normally precedes the matching `remote-stream/socket-closed`. `RemoteSocketId` is a branded identity minted from a process-wide counter: it names a socket only to in-process listeners and never crosses the wire. An upgrade whose Peer is already disposed is closed without either socket event.

The events exist for the plugin that installs the admitter: closing an idle Peer needs to know that its member has no open socket, and deciding whether the member who owns a pending approval is online needs socket presence. A throwing listener of any of the four events is logged; it neither fails `open()` or `dispose()` nor reaches the WebSocket server.

### The Peer carries no identity

A member Peer has only `id`, `ctx`, and `dispose()`, as the duplex-stream note states: the Peer carries no access model. Which member a Peer belongs to is recorded only by the plugin that installs the admitter. Connection never sees a member's principal key, so the key cannot enter Connection's logs or anything Connection hands to a model.

### Without an admitter

No admitter is installed by default and `requireAdmitter` defaults to `false`; then every path behaves as upstream: `admit` answers with the operator, `requestRejection` with the Host/Origin and authentication verdict, and every handler receives the operator. The desktop composition runs in this state. `peer-admission.host.spec.ts` asserts the operator on all four paths with no admitter, and `socket-events.host.spec.ts` asserts the operator on the socket events.

### Retirement

Upstream `dsh-client-connection` implementing multi-Peer admission, lookup by id, and Peer open and close events retires this patch; the fork then moves to the upstream form. The check is `git grep -n "peer-opened\|admitter\|peers\." <tag> -- packages/client/connection/src`.

## Alternatives considered

**One Peer per WebSocket.** A Peer would then follow one connection's lifetime, but unary HTTP calls have no socket, so they would have no Peer; socket presence is served by the socket events instead.

**Identity on the Peer.** A `principal` field on `PeerScope` would put member identity into Connection, the Gateway, and every `invocation.peer` reader, where it can reach logs and model requests; it also contradicts the upstream rule that the Peer carries no access model. A plugin-owned mapping keeps the identity in one package.

**An asynchronous admitter.** It would turn `admit()` into a promise, change the upgrade route and every `requestRejection` caller, and break the re-admission that waterfall listeners rely on. Header verification needs no I/O.

**Falling back to the operator when the admitter does not recognize a request.** A request carrying a valid browser cookie but no member assertion would then act with the operator's full Host authority. Default deny keeps the cookie from being sufficient.

**Leaving `requestRejection` on the Host/Origin and cookie checks.** Routes that use it as their only gate would admit a cookie holder that is not an admitted member while `admit()` refuses the same request.

**Admission in a plugin.** The `connection/request` waterfall runs after admission and cannot replace the Peer, the WebSocket upgrade route is owned by the Gateway, and upstream binds unary handlers to the operator at registration, so no plugin-level extension point can attach a member to a call.

## Consequences

- **Bought**: with an admitter installed, every RPC, logical stream, and exact Fetch route knows which member Peer called it; routes that gate on `requestRejection` refuse non-members; the admitter's plugin learns member presence from four events.
- **Core footprint**: Connection's `rpc.ts`, `rpc-host.ts`, `index.ts`, `http-bridge.ts`, and `operator-peer.ts`, and the Gateway's `index.ts` and `stream-server.ts`, differ from upstream. The Gateway's `index.ts` changes often upstream, so rolling syncs resolve conflicts there. The patch also reaches the desktop line, where it stays inert.
- **With `requireAdmitter: false`, removing the admitter reopens operator admission** for every authenticated browser; a deployment that depends on member admission sets `requireAdmitter: true`, and its admitter plugin refuses to start when `peers.requireAdmitter` is false.
- **`requireAdmitter: true` without an admitter plugin refuses every request** that passes Connection's own checks, until an admitter is installed.
- **Member Peers are not reclaimed by Connection**: a Peer that is never disposed lives until Connection unloads, so the admitter's plugin owns idle closing.
- **`requestRejection` runs the admitter** on each call once one is installed, including its error line for an unrecognized request.
