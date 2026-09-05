# Agent Note: MCP servers are added from the desktop's settings page

Status: implemented

English | [中文](2026-09-06-desktop-mcp-servers.zh.md)

## Problem

The harness ships an MCP client, [`@deepseek-ai/dsh-mcp-client`](../../../../packages/mcp/mcp-client/README.md), and the desktop could not use it. It takes one composition entry per server, written into a YAML file and applied at the next restart, and it registers every tool the connected server lists onto `ctx.tools`. The people this application is built for do not open a terminal, so they cannot add a server at all; and a tool nobody read would enter every model request the moment a server offered it, including one whose description the server rewrote after it was first seen.

## Decision

`@haoran/dsh-mcp-servers` 0.1.0 becomes the twelfth desktop built-in, vendored as `apps/desktop-server/vendor/haoran-dsh-mcp-servers-0.1.0.tgz` (sha256 `2bffa01b9792b43fd0521cebfcd37c6ff6635d52d9dd80de539590b1df1d0d40`). It is an out-of-repository package from the `dsh-plugins` workspace and reaches the payload only as that `pnpm pack` archive, like every other built-in.

It drives the upstream client from the settings document instead of from composition, and puts two answers in front of it. A stored server carries the fingerprint of the destination someone confirmed — command, arguments, working directory, environment, or URL and headers — and a change to any of them stops the server and asks again. A tool is registered only after its exact name, description, and input schema were ticked; a server that rewrites a tool's wording returns it to the waiting list, so it leaves the model's schema list rather than merely failing its next call. With no server stored the plugin registers no tool, starts no process, and adds nothing to any request.

The settings section is **External tools** (「外部工具」). Saving a server stores it and does not connect it: the row reads **Waiting for you** with the destination spelled out, and connecting is a second, deliberate click on **Confirm and connect** (「确认并连接」). A stdio server's program must be named by a full path, because a bare name would resolve against whatever directory the application happened to start in.

### Why `@deepseek-ai/dsh-mcp-client` joins the desktop-server manifest

The plugin's host half imports the client and mounts it per server with `ctx.plugin(McpClient, …)`. A `@deepseek-ai/*` import from an out-of-repository plugin is a peer: it resolves against the running installation's own dependency closure, not beside the plugin. The profile's flat module fallback is built by `resolveModuleFallbackEntries` ([`packages/boot/app-boot/src/profile.ts:497`-`:531`](../../../../packages/boot/app-boot/src/profile.ts)), a breadth-first walk over each reached manifest's `dependencies` and `peerDependencies` starting at the installation anchor, so a package no manifest in that closure names is never linked into `$DSH_HOME/profiles/node_modules` and the plugin fails to load. Listing `@deepseek-ai/dsh-mcp-client` in [`apps/desktop-server/package.json`](../../../../apps/desktop-server/package.json) is what puts it in the walk, and `pnpm deploy` then carries it into the payload with everything else.

### Position in the bundle stack

The name is appended last in `BUILTIN_WEB_BUNDLES` ([`apps/desktop/src/profile-seed.ts`](../../../../apps/desktop/src/profile-seed.ts)). Order between bundle layers decides nothing except where two layers patch the same entry id: `@haoran/dsh-default-model` replaces the whole `config` of the `agent-default-model` and `llm-deepseek` rows, so no later layer may target either, and this plugin's `cordis.patch.yml` only inserts a row of its own under the id `mcp-servers`. The `product/server-console` line's `feat/desktop-content-search` branch appends `@deepseek-ai/dsh-desktop-app`, which must stay last there; where the two branches meet, that name goes after this one.

### What the desktop gives up by mounting it

**A stdio server runs outside the sandbox.** The MCP SDK starts the child process itself rather than through `ctx.shell`, so no sandbox mode the application offers reaches it and it runs with the account and permissions of whoever is using the computer. The connect confirmation is the whole control over that.

**Every ticked tool's definition enters every request.** Tool definitions are not loaded on demand, so ticking thirty tools costs thirty names, descriptions, and input schemas in each turn.

**The review model judges every MCP call.** `@haoran/dsh-llm-permission-gateway` skips only the tools named in its `readOnlyTools` and, under a sandbox, its `walledTools`; neither list carries an `mcp__*` name and neither can, since the names depend on which servers a machine holds. Under 自动审查 every MCP tool call therefore costs one review call, and outside it the calls are unreviewed and unwalled alike.

**A tool description is the server's own text.** Nothing rewrites or screens it, so a server can put instructions to the model into a description that a person approved by reading it.

## Alternatives considered

**Mount `@deepseek-ai/dsh-mcp-client` directly from the desktop profile's patch layer.** It is the smaller change and it ships no new package. It also leaves adding a server as a YAML edit plus a restart, which this product's users cannot perform, and it registers every tool a server lists with nobody having read one.

**Let the Electron shell answer the connect confirmation in a native window.** `ctx.approval` is agent-bound and turn-bound: it reaches somebody only while exactly one conversation is open and mid-turn, and a confirmation raised from a settings page usually has nobody to ask. The plugin keeps that seam open — `confirm: approval` and `ctx.mcpServers.useConfirmer(...)`, which is not part of the Remote face and so is unreachable over the wire — and ships `confirm: settings`, where the stored confirmation is the answer.

**Declare `@deepseek-ai/dsh-mcp-client` in the desktop profile's own manifest instead.** The machines this ships to have no package manager and the shell never runs an install, so a dependency entry there materializes nothing; only the payload's own closure is materialized, and that is what the desktop-server manifest defines.

**Bring the plugin into `packages/` under the `@deepseek-ai` scope.** The fork's standing orders keep out-of-repository plugins out of the workspace and admit them only as vendored `pnpm pack` tarballs, because a `link:` dependency would put a second cordis in the composition and break service identity.

## Consequences

Both README tables and the notices override table carry the new row, which [`verify-vendored-plugin-versions`](../../../../scripts/verify-vendored-plugin-versions.ts) requires of every vendored package in both languages; the built-in plugins table in [`apps/desktop/README.md`](../../../../apps/desktop/README.md) is where the count of what ships lives.

No new third-party attribution row appears: `@modelcontextprotocol/sdk` reaches the payload through `@deepseek-ai/dsh-mcp-client`'s own dependencies and `zod` through both it and the plugin, and `THIRD_PARTY_NOTICES.md` already named each.

`apps/web/tests/shipped-composition.e2e.ts` keeps its `EXPECTED_TOOLS` list unchanged for two independent reasons: that test boots the shipped Web composition, which carries none of the desktop's vendored plugins, and a mounted plugin with no stored server registers no tool anyway.

Two configurations a person copies from a third-party guide do not work here. A server named as a package (`npx …`, `uvx …`) will not start, because the payload puts Node and pnpm on `PATH` for its own installer and nothing else; the program has to be installed first and named by its full path. An HTTP+SSE endpoint has no transport, because the upstream client speaks stdio and Streamable HTTP only.

## Related

[The desktop installer ships plugins and seeds them into a profile of its own](2026-08-21-desktop-builtin-plugins.md) owns why the built-ins are in the payload and what a profile's own copy of one does. [The vendored plugin reference gate](../process/2026-09-03-vendored-plugin-reference-gate.md) owns the checks that keep this row in step with the tarball.
