# Agent Note: One Host serving several members

Status: implemented

English | [中文](2026-10-05-console-member-peers.zh.md)

Related: [Remote duplex stream](2026-09-19-remote-duplex-stream.md) (partially superseded — "This Host has exactly one Peer" and "The operator is the only Peer" describe a Host with no Peer admitter installed; this note adds the admitter, the lookup by id, and the Peer open and close events that note reserved for the first consumer needing a second Peer).

## Problem

The fork's server console serves several members, each signed in through the customer's own system, from one Host process. Upstream `dsh-client-connection` has exactly one Peer, the operator. `connection.admit()` answers every trusted, authenticated request with it; the `/api` interceptor and dedicated RPC channels bind it when they are registered; and exact Fetch routes and `bridge()` receive no Peer at all. A Remote method therefore cannot tell which member called it, and a plugin cannot influence WebSocket admission or label a unary call: the `connection/request` waterfall runs after admission and cannot change the Peer, and the upgrade route belongs to the Gateway.

The duplex-stream note reserves three extension points for the first consumer that needs a second Peer: an admitter in `admit`, lookup of a Peer by id, and Peer open and close events, all inside `dsh-client-connection`. The console is that consumer.

Knowing the caller is not enough. The console must check that every session id a member's call names belongs to that member, filter results and stream items, and refuse whole classes of methods. Upstream's Gateway dispatches each Remote method straight from its carrier, and no plugin can act between the carrier and the method. The duplex-stream note assigns access control to `vouch` and a `remote/invoke` waterfall, and the base release implements neither.

Exact Fetch routes and dedicated RPC channels do not pass through the Gateway, so a hook around Remote calls never sees them. `/api/file` is such a route and reads any file the Host can read; `/api/session/uploadFileBinary` names its session in the query string. Routes registered directly on the webserver pass through no Connection hook, and the webserver lists none of them.

This record covers Connection's member Peers and the Gateway's socket events, carried as the fork core patch `connection-member-peers`; the Gateway's `remote/invoke` waterfall, carried as `remote-invoke-guard`; and Connection's `connection/fetch` waterfall with the webserver's route listing, carried as `connection-fetch-guard`.

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

### Remote calls pass through `remote/invoke`

The Gateway runs the `remote/invoke` waterfall around every Remote method call, whether it arrives through `invoke()`, `stream()`, `wireStream.open()`, the `/api` RPC carrier, or the WebSocket mux. The name is the one the duplex-stream note reserves for access control, so an upstream declaration with a different signature fails to compile against this one and forces the retirement decision.

The Gateway resolves the descriptor first and hands listeners a `RemoteInvokeCall`: the endpoint, the entry mode, the calling Peer, the descriptor's receiver selection (`invocation` and `scope`) and parameter descriptors, and the wire `args`. A listener therefore knows which wire fields carry lookup or Context identities without reading schemas. `next()` performs the upstream dispatch: exact-argument checks, receiver and lookup resolution, and the method call, against the descriptor the listener saw, which is not resolved again, so a definition replaced while a listener awaits cannot change which parameters were checked. Failures occur in upstream order: endpoint and descriptor failures precede the waterfall, and argument, codec, lookup, and mode failures occur inside `next()`.

A listener refuses a call by throwing a `RemoteError`, and `gateway/forbidden` is the Gateway code for an access refusal. A refusal skips `next()`; the repository rule that waterfall listeners call `next()` governs delegation, and refusing, or answering in the method's place, is a decision the listener owns. Arguments a listener assigns to `call.args` pass the same validation as the Client's, because `next()` reads the field when it runs. A rewritten unary value goes through the `/api` encoder like a method result, and the Gateway validates neither against the result codec. An outcome of the other mode fails the call with `gateway/result-invalid`.

Listeners share one `next()`, which runs the next listener that has not yet run, so a listener's refusal or check holds only while every listener before it calls `next()` once, and it sees `call.args` before listeners after it replace them ([Gateway README](../../../../packages/api/gateway/README.md#host-service-typertgatewayservice-ctx-key-typertgateway)). A multi-member console composition therefore keeps all its rules in one `remote/invoke` listener and registers no other.

`next()` starts dispatch synchronously, and validation and the method call continue in that async context, so a listener that calls `next()` inside `AsyncLocalStorage.run()` makes the caller visible to whatever the method reads. A stream method's body runs when the carrier pulls items, after the waterfall has returned, so a listener that needs the context there re-enters it around each pull of the source it returns.

`claimedEndpoints()` lists the method endpoints the `/api` carrier claims, the live strict definitions and SRC markers, so a gate test can require a classification for every endpoint the Gateway serves. The Gateway-owned `$events` stream and `$events/result` stay outside the waterfall.

### Fetch routes and channels pass through `connection/fetch`

Connection runs the `connection/fetch` waterfall in front of every exact Fetch route and every channel registered with `rpc.handle`, and hands listeners a `ConnectionFetchCall`: the kind, the registered path, the method, the Fetch request, and the admitted Peer, which is the operator when a shell-owned carrier names none. `path` is the registration's own key, so a route table keys on the strings `fetch.list()` and `rpc.channels()` return. `/api` requests that the RPC interceptor dispatches stay with `remote/invoke`, so a request on `/api` meets at most one of the two waterfalls. A listener refuses by returning its own Response without calling `next()`.

The waterfall runs after admission and after the bridge has buffered or started streaming the body, because a listener's input is the Fetch `Request` the bridge builds; a body over the buffered cap is answered 413 before any listener runs. A listener reads the body only through `request.clone()`, so the route still receives it.

Listeners share one `next()` here as well ([Connection README](../../../../packages/client/connection/README.md#browser-authentication-and-request-trust)), so the console registers a single `connection/fetch` listener. A listener that calls `next()` and then refuses or throws leaves a route Response nobody reads, and an unread streaming body keeps its producer and any file it reads open: an unread `/api/session.export` ZIP holds the stored attachment it is reading until the body is cancelled. Connection therefore cancels the body of every Response the route or channel produced for a `next()` called before the waterfall ended that the caller does not receive, unless the caller's Response carries that body. When the waterfall's result has an unlocked body, the cancel waits until the caller has read that body to the end, cancelled it, or reading it failed, because the body a listener returns may read a route body only as the caller reads it; Connection observes this by handing the caller a new Response over a body that relays the listener's. A `next()` that reaches the route or channel after the waterfall ended would produce a Response that no cancel covers, so it dispatches nothing and rejects. An exact route is looked up again when `next()` dispatches, so a route whose plugin unloaded while a listener waited does not run and `next()` resolves to 404. A listener's throw rejects the dispatch the way a route's throw does, and the HTTP carrier answers 400.

`webServer.routes()` lists the named routes, upgrade routes, and the claimed fallback seat in effect. Routes registered directly on the webserver pass through no Connection hook; the list also holds the `/api` prefix and the channel prefixes that Connection registers, which do. The console's gate test reads the list, so a route an upstream sync adds fails the gate until it is classified.

### Without an admitter

No admitter is installed by default and `requireAdmitter` defaults to `false`; then every path behaves as upstream: `admit` answers with the operator, `requestRejection` with the Host/Origin and authentication verdict, and every handler receives the operator. The desktop composition runs in this state. `peer-admission.host.spec.ts` asserts the operator on all four paths with no admitter, and `socket-events.host.spec.ts` asserts the operator on the socket events. With no `remote/invoke` listener, `remote-invoke.host.spec.ts` asserts unchanged results and failures through `invoke()`, `stream()`, `wireStream.open()`, `/api`, and the WebSocket, and the two carriers that read a stream with `for await`, the WebSocket mux and the webworker tunnel, cannot tell the Gateway's stream from upstream's. Three differences remain. On a Host without Connection, `invoke()`, `stream()`, and a `wireStream.open()` call that names no Peer create the Gateway-owned operator Peer before argument validation instead of after it. A caller that drives the iterator of `stream()` or `wireStream.open()` itself sees that `return()` before the first `next()` releases the uplink and opens and returns the method's iterator, where upstream does neither, that this `return()` rejects when the iterator factory or the iterator's `return()` throws, and that the iterable is not an `AsyncGenerator`, with no `throw()` or `Symbol.asyncDispose` and a different `Symbol.toStringTag`. A Cordis `internal/dispatch` listener sees every `remote/invoke` dispatch, with the call's Peer and unvalidated arguments. With no `connection/fetch` listener, each request reaches its route or channel and the caller receives the route's own Response, and the existing Connection specs pass unchanged; a route that throws synchronously makes the shared handler's `fetch` return a rejected promise instead of throwing, and an `internal/dispatch` listener receives the arguments of each `connection/fetch` dispatch, including the internal `next`; calling that `next` synchronously skips every `connection/fetch` listener, which only in-process code can do.

### Retirement

Upstream `dsh-client-connection` implementing multi-Peer admission, lookup by id, and Peer open and close events retires this patch; the fork then moves to the upstream form. The check is `git grep -n "peer-opened\|admitter\|peers\." <tag> -- packages/client/connection/src`.

Upstream's Gateway implementing `remote/invoke`, or an equivalent hook around Remote calls, retires `remote-invoke-guard`, and the console's method table moves to that hook. The check is `git grep -n "'remote/invoke'" <tag> -- packages/api/gateway/src`.

Upstream giving exact Fetch routes and dedicated channels a per-caller hook, or limiting what `/api/file` reads, retires the Connection part of `connection-fetch-guard`; an upstream listing of webserver registrations retires its webserver part. The checks are `git grep -n "'connection/fetch'" <tag> -- packages/client/connection/src` and `git grep -n "routes(" <tag> -- packages/host/webserver/src`.

## Alternatives considered

**One Peer per WebSocket.** A Peer would then follow one connection's lifetime, but unary HTTP calls have no socket, so they would have no Peer; socket presence is served by the socket events instead.

**Identity on the Peer.** A `principal` field on `PeerScope` would put member identity into Connection, the Gateway, and every `invocation.peer` reader, where it can reach logs and model requests; it also contradicts the upstream rule that the Peer carries no access model. A plugin-owned mapping keeps the identity in one package.

**An asynchronous admitter.** It would turn `admit()` into a promise, change the upgrade route and every `requestRejection` caller, and break the re-admission that waterfall listeners rely on. Header verification needs no I/O.

**Falling back to the operator when the admitter does not recognize a request.** A request carrying a valid browser cookie but no member assertion would then act with the operator's full Host authority. Default deny keeps the cookie from being sufficient.

**Leaving `requestRejection` on the Host/Origin and cookie checks.** Routes that use it as their only gate would admit a cookie holder that is not an admitted member while `admit()` refuses the same request.

**Admission in a plugin.** The `connection/request` waterfall runs after admission and cannot replace the Peer, the WebSocket upgrade route is owned by the Gateway, and upstream binds unary handlers to the operator at registration, so no plugin-level extension point can attach a member to a call.

**Ownership checks inside each business package.** Every package that owns Remote methods would need its own check, and a package a sync adds would stay unguarded until patched. One waterfall at the Gateway covers every method, and a gate over `claimedEndpoints()` catches an unclassified endpoint.

**Wrapping Connection's `/api` handler.** It covers only unary HTTP calls; WebSocket streams and in-process calls bypass it, and it sees the payload before descriptor resolution, so it cannot tell lookup fields from JSON fields.

**Resolving the descriptor again inside `next()`.** A definition withdrawn or replaced while a listener awaits would be validated against parameters the listener never inspected.

**Running `connection/fetch` before the bridge.** The listener would see the node:http request rather than the Fetch `Request` the route receives, and a listener that inspects the body would have to read it before the request-size cap applies.

**Leaving discarded route Responses unread.** The bridge only writes the Response it receives, so a body a listener discarded would keep its producer and open files until garbage collection.

**Cancelling discarded route bodies when the waterfall ends.** A listener that relays the route body through `ReadableStream.from()`, an async generator, or a stream that takes its reader in `pull()` reads the route body only once the caller reads; the route body is still unlocked when the waterfall ends, so cancelling it then hands the caller an empty 200.

**Cancelling when the HTTP bridge has written the body.** In-process carriers call the shared handler directly and never pass through the bridge, so route bodies they do not receive would stay open.

**Validating rewritten results against the result codec.** The Gateway validates no method result; validating only rewritten ones would make a rewritten call and an untouched call answer differently for the same value.

## Consequences

- **Bought**: with an admitter installed, every RPC, logical stream, and exact Fetch route knows which member Peer called it; routes that gate on `requestRejection` refuse non-members; the admitter's plugin learns member presence from four events. A composition's only `remote/invoke` listener can decide per endpoint who may call, which identities the arguments may name, and what a result or stream item may carry, and argument replacements reach a method only through the normal validation.
- **Core footprint**: Connection's `rpc.ts`, `rpc-host.ts`, `index.ts`, `http-bridge.ts`, and `operator-peer.ts`, the Gateway's `index.ts`, `stream-server.ts`, `types.ts`, and `remote-error-codes.ts`, and the webserver's `index.ts` differ from upstream. The Gateway's `index.ts` changes often upstream, so rolling syncs resolve conflicts there. The patch also reaches the desktop line, where it stays inert.
- **With `requireAdmitter: false`, removing the admitter reopens operator admission** for every authenticated browser; a deployment that depends on member admission sets `requireAdmitter: true`, and its admitter plugin refuses to start when `peers.requireAdmitter` is false.
- **`requireAdmitter: true` without an admitter plugin refuses every request** that passes Connection's own checks, until an admitter is installed.
- **Member Peers are not reclaimed by Connection**: a Peer that is never disposed lives until Connection unloads, so the admitter's plugin owns idle closing.
- **`requestRejection` runs the admitter** on each call once one is installed, including its error line for an unrecognized request.
- **A single `connection/fetch` listener decides every exact route and channel**: the console's route table can limit `/api/file` to a member's roots and uploads to the member's sessions, and refuse routes and channels it does not list.
- **Routes registered directly on the webserver stay unhooked**: `routes()` lets a gate test list them, and each still needs its own check.
- **`remote/invoke` also sees the Host's own in-process calls**, which carry the operator Peer; a listener that restricts members lets operator calls through.
- **When a stream call answers with a stream, its listeners return every stream they discard**: calling `return()` on a source's iterator releases the call's uplink and opens and returns the method's iterator, or returns the one already open when items were pulled, after any pending `next()` on it settles. The Gateway returns the streams the call's `next()` opened, or is opening, only when a listener throws or returns a value; the caller then receives the failure at once, while the Gateway aborts the method's `signal`, settles with a failure that it handles each `next()` on those streams still waiting on the method, and returns them in the background, so a stream method must end when its `signal` aborts. A `next()` that the method's own failure ends before that release belongs to the listener, and discarding it exits a host a `dsh` profile launched, so a listener must not discard a `next()` on those streams. A `next()` called after the Gateway received the waterfall's outcome rejects without running the method; one that an async listener queued in a microtask before returning or throwing still runs it. When the outcome is a stream, which may wrap them, it returns none, so a listener that catches a later listener's failure and calls `next()` again leaves the first stream open unless a listener returned it.
