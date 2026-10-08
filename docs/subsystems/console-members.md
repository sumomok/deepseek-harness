# Console Members

English | [中文](console-members.zh.md)

`ctx.consoleMembers` is the console member directory. When one console process serves several signed-in members, every plugin that acts for one of them — a webServer route answering for the member behind a request, a Remote method answering for its caller, a tool spending a Session owner's data, a credential resolver that holds one token slot per member — needs the same answer to which member it acts for, and the directory is the one place that answer comes from. This package declares the key, and its plugin row checks its configuration and keeps the root registry but does not provide the key yet, so an `inject: ['consoleMembers']` never resolves and the injecting plugin does not start. The [package README](../../packages/experimental/console-members/README.md) owns the type declarations and the limitations, and the generated section below holds every method's contract; this page records the three decisions a consumer cannot read off a signature.

Source: [`packages/experimental/console-members/src/types.ts`](../../packages/experimental/console-members/src/types.ts).

## A request's member has one source

Every per-member consumer obtains the member of a browser request through `principalOfRequest`, so two routes, or a route and a credential resolver, cannot name different members for one request. A credential resolver that holds one slot per member must answer its own `principalOfRequest` by delegating to this method ([biz-backend](../../packages/experimental/biz-backend/README.md#whom-a-read-is-for)), and a route that read an identity header or called `connection.admit` itself would be a second source. The method can run the `/api` route's admission itself because `admit()` is synchronous and gives one result for one set of request headers, so no route has to be handed the Peer.

## A child Session follows its parent, not its own cwd

A subagent or fork can run in a working directory outside its parent's roots, so attributing it by its own cwd would leave it with no member or give it to whoever registered that directory. The directory attributes a child through `parentSession`, which only the Host writes, and reads the child's cwd only for a contradiction: a cwd under another member's root, or under a root registered to no one, makes the answer no member rather than either candidate. Inheritance happens synchronously on `session/created`, so a child's first frame is already attributed.

## The directory is not a path to customer tokens

Any plugin in the process can inject `ctx.consoleMembers`, so the directory hands none of them a customer token: the token holder attaches a read-only reader, no method returns the reader or a token, and the directory holds one reader at a time, so while the holder's reader is attached no other plugin can attach one. When the holder detaches its reader — its plugin restarting — every member's token counts as dropped and a new reader may attach; a reader another plugin attaches in that gap can supply only tokens that plugin already has, and reads none of the holder's. Any plugin holding the directory can open any member's store under any unit name, so per-member storage holds non-secret data only, and a member's directory id does not contain the principal key, so a storage path does not carry the member's `login_uid`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconsolemembers--consolememberdirectory"></a>

### `ctx.consoleMembers` — `ConsoleMemberDirectory`

The console member directory, `ctx.consoleMembers`.

Every method is synchronous; a MemberStore it returns reads and writes asynchronously. No method returns, enumerates, or exposes a customer token or the attached CustomerCredentialReader.

```ts cordis-catalog
/**
 * The member one browser request was admitted as, for a webServer route.
 *
 * Admits the request through `connection.admit(req)`, the check the `/api`
 * route applies, and looks up the member of the admitted Peer. This is the
 * only way a fork webServer route obtains the member of a request: such a
 * route reads no identity header and calls no `connection.admit` of its own.
 * @param req - the request the route is answering.
 * @returns that member's key, or `undefined` when admission refuses the request or the admitted Peer belongs to no member.
 */
principalOfRequest(req: IncomingMessage): PrincipalKey | undefined

/**
 * The member a Remote method's caller acts for.
 * @param peer - the caller's Peer, `this.ctx.invocation.peer` inside a Remote method.
 * @returns that member's key, or `undefined` for the operator Peer and for a Peer this directory did not open for a member.
 */
principalOfCaller(peer: PeerScope): PrincipalKey | undefined

/**
 * The member one Session belongs to.
 *
 * A Session without `parentSession` belongs to the member whose registered
 * root contains its `header.cwd`; a cwd under a root registered to no one, or
 * under no registered root, belongs to no member. A Session with
 * `parentSession` belongs to whoever its parent belongs to, followed up to the
 * topmost Session; when any Session on that chain is unknown or belongs to no
 * member, the answer is `undefined`. A child Session whose own `header.cwd`
 * lies under a root registered to another member or to no one answers
 * `undefined` and logs one warning that carries no principal key; a child
 * cwd under no registered root is not a conflict and leaves the parent-chain
 * answer in force. A child Session takes its parent's member synchronously
 * on `session/created`, and a Session not loaded since startup is resolved
 * through its parent chain. The Host alone writes `parentSession`, at fork
 * and at subagent creation; no RPC caller can set it.
 * @param sessionId - the Session to look up.
 * @returns that member's key, or `undefined` when the Session is unknown or belongs to no member.
 */
principalOfSession(sessionId: SessionId): PrincipalKey | undefined

/**
 * The member's default root, `<membersRoot>/<directory id>`. The member's
 * default workspace is its `workspace` subdirectory. The directory id does
 * not contain the principal key.
 * @param principal - the member.
 * @returns the absolute path of that member's default root.
 */
memberRoot(principal: PrincipalKey): string

/**
 * Every root registered to the member: the default root plus each root a
 * migration seed registers to them.
 * @param principal - the member.
 * @returns those roots' absolute paths.
 */
rootsOf(principal: PrincipalKey): readonly string[]

/**
 * The members that currently have an open Peer.
 * @returns their keys.
 */
principals(): readonly PrincipalKey[]

/**
 * Observe members opening and closing Peers: `opened` when a member's Peer
 * opens and `closed` when it closes, the changes {@link ConsoleMemberDirectory.principals}
 * reports.
 * @param listener - called with the member and the kind of change.
 * @returns the disposer that stops the notifications.
 */
onChange(listener: (event: { principal: PrincipalKey; kind: 'opened' | 'closed' }) => void): () => void

/**
 * Per-member storage for one caller-named unit, kept at
 * `dshHomePath('console-members', <directory id>, '<unit>.json')`. It holds
 * non-secret data only.
 * @param principal - the member the data belongs to.
 * @param unit - the caller's own name for its data, for example `'server-sidebar'`.
 * @returns the store for that member and unit.
 */
memberStore(principal: PrincipalKey, unit: string): MemberStore

/**
 * Attach the reader of members' customer tokens. The directory holds one
 * reader at a time: attaching while a reader is attached throws, and once
 * the returned disposer has run a new reader may be attached, as the token
 * holder's plugin does when it restarts. Running the disposer counts as
 * every member's token being dropped: the directory stops reading the
 * reader, and whatever was derived from those tokens is discarded; the
 * reader emits no `dropped` for it.
 * @param reader - the read-only customer-token reader.
 * @returns the disposer that detaches the reader.
 * @throws Error when a reader is already attached.
 */
attachCustomerCredentials(reader: CustomerCredentialReader): () => void
```

Types: [SessionId](core.md)

Source: [`packages/experimental/console-members/src/types.ts`](../../packages/experimental/console-members/src/types.ts)
<!-- END GENERATED cordis-surface -->
