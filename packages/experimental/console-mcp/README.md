---
description: "Mount the console's MCP capability once, with no server, so a deployment adds external MCP servers by naming an endpoint and a credential rather than by shipping code."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-console-mcp

English | [中文](README.zh.md)

## Summary

`dsh-experimental-console-mcp` is the row a console composition always carries so that external MCP servers become a deployment's decision instead of a build's. It takes one list — each entry an endpoint and the *name* of a credential — and mounts one [`dsh-mcp-client`](../../mcp/mcp-client/README.md) bridge per entry. An empty list is the ordinary delivered state: the row loads, opens no connection, registers no tool, and adds nothing to any model request. A console end user cannot add a server, because nothing this row reads is written from a page they can reach.

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

The console bundle ([`cordis.patch.yml`](../console-profile/cordis.patch.yml)) already mounts this row with `servers: []`. A deployment that reaches an MCP server patches that list in its own layer; nothing else changes.

### Name a server

```yaml
- id: console-mcp
  name: '@deepseek-ai/dsh-experimental-console-mcp'
  config:
    servers:
      - id: iot
        url: https://mcp.example.internal/mcp
        auth:
          header: Authorization
          credential: IOT_MCP_TOKEN
          scheme: 'Bearer '
```

| Field | Default | Meaning |
|---|---|---|
| `servers` | `[]` | The servers, in the order written. Empty is the capability present and idle. |
| `servers[].id` | required | This server's tool namespace: its tools reach the model as `mcp__<id>__<tool>`. `[A-Za-z0-9_-]{1,32}`, unique across the list. |
| `servers[].url` | required | Absolute `http`/`https` Streamable HTTP endpoint, carrying no user information and no fragment. |
| `servers[].auth` | — | The credential attached to every request; omit for an endpoint that needs none. |
| `servers[].auth.header` | required | Request header the credential is spent on. |
| `servers[].auth.credential` | required | Credential *reference* — an environment-variable name, never a value. |
| `servers[].auth.scheme` | `''` | Text placed before the resolved value, such as `Bearer `. |
| `servers[].toolCallTimeoutMs` | the bridge's own | Per-tool-call timeout in milliseconds. |
| `servers[].failOnStartupError` | the bridge's own | Whether a failed first connection fails the boot. |

### Where the secret lives

`credential` names a secret; it never holds one. The [credential seam](../../credentials/credentials/README.md) resolves that name against whatever provider the composition carries — the shipped one reads `$DSH_HOME/.credentials.yaml`, the process environment, and `.env` files. The composition file therefore travels, is diffed, and is quoted in diagnostics without ever carrying the value.

A reference nothing has stored a value for fails the row while it loads, naming the reference and not the value:

```
console-mcp: server "iot" names credential "IOT_MCP_TOKEN", which nothing has stored a value for
```

### Two ways a request is identified

A server reached through `auth` is reached under **this deployment's own service credential** — the same identity for every person using the console. Where the request should instead carry the signed-in visitor's own token, point `url` at [`auth-gate`](../auth-gate/README.md)'s forwarding route and write no `auth`:

```yaml
- id: auth-gate
  name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    mcpUpstreams:
      iot: https://mcp.example.internal/mcp
    # …

- id: console-mcp
  name: '@deepseek-ai/dsh-experimental-console-mcp'
  config:
    servers:
      - id: iot
        url: !!js `http://127.0.0.1:${process.env.DSH_PORT}/auth-gate/mcp/iot`
```

The gate replaces `Authorization` with the token the browser posted, so the write lands under the person who asked for it. The two differ in whose identity the server records, which is why the choice belongs to whoever composes the deployment rather than to this row's defaults.

### What fails, and when

Everything one composition file can judge by itself throws while the row loads, and the whole list is refused rather than the offending entry dropped — a console that came up having silently skipped a server would be a console whose operator believes it is reaching one. That covers an id outside the namespace grammar, two entries claiming one id, a url that is not absolute `http(s)`, a url carrying user information or a fragment, a header name that is not a header name, and a credential reference outside the reference grammar. The one check that needs a service — whether the named reference has a value — runs immediately after, at the same load.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Why a row rather than one `dsh-mcp-client` row per server

`dsh-mcp-client` takes exactly one server per row and requires a `serverName`, so a composition reaching no server states no row at all — and "the capability is absent" and "the capability is present with nothing configured" become the same file. The console needs them distinct: the composition's promise is that MCP is mounted, and the deployment's contribution is only the list. One row with a list expresses that, and an empty list is a value a deployment can see and edit rather than a row it must know to add.

The second reason is the credential. `dsh-mcp-client`'s `headers` is a string table, so today a composition reaches a secret through `!!js process.env.X` — an expression evaluated at load, whose failure mode is a header quietly carrying nothing. Naming a reference instead moves the read onto the credential seam, where a missing value is a diagnostic that names it.

### Request and spec

[`src/servers.ts`](src/servers.ts) is the `resolve(request): Spec` step: every self-contained check runs there, over the whole list, before `apply` touches a service. [`src/index.ts`](src/index.ts) then resolves each credential and mounts one child `ctx.plugin(mcpClient, …)` per spec, awaiting each — the bridge publishes its first tool generation before activation resolves, so a console's first turn sees the roster it will keep.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, credential resolution, per-server child mount |
| [`src/servers.ts`](src/servers.ts) | The self-contained checks and the `ServerSpec` they produce |

### Only Streamable HTTP

A stdio server is a local program the host starts, outside every sandbox this product applies, under the account running the host. That is a real deployment decision, and it is not one a console makes by adding a line to a server list — so this row does not offer it. A deployment that genuinely needs one composes `dsh-mcp-client` directly and owns that choice explicitly.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client bridge](../../mcp/mcp-client/README.md) — naming, tool execution, reconnection, and the result contract this row mounts.
- [Credential seam](../../credentials/credentials/README.md) — what a reference is and which layers resolve it.
- [Auth gate](../auth-gate/README.md) — the per-visitor token forward, for a server that must record the signed-in person.
- [Server sidebar](../server-sidebar/README.md) — the console composition this row is delivered in.
- [Experimental packages](../README.md) — incubation status and release exclusion.

-----

<a id="model-experience"></a>
## Model Experience

### Bridged MCP tools

#### What the model sees

Nothing, while the list is empty — this row contributes no tool, no prompt section, and no session event. For each configured server, the model sees exactly what `dsh-mcp-client` registers: every tool that server advertises, under `mcp__<id>__<tool>`, with the server's own description and input schema.

#### Token effect

Zero while the list is empty. Otherwise every advertised tool's description and schema enter every request for as long as the server is registered — this row applies no filter, so a server advertising thirty tools costs thirty definitions per turn.

#### KV Cache effect

Prefix-stable while the configured set and each server's advertised list are unchanged. Adding a server to the list, or a server re-advertising a changed tool, replaces definitions and may invalidate reuse from the first changed schema token onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A credential is read once, at load.** `dsh-mcp-client` resolves its headers when its row loads, so the value this row hands it is fixed for that process. Rotating the secret behind the same name reaches the server only after a reload — unlike the seam's own per-operation rule, which this row cannot honor through a string header table.
- **Tool descriptions come from the server verbatim.** Nothing here rewrites or screens them, so a server can put instructions in front of the model through a description.
- **No per-tool selection.** Every tool a configured server advertises is registered. A server that advertises more than a deployment wants is a server that should advertise less; this row offers no allow list.
- **Streamable HTTP only** — see [Understand the implementation](#understand-the-implementation).
- **The capability is not per person.** A console process serves whoever its deployment admits, and a server reached under `auth` records this deployment, not the person. The auth-gate route is what makes a request carry the visitor.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- Per-tool selection and a stored, user-confirmed tool set exist out of tree in `@haoran/dsh-mcp-servers`, which drives the same bridge from a settings document for the desktop. That design is deliberately not reused here: its whole surface is a Settings page, and the console's end users must not have one.
- Whether `failOnStartupError` should default to true for a console — a deployment that names a server presumably means to reach it — is open; it currently inherits the bridge's `false`.

</details>
