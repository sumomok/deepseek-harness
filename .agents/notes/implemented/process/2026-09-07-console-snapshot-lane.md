# Agent Note: the console's snapshot lane moves to snapshots/console over the acp profile

Status: implemented

English | [中文](2026-09-07-console-snapshot-lane.zh.md)

## Problem

`examples/content-console` was the console's keyless snapshot lane: a headless ACP composition and eleven authored scenarios pinning the model-visible surface of `show_chart` and `show_component` — both tool schemas, the content-surface prompt section, every recorded argument and result line, and the boot-time refusal of a configured view the tool would reject.

The [merge forward onto 0.1.2-rc.1](2026-09-06-console-merge-forward.md) left it where it was and said so. That root has no `examples/` convention: the tree matches no glob in `pnpm-workspace.yaml`, no vitest config names the directory, and its `cordis.yml` composed `@deepseek-ai/dsh-acp-demo`, a package the rc.1 root does not contain. The lane was committed, unrunnable, and ungated — the one form of evidence that decays without anyone noticing, because nothing fails when it goes wrong. It also held the root's two standing `pnpm run lint` errors, since its adapter matched the type-aware `examples/**` oxlint override while its imports resolved to no type at all.

## Decision

**The lane becomes `snapshots/console/`, composed the way every other lane in that tree is: the shipped `dsh` CLI with `--profile acp` plus this lane's patch.**

`snapshots/` is where recorded-session tests live, `vitest.snapshot.config.ts` already includes `snapshots/**/*.snapshot.ts`, and [snapshots/AGENTS.md](../../../../snapshots/AGENTS.md) requires exactly that launch shape. The eleven scenario directories, the two configs, the adapter, and the bilingual README move whole; `examples/` is deleted, and the tree's `package.json` goes with it because a corpus directory is not a workspace member.

### What the rc.1 composition replaces

The retired `dsh-acp-demo` row was one plugin that assembled a spine and took config flags. The shipped profile composes each part as its own row, so [`cordis.yml`](../../../../snapshots/console/cordis.yml) states each part instead:

| The demo row did | The patch does |
|---|---|
| assembled agent spine, ACP bridge, JSONL persistence | the `acp` profile provides them; the patch restates persistence root and `compression: none` for the harvest |
| `skills: {enabled: false}`, `goals: false`, `toolJobs: false` | disables the tool rows themselves — bash, pwsh, fs, fs-search, str-replace-editor, jobs, skill, goal, todo, web, workflow, ralph, the four subagent rows, and plan-mode |
| `workspaceContext: false` | disables `agent-instructions` |
| `persona:` | the base `system-prompt` row's `persona` |
| named the projection and command registries | the base bundle already mounts both |

What survives unchanged is the offer: the model is handed exactly `show_chart` and `show_component`, which is what keeps an upstream edit to any other tool's description out of this lane's pin. The remaining rows — the DeepSeek adapter, `content-surface`, `host-webserver` on an OS-assigned port, the auth gate, the chart tool's one-second verdict deadline, and the component tool with its catalog and its configured `views` entry — are stated as before.

The four experimental plugins the patch names become `apps/cli` devDependencies, beside `dsh-host-webserver` and the agent-team rows already there. The profile loader mirrors the dsh installation's dependency closure into `$DSH_HOME/profiles/node_modules`, so that manifest is how a patch reaches a plugin the CLI does not ship — the same route `snapshots/acp` uses for its hook rows.

Scenario metadata moves out of the adapter into a per-scenario `snapshot.yml`, read through `parseSnapshotManifest` the way `snapshots/acp` reads its own. `input.json` stays: it is the ACP protocol script, the suite factory reads it and its fixture guard requires it, and the corpus gate asserts it exists for exactly the ACP-driven lanes. Only the dynamic values stay in the adapter — the fake backend's base and the two ports the token-posting scenarios bind, which are chosen at collection time and cannot be written down.

### What the fixture refresh changed

`DSH_SNAPSHOT=refresh` over the committed model scripts, keyless. Every fixture diff falls in one of four classes, and none of them is a behaviour change:

| Class | What moved | Where |
|---|---|---|
| Pure relocation | Nothing at all: every `input.json` is byte-identical, and so are the header pin's `system-prompt.expected.md` and `tool-schemas.expected.json` | all eleven scenarios |
| Kit normalization | Raw UUIDs become typed `{{session:N}}` / `{{message:N}}` tokens; `sourceEventSeqs` collapse to ranges | every `session.jsonl` |
| Shipped-profile composition | The `permission/preset`, `sandbox/mode` and `approval/policy` events the profile's sandbox and permission rows write at session start, and the file-policy paragraph the runtime-context message carries with them | every `session.jsonl` |
| rc.1 ACP protocol | `tool_call` and `tool_call_update` frames, `mcpCapabilities`, `sessionCapabilities`, the `newSession` model `configOptions`, and the agent message's `messageId` | every `stdout.expected.jsonl` |

The byte-identical header pin is the load-bearing result: it is the evidence that a patch over the shipped profile composes the same model-visible surface a hand-rolled demo spine did. Every tool-call argument and every tool-result text survives byte for byte too — `show_component`'s `dataSource` paragraph with its `gridItems`-may-be-omitted sentence and `page.currentPage`, the `show-default-columns-turn` approval card that names no column, its result line ending `Page 1 of 1.`, and `empty-datasource-turn`'s zero-rows sentence all read exactly as they did.

The old fixtures were not the normalization fixed points the corpus gate requires, because they predate both the typed-identity tokens and the range collapse. That is the reason the refresh was required rather than optional.

### What the corpus gate now guards

[`scripts/session-snapshot-corpus.corpus.ts`](../../../../scripts/session-snapshot-corpus.corpus.ts) reserves the `*.snapshot.ts` suffix for a named list of adapters and walks `snapshots/` to enforce it, so the lane had to be registered there or the gate would fail on its adapter alone.

Registering it means the gate now reads all eleven `snapshot.yml` files: each declares its scenario name, its profile, its composition, its recording policy, and its header class; exactly one scenario per composition-and-class pins the header; the pin's two sidecars exist; every `session.jsonl` is a typed-identity fixed point with its system prompt and tool schemas scrubbed to tokens; and `input.json` is present because the lane is ACP-driven.

That last check keyed on the corpus directory name, which no longer determines the profile. A `profileByLane` table now maps each directory to the profile its scenarios declare — `console` rides `acp` the way `session` rides `headless` — and the input and transcript assertions consult that profile instead of the directory.

## Alternatives considered

**Keep the tree at `examples/` and add it to a vitest config.** Rejected: `snapshots/AGENTS.md` owns recorded-session tests and the corpus gate only walks `snapshots/`, so the lane would run without being gated — the same silent decay in a new form. `examples/` also has no other occupant on this root; keeping it for one tree preserves a convention the root retired.

**Delete the lane.** Rejected: it is the only assembled-transcript evidence for either tool's description, its catalog, its parameters, and its result text. The Playwright lane proves what a browser draws and the package suites prove each branch, but neither shows what the model was actually handed.

**Fold the scenarios into `snapshots/acp/`.** Rejected: they compose a different patch and therefore a different header class. The acp lane's base patch is the shipped coding spine with bash, filesystem, and subagent tools; the console's is the opposite of it, and merging them would put two unrelated compositions under one directory whose readers expect one.

**Revive an `acp-demo`-shaped bin so the adapter keeps its entrypoint.** Rejected: `snapshots/AGENTS.md` forbids another application entrypoint, hidden CLI mode, or executable scenario driver, and the demo bin is exactly what that rule names. Composing the shipped profile is also what makes the lane's evidence about the shipped product.

**Make `snapshots/console/` a pnpm workspace member with its own `package.json`, so the patch's plugin names resolve from a local `node_modules`.** Rejected: the profile loader already resolves plugin names from the dsh installation's closure, which is why `dsh-host-webserver` and the agent-team plugins are `apps/cli` devDependencies today. A manifest tier under `snapshots/` would add a second resolution path for one directory and put a package manifest in a corpus tree that has none.

**Disable the profile's sandbox and permission rows so the session logs stay identical to the old ones.** Rejected: that trades a real property of the composition under test for fixture cosmetics. The console runs on a profile with a file sandbox, and a lane whose logs hide that is describing a composition nobody ships.

**Drop `input.json` per the one-shot rule in `snapshots/AGENTS.md`.** Rejected: that rule addresses a one-shot case whose user task and replay script are derivable from the session log. An ACP scenario's `input.json` is neither — it is the protocol script, carrying the initialize and newSession steps and the permission answers, and the corpus gate asserts its presence for ACP-driven lanes precisely because it is not a duplicate.

## Consequences

The console's model-visible surface is gated again. An edit to either tool's description, to the component catalog spliced into it, to a parameter description, or to `content-surface`'s prompt section now lands as a reviewed fixture diff in the required snapshot lane instead of reaching a model unnoticed — which is what the lane was built for and what it had stopped doing.

`pnpm run lint` is green for the first time on this root. The two standing errors were not a defect in the adapter: the file matched the type-aware `examples/**` oxlint override while sitting outside every tsconfig program, so `@deepseek-ai/dsh-session-snapshot` resolved as an `error` type and every use of it was reported unsafe. Under `snapshots/` no type-aware override matches, exactly as for `snapshots/acp/acp.snapshot.ts`, and the dead `examples/**` globs are gone from `.oxlintrc.json` along with the one override that existed only for them.

The cost is that the lane's session fixtures now carry the shipped profile's permission and sandbox events and the file-policy paragraph that comes with them. Those are three rows the console does not care about, and an upstream edit to that paragraph will churn eleven session logs. The header pin — the part that describes the console — is insulated from it, because the tool rows are disabled per row rather than left to a spine flag.

`examples/` is deleted. Its two `.gitignore` patterns and six `.oxlintrc.json` globs go with it, and `docs/AGENTS.md` loses the budget line for an `examples/AGENTS.md` that this root never had.

## Testing

`pnpm run test:snapshot snapshots/console`: eleven scenarios and seven fixture guards, all passing, keyless. The lane discriminates: changing one word of `show_component`'s description in `packages/experimental/component-surface` fails all eleven, because every classmate's composed request header is compared against the pin, and each failure names the changed sentence. Reverting restores them.

`pnpm vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts`, `pnpm run lint`, `pnpm run verify-cordis-config`, `pnpm run doc-sync`, `pnpm run hygiene`, and `pnpm run build` are green.
