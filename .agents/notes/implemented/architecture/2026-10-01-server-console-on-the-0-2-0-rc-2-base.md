# Agent Note: The product-console line on the 0.2.0-rc.2 base — compiler faces, rebased persistence records, the Session-log switch

Status: implemented

English | [中文](2026-10-01-server-console-on-the-0-2-0-rc-2-base.zh.md)

## Problem

The merge of the 0.2.0-rc.2 base into the console line met four conditions. The browser `ClientRemote` augmentation exists only in the `lib/typert.remote-client.d.ts` files the Host tsdown pass generates, and `pnpm run typecheck` runs the Host `tsc -b` before that pass; before the decision below, the chain `tsconfig.host.json` → `skill-pack-components` → `component-surface` (then one Client config) → `ui-chat` reached Client code that reads a generated `ctx.remote` namespace, so on a clean tree each read failed with `TS2339: Property '<namespace>' does not exist on type 'ClientRemote'`, for example `ctx.remote.session` in `ui-chat/src/client/apply.ts`. Upstream's persistence record `2026-09-21-user-question-reply` changes `agent/inbox/spliced`, `developer/message`, `session/title-llm-request`, and `user/message` from `2026-09-16-session-format-v4`, and this line's `2026-09-26-console-content-events` changes the same four roots from the same record; `verify-persistence-changes` refuses the merged tree with `forked persistence history for event:agent/inbox/spliced: 2026-09-21-user-question-reply and 2026-09-26-console-content-events`. The Web bundle adds `ui-settings-session-log`, a Settings → General switch that uploads the Session log to the official model API by editing the volatile `session-log-deepseek.enabled`. The patch registered as `client-library-config-export` exported `clientLibraryConfig` from `packages/client/tsdown.client.ts` for a second `server-sidebar` Node entry, `lib/types/invariant.js`, which the package no longer built.

## Decision

**`component-surface` has Host and Client compiler faces.** `component-surface` has a `tsconfig.host.json` (the sources outside `src/client/`, Host references only), a `tsconfig.client.json` (all of `src` and the Client references), and a solution-only root `tsconfig.json`, the layout upstream's `inspector` uses. No project the Host aggregate reaches compiles Client code, so the Host `tsc -b` never reads a `ClientRemote` namespace that only the later tsdown pass declares. `skill-pack-components` extends the Host base and references the Host leaf; `tsconfig.host.json` references the Host leaf so that Typert's Host face registers `ctx.componentCatalog` and `ctx.componentViews`; `tsconfig.client.json`, `tsconfig.vue2-tests.json`, and `component-kit` reference the Client leaf.

**This line's persistence records are unaccepted until a product release finalizes them, and each base sync rebases them onto upstream history.** This is the line's rule. The history verifier refuses two successors of one predecessor on a root, a new record cannot change an existing record's `previous`, and this line does not edit records upstream ships, so the two original records cannot both stay: this line's record changes. Neither record is accepted under the [record rules](../../../../docs/persistence-changes/README.md): the V4 checkpoint `docs/persistence-changes/finalized/v4.json` locks records up to `2026-09-16-session-format-v4` and names neither, and this line has no finalization checkpoint of its own. On this base, `2026-09-26-console-content-events`, refreshed with `persistence-changes --update`, names `2026-09-21-user-question-reply` as predecessor of the four roots and acknowledges this line's two Host-declared source kinds (`content-surface`, `content-component`) and six content events against the current tree; `content-frame`'s `MessageSourceMap` entry is declared in a Client package outside the Host aggregate the extractor reads. The refresh command refuses a record with dependants, so this line keeps one record on these roots, not a predecessor and a successor.

**The Session-log upload switch is disabled and its setting held off.** The console bundle layer disables `ui-settings-session-log` with the other official-branding surfaces. The lock overlay `permission-lock.patch.yml` restates `session-log-deepseek` with `enabled: false` for the same reason it carries `permission` and `agent-preset-registry`: the switch writes the deployment's shared profile patch, and below the lock one write over `remote.settings` from any admitted browser would turn upload on for every session the host serves. Above the profile patch, config-editor refuses that write.

**`clientLibraryConfig` stays module-private.** `server-sidebar/tsdown.config.ts` builds its one Node entry, `lib/types/index.js`, with `clientBundle`, and `git grep clientLibraryConfig -- packages apps scripts` finds only the definition and its two calls inside `packages/client/tsdown.client.ts`. That file carries the `dsh-v0.2.0-rc.2` text, and the ledger record `client-library-config-export` is retired.

## Alternatives considered

**One Client config for `component-surface`, left outside the Host aggregate.** The Host `tsc -b` would stop reaching Client code, but Typert's Host face would not register the package, and `gen-cordis-catalog` reports `ctx.componentCatalog` and `ctx.componentViews` as missing.

**Generating the `ClientRemote` augmentation before the Host `tsc -b`.** That changes the order of upstream's `typecheck` script, a core patch the face split does not need.

**Keeping both original persistence records.** The verifier refuses the fork, and resolving it on upstream's side means editing a record upstream ships in `dsh-v0.2.0-rc.2`, which every later sync would conflict with.

**Adding a successor record instead of refreshing this line's record.** A successor cannot change its predecessor's `previous`, so `2026-09-16-session-format-v4` would keep two successors.

**Treating every record on `origin/product/server-console` as accepted.** An accepted record cannot be refreshed, so the next upstream record that changes a root from the same predecessor as this line's record would leave a fork that only an edit to upstream's record resolves.

**Leaving the Session-log switch on the page with the host row at `enabled: false`.** The base bundle's `enabled: false` is the value below the profile patch; one save from the switch lands in that patch and outranks it.

**Disabling the switch without the lock row.** The page would offer no control, but `remote.settings` still accepts the write from any admitted browser.

**Keeping the `clientLibraryConfig` export.** It has no consumer, and an active ledger record with no consumer keeps a core path different from the base for nothing.

## Consequences

`pnpm run typecheck` passes, and `component-surface` follows the Host/Client face rule in `docs/development.md`. The persistence rule keeps upstream's record history untouched and lets each sync merge upstream records without a core patch; the cost is that this line's machine declarations and schema snapshots change at sync time, so a record on this line describes the transition against the current base, not the one it was first written against. Session logs are unaffected: the records are input to repository gates, and no Session writer or reader consults them. The rule ends when a product release adds a finalization checkpoint for this line's records; from then on, those records follow the accepted-record rules. The console offers no Session-log upload control, and a deployment that wants upload changes the lock overlay. `packages/client/tsdown.client.ts` matches the base, so upstream changes to it merge without conflict.
