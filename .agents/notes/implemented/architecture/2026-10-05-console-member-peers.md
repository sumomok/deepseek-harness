# Agent Note: One Host serving several members

Status: implemented

English | [中文](2026-10-05-console-member-peers.zh.md)

Related: [Peer principals and method-level Remote access control](2026-10-12-peer-principal-and-remote-access.md) partially supersedes this note. Member identity on the Peer (`principal`), `connection.createPeer()`, method-level access through `remoteAccess.decide()`, filtered event broadcasts, and the default 403 on exact Fetch routes are upstream's; this note records only the three narrow fork patches that remain on top of them. [Remote duplex stream](2026-09-19-remote-duplex-stream.md) describes the Peer scope both notes build on.

## Problem

The fork's server console serves several members, each signed in through the customer's own system, from one Host process. Upstream gives a Peer a principal, lets a business package declare a non-owner principal kind and register a remote-access policy for it, and checks every Remote call, list result, and broadcast against that policy. Four gaps remain for the console.

Admission: `connection.admit()` answers every trusted request with a valid browser cookie with the owner `browserPeer`, and every API Cookie that `/connect` exchanged for the launch token with an owner API Peer. No seam maps a signed-in member's request to a member Peer, so a member reaches the Host either as the owner or not at all. The console's login proxy hands the launch token to every member who passes its login gate, so the `/connect` exchange must not mint owner authority either.

Approvals: upstream's security invariant "Non-owners answer no waterfall" withholds every waterfall frame, such as a tool approval or a user question, from a non-owner `$events` stream and refuses its `$events/result`. A member cannot answer the approvals and questions of its own Sessions.

Exact Fetch routes: the shared Fetch handler answers 403 to every non-owner Peer; the upstream note marks this as temporary until each route declares its own access rule. A member therefore cannot upload a file into its Session, export its Session log, or see a file preview.

Presence: the console closes an idle member Peer once its member has no open Remote socket, and upstream announces no socket opening or closing.

## Decision

The fork keeps three patches, each a seam upstream does not provide, and uses upstream's mechanisms for everything else. The console's member principal kind, its policy, and its admitter live in the console plugin, not in core.

### Admission seam and socket events (`connection-member-peers`)

`ctx.connection.peers` holds `admitWith(admitter)` and `requireAdmitter`. `admitWith` installs the sole synchronous `PeerAdmitter`; a second installation throws, and the registration is an effect of the installing fiber. `admit(request)` runs Connection's own trust check, then the browser cookie or API Cookie authentication; a request that fails either is refused as upstream and the admitter is not called. With an admitter installed, every authenticated request, including the API Cookie that `/connect` issued, speaks for the Peer the admitter returns, normally one created by `createPeer({ principal })`. The admitter's 401 or 403 is the refusal; an `undefined` answer or a disposed Peer is refused with 401 and logged without header values. An operator who keeps owner access receives an owner Peer from the admitter; no request reaches owner authority without it.

The Config field `requireAdmitter` (default `false`) refuses every authenticated request with 401 while no admitter is installed, which covers the window before the admitter's plugin applies and while it restarts. `peers.requireAdmitter` reports the resolved value, so the admitter's plugin can refuse to start without it. `requestRejection()` answers 403 for an admitted non-owner Peer, because the routes it gates, such as open-in-app and the inspector's bare routes, run no other access check.

The Gateway's Remote stream server announces `remote-stream/socket-opened(peer, socketId)` after a socket is bound to its live Peer and `remote-stream/socket-closed(peer, socketId)` after the socket has closed and its streams have settled. `RemoteSocketId` is a branded identity from a process-wide counter that never crosses the wire. A throwing listener is logged and does not reach the socket.

Upstream provides no equivalent: its `admit()` maps every authenticated browser and every `/connect` caller to an owner Peer, the `connection/request` waterfall runs after admission and cannot change the Peer, and the WebSocket upgrade belongs to the Gateway, so no plugin-level extension point attaches a member to a request.

### Member waterfalls (`remote-event-delivery-filter`)

An owner `$events` stream receives every waterfall, as upstream. A non-owner stream with `interactions: 'answer'` receives a waterfall when remote access allows the action `event:<name>` on the resource the waterfall's `agentId` names, of the kind the `agent` Host Context adapter declares; without that declaration no non-owner receives one. The Gateway decides at a waterfall's first delivery and at the replay of pending waterfalls to a stream that connects. A `$events/result` from a non-owner settles only a waterfall delivered to that stream. When remote access no longer allows the stream to answer it, the Gateway throws `gateway/interactions-forbidden` and the waterfall stays pending for the streams still allowed. A policy change re-delivers nothing to streams already open; a member receives newly allowed pending waterfalls when it reconnects. `hasLiveClient()` still counts only owner streams.

Upstream provides no equivalent: non-owner waterfall delivery and answers are refused unconditionally, and no policy decides them.

### Exact routes with their own access rule (`connection-fetch-guard`)

`ConnectionFetchRoute.serveNonOwner(request, peer)` is a route's own access rule. The shared Fetch handler hands it every request of a live non-owner Peer in place of `fetch`, answers 401 when that Peer is disposed, and keeps upstream's 403 for a route that declares none. A rule asks `remoteAccess.decide()` with the route path as the action and answers 403 when refused or when the Host has no remote access.

Three routes declare one. The raw upload (`/api/session/uploadFileBinary`) decides the `sessionId` it names before reading the body. The Session-log export decides the requested Session and, with descendants, every descendant it would include. `/api/file` reads only a file inside the workspace of the Session named in `sessionId`: remote access must allow `/api/file` on that Session; the workspace is the Session header's `cwd` from the live Session or `sessionPersistence.stat`; the workspace and the requested path are resolved to real paths through `ctx.fs.resolve`, `ctx.fs.contains` must place the file inside, and the read uses that resolved target. Chat and the document preview name the viewed Session in their file URLs.

The remaining exact routes keep 403 for members. `/api/present.open` and `/api/changes.open` start the Host's native opener on the server machine with POST and list the Host's applications with GET; `/api/present.host` reports the Host's desktop metadata; `/api/changes.summary` and `/api/changes.diff` read Session-scoped change records and declare no rule; and the inspector's bootstrap serves Host internals.

Upstream provides no equivalent: the shared Fetch handler refuses every non-owner Peer on every exact route, and no route has a way to declare its own rule. `serveNonOwner` is the form the upstream note anticipates, one rule per route, so each route's rule retires with upstream's.

`webServer.routes()` lists the routes, upgrade routes, and claimed fallback seat in effect, so a composition's gate test can classify every route registered outside Connection's admission.

### Console obligations

The console's plugin declares its member principal kind through `PrincipalMap` declaration merging, registers its remote-access policy, installs the admitter that maps a signed-in member to a `createPeer({ principal })` Peer and the operator to an owner Peer, sets `requireAdmitter: true`, and closes idle member Peers from the socket events. Its policy lists, on each member's Sessions, the Remote endpoints, the `event:<name>` actions of the approvals and questions members answer, and the route paths `/api/file`, the upload path, and the export path. Reference probing through `probeTargets` needs a `global` role. An earlier fork form of these patches, with member Peers kept inside Connection, a `remote/invoke` waterfall, a `connection/fetch` waterfall, and a delivery filter, is retired; a console built on it must migrate to the form above.

### Retirement

`connection-member-peers` retires when upstream Connection offers an admission seam: `git grep -n "admitWith\|PeerAdmitter" <tag> -- packages/client/connection/src` returns hits upstream wrote. The socket events retire when upstream announces Remote socket presence.

`remote-event-delivery-filter` retires when upstream lets a policy decide non-owner waterfalls: `git grep -n "answers: peer.principal.kind === 'owner'" <tag> -- packages/api/gateway/src` no longer finds the owner-only rule, or the remote-access README's limitation on non-owner waterfalls is gone.

`connection-fetch-guard` retires when upstream routes declare their own non-owner rule: `git grep -n "kind !== 'owner') return Promise.resolve(new Response('forbidden'" <tag> -- packages/client/connection/src/rpc-host.ts` no longer finds the blanket refusal. Its `routes()` part retires when `git grep -n "routes(" <tag> -- packages/host/webserver/src` finds an upstream listing.

## Alternatives considered

**Keeping the earlier fork mechanisms.** Member Peers inside Connection, a `remote/invoke` waterfall around every Remote call, a `connection/fetch` waterfall in front of every exact route and channel, and a Gateway delivery filter duplicated what upstream's principal and remote-access mechanism now covers, gave the Host two access models, and conflicted with every upstream sync of the Gateway and Connection.

**Admission in a plugin.** The `connection/request` waterfall runs after admission and cannot replace the Peer, and the upgrade route belongs to the Gateway, so a plugin cannot attach a member to a request without a seam in `admit()`.

**An asynchronous admitter.** It would make `admit()` a promise and change the upgrade route and every `requestRejection` caller; recognizing a member from a signed request header needs no I/O.

**Falling back to the owner when the admitter does not recognize a request.** A valid browser cookie alone would then reach full Host authority.

**Letting the `/connect` API Cookie bypass the admitter.** The console's login proxy hands the launch token to every member past its login gate, so that path would mint an owner Peer for any member.

**Lifting the waterfall block for every non-owner.** A member would receive and answer the approvals of every other member's Sessions; the policy decides per Session instead.

**Re-delivering pending waterfalls when a policy changes.** Remote access exposes no delivery-time notification for it, and a reconnect already receives every pending waterfall the policy now allows.

**One route-wide waterfall for exact routes.** Its listeners would share one `next()`, would have to cancel discarded route bodies, and would keep every route behind one fork hook; a per-route rule follows upstream's stated direction and retires route by route.

**Confining `/api/file` to the sandbox workspace root, the attachment store, or a lexical path prefix.** The sandbox root is a deployment default that belongs to no member, attachments already travel through the Gateway's Remote access check, and a lexical prefix check follows symbolic links out of the workspace.

**Opening `/api/present.open` and `/api/changes.open` to members.** They start the Host's native opener on the server machine, which a member must not trigger.

## Consequences

- **Bought**: a member reaches the Host only as the Peer the console's admitter returns; it answers the approvals and questions of the Sessions its policy grants; it uploads into, exports, and previews files of those Sessions; and the console learns member presence from socket events.
- **Core footprint**: Connection's `rpc.ts`, `rpc-host.ts`, and `index.ts`; the Gateway's `index.ts`, `stream-server.ts`, and `types.ts`; the routes of `dsh-client-file-upload`, `dsh-session-log-export`, and `dsh-api-session-controller`'s media references; `fileMediaUrl` and its Chat and document-preview callers; and the webserver's `routes()`. The patches stay inert on the desktop line, which installs no admitter and creates no non-owner Peer.
- **With `requireAdmitter: false`, removing the admitter reopens owner admission** for every authenticated browser; a member deployment sets it to `true`.
- **`requireAdmitter: true` without an admitter refuses every authenticated request** until one is installed.
- **Member Peers are not reclaimed by Connection**: the admitter's plugin owns idle closing.
- **A member's file read has a residual race**: replacing an already resolved directory inside the workspace with a symbolic link between the containment check and the open makes the read follow the link; exploiting it requires write access to the workspace.
- **An image URL built without a Session is refused for a member** and shows its alt text.
- **A member's approval waits while that member is offline**, as an owner's does upstream, until its Agent Context or signal ends it.
