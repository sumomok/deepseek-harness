# Agent Note: Vendored client halves apply in the real client runtime

Status: implemented

English | [中文](2026-09-11-vendored-client-runtime-gate.zh.md)

## Problem

An installed rc.32 desktop client opened on a boot failure and nothing else: `failed to apply loader entry 641ca806 (@haoran/dsh-desktop-update): client api: method "desktopUpdate/install" conflicts with its namespace service`. The browser half of `@haoran/dsh-desktop-update@0.1.0` names one of its Remote methods `install`, which is already a member of `RemoteNamespaceService.prototype`, so [`assertMethodAvailable`](../../../../packages/api/gateway/src/client/index.ts) refuses the contribution and `apply` throws. The web boot fails the page when any entry does not activate, so one plugin took the whole application down.

Two gates had already passed on that same payload. The static checks read `dsh.client` declarations, bundle presence, and the profile seed, none of which can see a Remote method name colliding with a class prototype. The runtime smoke fetched each `client.js` over HTTP and executed it in `node:vm` against a hand-written `ctx` whose `remote.$mount` accepted every contribution — the rule that rejects the collision lives in the production Client Remote service the stub had replaced. rc.31 lost a release to the same shape of miss: a plugin-client check that never ran against the packaged app.

## Decision

[`apps/desktop-shell/tests/vendored-client-runtime.client.spec.ts`](../../../../apps/desktop-shell/tests/vendored-client-runtime.client.spec.ts) applies every seeded built-in's browser half in the runtime the shipped page uses, in jsdom, with no repository build.

The rows come from [`BUILTIN_WEB_BUNDLES`](../../../../apps/desktop-shell/src/profile-seed.ts) resolved through the [deploy root's](../../../../apps/desktop-server/package.json) manifest, which is the `node_modules` closure the payload ships: each name that declares `dsh.client` contributes its declared `./client` artifact, and the two that declare none (`@haoran/dsh-default-model` and the `@deepseek-ai/dsh-desktop-app` composition layer) are named in the suite so a package that later grows a browser half cannot join the payload without joining the gate. Every covered row is a `file:` tarball dependency, which is why the suite reads a real built `lib/client.js` while itself resolving workspace imports to source.

The bundles arrive through the production [`ClientModuleSystem`](../../../../packages/client/modules/src/client/system.ts) over `getStaticModules()`, the same platform seed the shell shares, so a bundle that requests a specifier outside the module table fails here exactly as it would on the page. Each half then applies on a Cordis root carrying the production SlotRegistry, `LocaleRuntime`, `UiConversation`, the input-trigger service, the Typert registry, and the Client Remote service that owns the namespace and method rules. Every plugin gets its own page, and one further case applies the whole set on a single page, which is what the shipped client does.

What is replaced is the Host behind the wire: the Connection carrier answers no request, the settings transport is an in-memory scope, and the Host-served `session` namespace is one descriptor of the suite's own mounted through the real registrar, because the generated `/remote` contributions are emitted into built `lib/` only. No vendored half calls a Remote method while applying, so none of them depends on an answer.

## What this gate does not see

Anything that needs a Host answer. The carrier rejects every request, so post-apply reads (`atFile/getSettings`, `accountBalance/get`, `pluginUpdates/list`) exercise only each plugin's own failure path.

Slot registrations parked behind `ctx.slots.inject(key, …)`. That call waits for a declarer to hold the key, and this bench declares none, so a plugin's registration body never runs: renaming a plugin's slot key to one that exists nowhere leaves the suite green. Slot keys, entry ids, and the components themselves stay the responsibility of the feature suites and of the assembled-boot lane in `apps/web/tests`.

The served HTML `__ModuleLoader__` facade, which the suite rebuilds as a plain object because evaluating the injected script needs a built client-modules bundle. `packages/client/modules/tests` owns that facade's own behavior.

React rendering, layout, and anything downstream of mounting: this gate answers whether a half applies, not whether it draws.

## Compiler faces

The suite reads the Client Context merges, and the rest of `apps/desktop-shell/tests` reads the Host ones, which one program cannot hold together. The file therefore carries the `*.client.spec.ts` suffix that already separates the two aggregates: [`tsconfig.client.json`](../../../../tsconfig.client.json) includes `apps/*/tests/**/*.client.spec.ts` and [`tsconfig.host.json`](../../../../tsconfig.host.json) excludes it, mirroring how `apps/web` splits its client project from its host-plane e2e files.

## Alternatives considered

**Reuse `apps/web/tests/assembled-boot.ts`.** It is the most faithful client runtime in the repository — the real `AppWebEntry`, the real Loader, the real graph — but it mounts the built `lib/client.js` of every workspace client package, so it requires `pnpm run build` before it can run. That makes it an artifact-plane lane, unfit for a source-plane suite that must run in the everyday `vitest` invocation. Its e2e lane keeps covering the assembled page; this gate covers the vendored halves cheaply enough to run on every change.

**Teach the existing `node:vm` stub the missing rule.** Restating `assertMethodAvailable` in the stub would have caught this one bug and nothing else, and a restated rule drifts from the rule it copies. The failure was not a missing assertion but a missing runtime.

**Mount the real `@deepseek-ai/dsh-api-remotes` assembly for `remote.session`.** Its client half imports fifteen generated `/remote` artifacts that exist only after a build, so mounting it would have reintroduced the build dependency for one injected service name. One suite-owned descriptor through the real registrar publishes the same service with none of it.

**Put the suite in a package instead of `apps/desktop-shell`.** The row list and the vendored payload both belong to the desktop shell, and a new package to host one spec would move the gate away from what it guards. Splitting the compiler face of one file is the smaller cost.

## Consequences

This commit lands red. `@haoran/dsh-desktop-update@0.1.0` is still the vendored tarball, so the per-plugin case and the whole-set case both fail with the production error text; they turn green when 0.1.1 renames the method and is re-vendored. Landing the gate red is the point — a gate first proven against the defect it was written for cannot be quietly wrong about it.

The suite runs in roughly 1.6 seconds and adds about a second to `pnpm exec vitest run apps/desktop-shell/tests`, so it needs no lane of its own.

Every future vendored plugin pays a cost: a browser half that injects a service this bench does not provide fails the gate on the missing service rather than on its own behavior, and the bench must grow that service. That is the intended direction — the alternative is a gate that quietly stops covering new plugins.

## Verification

Three mutations, each applied to a vendored bundle and reverted byte-identically. Renaming `mcpServers/list` to `mcpServers/namespace` fails with `client api: method "mcpServers/namespace" conflicts with its namespace service`. Changing `@haoran/dsh-btw`'s locale namespace from `btw` to the already-registered `common` fails with `locale namespace "common" already has locale "zh"`. Changing that plugin's slot key to one no declarer holds does not fail, which is the recorded gap above.
