---
description: "TypeScript declarations for ctx.consoleMembers, the console member directory: which signed-in member a browser request, a Remote caller, or a Session belongs to, each member's registered roots, and per-member non-secret storage; for console-line plugins that act for one member."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-members

English | [中文](README.zh.md)

## Summary

Type a console-line plugin against `ctx.consoleMembers`: ask which signed-in member a browser request, a Remote caller, or a Session belongs to, list that member's registered roots, and keep non-secret data per member. The package exports the directory's types and declares the context key. It registers no plugin, so an `inject: ['consoleMembers']` stays pending until a plugin that provides the directory is loaded.

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

The `/types` entry imports no Host entry point, so Host plugins and Client programs both import it. The package root re-exports the same types, but it is reserved for the plugin that will provide the directory; a Client program never imports the package root.

`principalOfRequest` is the only way a fork webServer route obtains a request's member: the route reads no identity header and calls no `connection.admit` of its own. `principalOfSession` follows a child Session's parent chain to the topmost Session, and `attachCustomerCredentials` holds one customer-token reader at a time, which no method returns. The [subsystem page](../../../docs/subsystems/console-members.md) explains these three rules; [`src/types.ts`](src/types.ts) states every method's contract.

`PrincipalKey` is `Branded<'PrincipalKey'>` from `@deepseek-ai/dsh-brand`, and its value is the member's `login_uid`. A consumer treats it as opaque, and it reaches no model request, log line, or upload.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/types.ts` holds the type declarations and one `declare module '@deepseek-ai/cordis'` merge that adds `consoleMembers: ConsoleMemberDirectory` to `Context`; the package root re-exports those types. The compiled `lib/index.js` and `lib/types/types.js` export nothing, and no `cordis.yml` row can name the package.

| File | Contents |
|---|---|
| [`src/types.ts`](src/types.ts) | `PrincipalKey`, `ConsoleMemberDirectory`, `MemberStore`, `CustomerCredentialReader`, and the `Context` merge; the `/types` entry |
| [`src/index.ts`](src/index.ts) | The package root: a type-only re-export of `src/types.ts` |
| [`tests/types.spec.ts`](tests/types.spec.ts) | Type assertions on the `Context` key, the principal-key brand, and the root's re-exports |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Console member directory](../../../docs/subsystems/console-members.md) — the request, parent-chain, and customer-token rules.
- [`dsh-experimental-biz-backend`](../biz-backend/README.md#whom-a-read-is-for) — a credential resolver that names a request's member through `principalOfRequest`.
- [Client connection](../../client/connection/README.md) — Peer admission, which `principalOfRequest` runs.

<a id="model-experience"></a>
## Model Experience

None, as this package only exports types and registers no plugin, tool, prompt section, or Session event.

#### KV Cache effect

Type declarations add no model input, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No provider in this repository.** No package provides `ctx.consoleMembers`. A plugin that injects it never starts, and `ctx.get('consoleMembers')` answers `undefined`. The method contracts in [`src/types.ts`](src/types.ts) bind whichever plugin provides the directory; no test exercises them, because the package's spec checks declarations only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
