---
description: "The console member directory, ctx.consoleMembers: which signed-in member a browser request, a Remote caller, or a Session belongs to, each member's registered roots, and per-member non-secret storage; the type declarations for console-line plugins that act for one member, and the plugin row that will provide the directory."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-members

English | [中文](README.zh.md)

## Summary

Type a console-line plugin against `ctx.consoleMembers`: ask which signed-in member a browser request, a Remote caller, or a Session belongs to, list that member's registered roots, and keep non-secret data per member. The `/types` entry exports the directory's types and declares the context key. The package root is the plugin row that will provide the directory; it checks its configuration and opens the root registry at load, and provides no service yet, so an `inject: ['consoleMembers']` stays pending.

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

`principalOfRequest` is the only way a fork webServer route obtains a request's member: the route reads no identity header and calls no `connection.admit` of its own. `principalOfSession` follows a child Session's parent chain to the topmost Session, and `attachCustomerCredentials` holds one customer-token reader at a time, which no method returns. The [subsystem page](../../../docs/subsystems/console-members.md) explains these three rules; [`src/types.ts`](src/types.ts) states every method's contract.

`PrincipalKey` is `Branded<'PrincipalKey'>` from `@deepseek-ai/dsh-brand`, and its value is the member's `login_uid`. A consumer treats it as opaque, and it reaches no model request, log line, or upload.

### Configure the row

The row is `name: '@deepseek-ai/dsh-experimental-console-members'` and injects `connection`. No field is volatile; a deployment writes them in its lock layer.

| Field | Default | Meaning |
|---|---|---|
| `assertionHeader` | `'x-dsh-member'` | Request header carrying the signed member assertion; compared in lower case |
| `assertionPublicKey` | required | Ed25519 public key in SPKI PEM form (`-----BEGIN PUBLIC KEY-----`) |
| `deploymentId` | required | The value an assertion's `aud` must equal |
| `admins` | `[]` | `login_uid` of each administrator |
| `membersRoot` | required | Absolute directory holding one root per member |
| `sharedReadRoots` | `[]` | Absolute paths every member may read |
| `rootSeeds` | `[]` | `{ path, principal }` or `{ path, owner: 'none' }`, merged into the root registry |
| `hostReadPaths`, `hostWritePaths` | `[]` | Absolute prefixes a read or write may reach while no member is current |
| `peerIdleMs` | `600000` | Milliseconds an idle member Peer stays open; a positive whole number |

The load fails at the first check that does not pass, before the row registers anything: the fields above (absolute paths, a header name, `admins` and `rootSeeds` given as lists, non-empty `login_uid` strings, each seed in exactly one form); the key, which must be exactly one Ed25519 public key block, so a private key, alone or after the public key, is refused; Connection's `requireAdmitter`, which must be `true`; and the seed merge into the root registry. No load error quotes a `login_uid` or the key.

The root registry, `roots.json` under `$DSH_HOME/console-members`, maps each registered root to one member or to no member. Roots are compared as the file system reads them: the longest existing leading part of each path is replaced by its real path, and on macOS and Windows letter case and Unicode forms are folded. No two roots are one directory or lie one inside the other, no seed overlaps `membersRoot`, neither `membersRoot` nor any root overlaps `$DSH_HOME/console-members`, which holds `roots.json` and the per-member data, and a seed naming a directory registered to another owner fails the load. A member's root is `<membersRoot>/<random UUID>`, created with mode 0700 and recorded before the member's admission continues; per-member data lives at `$DSH_HOME/console-members/<directory id>/<unit>.json`, so no path carries a principal key.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/types.ts` holds the type declarations and one `declare module '@deepseek-ai/cordis'` merge that adds `consoleMembers: ConsoleMemberDirectory` to `Context`; the package root re-exports those types and exports the plugin. No admitter, directory service or guard calls the registry or the default-workspace steps yet.

| File | Contents |
|---|---|
| [`src/types.ts`](src/types.ts) | `PrincipalKey`, `ConsoleMemberDirectory`, `MemberStore`, `CustomerCredentialReader`, and the `Context` merge; the `/types` entry |
| [`src/index.ts`](src/index.ts) | The package root: the plugin's `name`, `inject`, `Config` and `apply`, and the type re-exports |
| [`src/config.ts`](src/config.ts) | The Config schema, the field checks, the key check and the `requireAdmitter` check |
| [`src/load.ts`](src/load.ts) | The load checks in order |
| [`src/registry.ts`](src/registry.ts) | `roots.json`, the seed merge, member roots on first sighting, `memberRoot`, `rootsOf` and `memberStore` |
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

- **The row provides no directory yet.** The plugin checks its configuration and opens the root registry, but it installs no member admitter and provides no `ctx.consoleMembers`. A plugin that injects it never starts, and `ctx.get('consoleMembers')` answers `undefined`. The method contracts in [`src/types.ts`](src/types.ts) bind the directory the row will provide.
- **A failed first-sighting write leaves an empty directory.** When `roots.json` cannot be replaced after a member's root was created, the member stays unregistered and the empty `<membersRoot>/<UUID>` remains; the next first sighting creates another.
- **A process killed while replacing `roots.json` leaves its temporary sibling.** A kill between writing `roots.json.<random hex>.tmp` and renaming it leaves that file, mode 0600, in `$DSH_HOME/console-members`; it holds the same paths and principal keys as `roots.json`, and nothing removes it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
