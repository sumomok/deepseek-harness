---
description: "The console member directory, ctx.consoleMembers: which signed-in member a browser request, a Remote caller, or a Session belongs to, each member's registered roots, and per-member non-secret storage; the type declarations for console-line plugins that act for one member, and the plugin row that provides the directory and admits each request as the member its signed assertion names."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-members

English | [中文](README.zh.md)

## Summary

Type a console-line plugin against `ctx.consoleMembers`: ask which signed-in member a browser request, a Remote caller, or a Session belongs to, list that member's registered roots, and keep non-secret data per member. The `/types` entry exports the directory's types and declares the context key. The package root is the plugin row: at load it checks its configuration and opens the root registry, then provides `ctx.consoleMembers` and installs Connection's Peer admitter, which admits each request as the member its signed assertion names. The `/credential-access` entry reads members' customer tokens and the registered members. In this build `principalOfSession` throws.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Import these types in a Host plugin that acts for one console member: a webServer route that answers for the member behind a request, a Remote method that answers for its caller, or a tool that spends a Session owner's data. Declare the package as a peer dependency when your published declarations name its types, and as a development dependency when only your own source uses them.

### Entry point

Import the types from `@deepseek-ai/dsh-experimental-console-members/types`. Importing anything from that entry, including `import type {}`, loads the `Context` declaration, so `ctx.consoleMembers` and `ctx.get('consoleMembers')` type-check:

```ts
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members/types'

declare const ctx: Context
declare const req: IncomingMessage

const member: PrincipalKey | undefined = ctx.consoleMembers.principalOfRequest(req)
```

The `/types` entry imports no Host entry point, so Host plugins and Client programs both import it. The package root re-exports the same types, but it is the plugin and imports Host entry points; a Client program never imports the package root.

`principalOfRequest` is the only way a fork webServer route obtains a request's member: the route reads no identity header and calls no `connection.admit` of its own. `principalOfSession` follows a child Session's parent chain to the topmost Session, and `attachCustomerCredentials` holds one customer-token reader at a time, which no method of `ctx.consoleMembers` returns. The [subsystem page](../../../docs/subsystems/console-members.md) explains these three rules; [`src/types.ts`](src/types.ts) states every method's contract.

`PrincipalKey` is `Branded<'PrincipalKey'>` from `@deepseek-ai/dsh-brand`, and its value is the member's `login_uid`. A consumer treats it as opaque, and it reaches no model request, log line, or upload.

### Customer tokens and registered members

The token holder, auth-gate with `shareWithMemberDirectory`, calls `ctx.consoleMembers.attachCustomerCredentials(reader)` inside its own `ctx.effect` and runs the returned disposer from that effect's cleanup. The row holds one reader at a time: attaching while a reader is attached throws, and once the disposer has run another reader may attach. Running the disposer counts as every member's token being dropped, and the reader reports no `dropped` for it. The disposer acts once: it stops reading and forwarding the reader, calls every `onDetached` listener synchronously, and then frees the slot, so a reader attached from inside an `onDetached` listener is refused. A repeated or late call of one disposer notifies nobody and leaves a reader attached since in place. A change the reader reports while its `onChange` is subscribing is not forwarded, because the reader is attached only once `onChange` returns.

The console line's credential source reads the tokens through `@deepseek-ai/dsh-experimental-console-members/credential-access`. Its source imports Host modules, so only Host plugins import it; Client programs import `/types`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { customerCredentialAccess, memberRegistryAccess } from '@deepseek-ai/dsh-experimental-console-members/credential-access'

declare const ctx: Context

const tokens = customerCredentialAccess(ctx.consoleMembers)
const registry = memberRegistryAccess(ctx.consoleMembers)
ctx.effect(() => tokens.onDetached(() => { /* discard what was derived from every token */ }), 'credential source: reader detached')
ctx.effect(() => registry.onAdded((member) => { void member }), 'credential source: member added')
const everyMember = registry.principals()
```

`read(principal)` answers the attached reader's token, or `undefined` when no reader is attached or its disposer has started. `onChange` forwards the attached reader's `set` and `dropped`, and stays registered across detach and attach; once a reader's disposer has started, no listener receives a change from that reader, including a change being forwarded at that moment. An `onDetached` listener must not read tokens: the holder may have revoked its reader before running the disposer, and `read` already answers `undefined`. `principals()` lists every member admitted at least once, including members with no open Peer; a principal that only a `rootSeeds` entry names joins at its first admission. `onAdded` reports that first admission, synchronously and before the member's Peer opens, and never again for the member; the registry has no removal. Each `onChange`, `onDetached` and `onAdded` returns a plain disposer, so the caller registers it inside its own `ctx.effect`; a notification already running still calls a listener removed during it. A listener that throws is logged without its error or the member, and the others still run.

An access object is bound to the row instance it was created from, so create it in the scope that injects `consoleMembers`; a reloaded row needs new access objects. When the row unloads, that scope and the holder's are disposed in an order that depends on how they were loaded, so an `onDetached` listener registered in that scope may never be called; the scope's own cleanup also counts as every token being dropped. `/credential-access` is the typed access path to the tokens, not a confidentiality boundary: the directory keeps the row's state, the reader included, under a symbol that `ctx.consoleMembers` passes through, so any plugin holding the directory can reach the tokens and replace that state. Plugins in one process are trusted, and the one-reader rule decides which reader supplies the tokens, not who reads through it.

### Configure the row

The row is `name: '@deepseek-ai/dsh-experimental-console-members'` and injects `connection` and `workspaceRegistry`. No field is volatile; a deployment writes them in its lock layer.

| Field | Default | Meaning |
|---|---|---|
| `assertionHeader` | `'x-dsh-member'` | Request header carrying the signed member assertion; compared in lower case. It must be the name the deployment proxy strips from client requests and signs; for the server-base proxy that is `x-dsh-member` |
| `assertionPublicKey` | required | Ed25519 public key in SPKI PEM form (`-----BEGIN PUBLIC KEY-----`) |
| `deploymentId` | required | The value an assertion's `aud` must equal |
| `admins` | `[]` | `login_uid` of each administrator |
| `membersRoot` | required | Absolute directory holding one root per member |
| `sharedReadRoots` | `[]` | Absolute paths every member may read |
| `rootSeeds` | `[]` | `{ path, principal }` or `{ path, owner: 'none' }`, merged into the root registry |
| `hostReadPaths`, `hostWritePaths` | `[]` | Absolute prefixes a read or write may reach while no member is current |
| `peerIdleMs` | `600000` | Milliseconds a member Peer with no Remote stream socket stays open after its last request or socket close; a whole number from 1 to 2147483647, the longest `setTimeout` delay |

The load fails at the first check that does not pass, before the row registers anything: the fields above (absolute paths, a header name, `admins` and `rootSeeds` given as lists, non-empty `login_uid` strings, each seed in exactly one form); the key, which must be exactly one Ed25519 public key block, so a private key, alone or after the public key, is refused; Connection's `requireAdmitter`, which must be `true`; and the seed merge into the root registry. No load error quotes a `login_uid` or the key.

The root registry, `roots.json` under `$DSH_HOME/console-members`, maps each registered root to one member or to no member. Roots are compared as the file system reads them: the longest existing leading part of each path is replaced by its real path, and on macOS and Windows letter case and Unicode forms are folded. No two roots are one directory or lie one inside the other, no seed overlaps `membersRoot`, neither `membersRoot` nor any root overlaps `$DSH_HOME/console-members`, which holds `roots.json` and the per-member data, and a seed naming a directory registered to another owner fails the load. A member's root is `<membersRoot>/<random UUID>`, created with mode 0700 and recorded before the member's admission continues; per-member data lives at `$DSH_HOME/console-members/<directory id>/<unit>.json`, so no path carries a principal key.

### Member admission

The deployment proxy signs a member assertion onto every HTTP request and WebSocket upgrade it forwards, under the `assertionHeader` name. The value is `v1.<payload>.<signature>`: `<payload>` is the unpadded base64url form of the UTF-8 JSON object `{"p","aud","exp"}`, where `p` is the member's `login_uid`, `aud` the deployment id and `exp` the Unix second the assertion expires, and `<signature>` is the unpadded base64url Ed25519 signature of the ASCII text `v1.<payload>`. The row admits a request only when the header occurs once, the value matches `^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$` (a repeated header that Node joined with a comma does not), the signature verifies against `assertionPublicKey`, the payload is a JSON object with exactly `p`, `aud` and `exp`, `p` is a non-empty string and `exp` an integer, `aud` equals `deploymentId`, and the current Unix second is before `exp`. There is no clock skew allowance and no upper bound on `exp`. Every other request is answered 401, a request that carries a valid dsh browser cookie included, and so is a request whose admission fails inside the row, such as a first sighting whose root cannot be registered.

A member keeps one Peer while it lives, so every request of that member, and every repeated admission of one request, speaks through the same Peer. The row disposes a member's Peer when no Remote stream socket has been bound to it for `peerIdleMs` since its last request or the close of its last socket; the member's next request opens a new Peer. Unloading the row withdraws the admitter, disposes every Peer the row opened, which closes their sockets with code 1001, and finishes once every default-workspace registration in flight has settled; with `requireAdmitter: true` Connection then answers 401 until the row loads again.

`principalOfCaller` answers `undefined` for the operator, for a Peer the row did not open, and for a member Peer that is released, which `ctx.connection.peers.get(peer.id) === peer` decides. A plugin recognises the operator only by `peer === ctx.connection.operator`; an `undefined` member never means the operator. No log line or error text of the row carries a principal key, an assertion, or a header value: an admission failure is logged with at most a system error code, and a throwing `onChange` listener with neither its error nor the member.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/types.ts` holds the type declarations and one `declare module '@deepseek-ai/cordis'` merge that adds `consoleMembers: ConsoleMemberDirectory` to `Context`; the package root re-exports those types and exports the plugin. `src/install.ts` registers, in one synchronous call, the directory service, the listeners that follow member Peers and their sockets, the unload disposal of the row's Peers, and last the admitter; Cordis starts disposers in reverse order, so unloading withdraws the admitter before anything else. The directory keeps its state under one symbol from `src/internal-state.ts`, because `ctx.consoleMembers` is a traceable proxy and its methods run with the proxy as `this`. `./credential-access` reads the state through the same symbol, so `tsdown.config.ts` builds the package root and that entry in one build, which places `src/internal-state.ts` in one chunk both import; a separate build of either entry would create a second symbol, and `tests/built-entries.e2e.ts` checks the built entries for it.

| File | Contents |
|---|---|
| [`src/types.ts`](src/types.ts) | `PrincipalKey`, `ConsoleMemberDirectory`, `MemberStore`, `CustomerCredentialReader`, and the `Context` merge; the `/types` entry |
| [`src/index.ts`](src/index.ts) | The package root: the plugin's `name`, `inject`, `Config` and `apply`, and the type re-exports |
| [`src/config.ts`](src/config.ts) | The Config schema, the field checks, the key check and the `requireAdmitter` check |
| [`src/load.ts`](src/load.ts) | The load checks in order |
| [`src/install.ts`](src/install.ts) | What a loaded row registers, in order |
| [`src/assertion.ts`](src/assertion.ts) | Member assertion verification |
| [`src/peers.ts`](src/peers.ts) | The member Peer table, the admitter, socket tracking and the idle close |
| [`src/directory.ts`](src/directory.ts) | The `ctx.consoleMembers` service |
| [`src/internal-state.ts`](src/internal-state.ts) | The symbol the directory's state is kept under, and the read of that state from a directory or its proxy |
| [`src/credentials.ts`](src/credentials.ts) | The customer-token reader slot: attach, detach, reads and forwarded changes |
| [`src/credential-access.ts`](src/credential-access.ts) | The `/credential-access` entry: `customerCredentialAccess` and `memberRegistryAccess` |
| [`src/listeners.ts`](src/listeners.ts) | Listener sets whose throwing listener is logged without its arguments |
| [`src/registry.ts`](src/registry.ts) | `roots.json`, the seed merge, member roots on first sighting and their listeners, the registered members, `memberRoot`, `rootsOf` and `memberStore` |
| [`src/paths.ts`](src/paths.ts) | The form root paths are compared in |
| [`src/member-store.ts`](src/member-store.ts) | Per-member JSON files, replaced through a rename |
| [`src/default-workspace.ts`](src/default-workspace.ts) | One default-workspace registration step per member and process, and whether it has succeeded |

The registry writes `roots.json` synchronously, through a random-suffix sibling opened with exclusive create and mode 0600 and a rename, because the member admitter that records a first sighting is synchronous. A member's default workspace `<member root>/workspace` is registered after admission by a step that creates the directory, refuses it when its real path is another directory (a symbolic link stands at it), and calls `workspace.create`, which returns the workspace already registered for that path; a workspace registered at any other path also fails the step. A failed step is logged without the principal key or the failure text and starts again on the next call; until a step succeeds in the current process, the member's default workspace counts as not ready.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Console member directory](../../../docs/subsystems/console-members.md) — the request, parent-chain, and customer-token rules.
- [`dsh-experimental-biz-backend`](../biz-backend/README.md#whom-a-read-is-for) — a credential resolver that names a request's member through `principalOfRequest`.
- [Client connection](../../client/connection/README.md) — Peer admission, which `principalOfRequest` runs, and `requireAdmitter`.

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or Session event, and its plugin row adds nothing to a model request.

#### KV Cache effect

The row adds no model input, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **`principalOfSession` is not implemented.** It throws in this build, so a plugin that asks for a Session's member fails instead of acting for no member. The method contract in [`src/types.ts`](src/types.ts) binds its implementation.
- **Revoking a member has no entry point.** Nothing in this build ends a member's access. After the customer system revokes an account, the member's HTTP requests are refused once the last signed assertion expires, because the deployment proxy signs each request with a lifetime of `ASSERTION_LIFETIME_SECONDS` (120 seconds in `server-base`). A Remote stream WebSocket already bound to the member's Peer stays open and keeps acting as the member until it closes, and the Peer is disposed `peerIdleMs` after the later of its last admission and its last socket close; an assertion signed before the revocation admits requests until it expires.
- **No Remote call, route or event is judged per member yet.** The row registers no `remote/invoke` or `connection/fetch` listener and no `$events` filter. With its admitter installed, Connection answers 503 on exact routes and channels, the Gateway answers `gateway/service-unavailable` to every Remote call, and `$events` delivers no event.
- **A failed first-sighting write leaves an empty directory.** When `roots.json` cannot be replaced after a member's root was created, the member stays unregistered and the empty `<membersRoot>/<UUID>` remains; the next first sighting creates another.
- **A process killed while replacing `roots.json` leaves its temporary sibling.** A kill between writing `roots.json.<random hex>.tmp` and renaming it leaves that file, mode 0600, in `$DSH_HOME/console-members`; it holds the same paths and principal keys as `roots.json`, and nothing removes it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
