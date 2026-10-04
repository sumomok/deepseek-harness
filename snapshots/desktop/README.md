# desktop

English | [中文](README.zh.md)

The desktop application's composition layer under the ACP automation transport: the rows [`apps/desktop-app/cordis.patch.yml`](../../apps/desktop-app/cordis.patch.yml) adds to a composition, as a model request and a session log record them.

The desktop's own profile, `desktop-shell`, is seeded by the Electron shell into a user's harness home and composes the web bundle plus vendored third-party plugins, so no shipped profile reproduces it. [`desktop.snapshot.ts`](desktop.snapshot.ts) therefore starts the shipped `acp` profile with the desktop application's patch file, unmodified, as the base patch, and this lane's [`cordis.yml`](cordis.yml) after it. A row the desktop adds or changes in that file reaches this lane's model requests without being copied here. A patch row that targets an id the `acp` profile does not compose, such as `vision-switch`, `llm-permission-gateway`, or the two product-analytics rows, is skipped by the loader.

[`cordis.yml`](cordis.yml) states only what a keyless, reproducible transcript needs on top of the base patch:

| Row | What this lane sets |
|---|---|
| `llm-deepseek` | The desktop's `retryPolicy` restated with a catalog that lists `deepseek-v4-flash`, the model the shipped `acp` row selects |
| `session-persistence-jsonl` | The harness's sessions root and raw JSONL under `DSH_SNAPSHOT`, which the harvest reads |
| `system-prompt` | A fixed persona |
| Every tool family of the base bundle, and `agent-instructions` | Disabled, so the model is offered exactly the five `session_*` tools and an upstream edit to another tool's description does not change this lane's pin |
| `desktop-brand` | Disabled: its prompt line quotes the harness home, a new temporary directory on every run, and its module is a build output the source tree does not install |
| `desktop-server-log` | Disabled, so a `DSH_DESKTOP_SERVER_LOG` value in the developer's environment cannot mount it |

Under replay the launcher applies the base patch and [`cordis.snapshot.yml`](cordis.snapshot.yml), not `cordis.yml`, so `cordis.snapshot.yml` restates every row of `cordis.yml` in the same order, disables the DeepSeek adapter, and inserts `llm-replay`, which serves the committed model script without a key or network.

## Snapshot scenarios

[`desktop.snapshot.ts`](desktop.snapshot.ts) is the scenario table over the [`dsh-session-snapshot`](../../packages/test-support/session-snapshot/README.md) suite factory. Every scenario composes the same two patches, so they are one header class, `desktop`.

| Scenario | What it exercises |
|---|---|
| `session-query-turn` | One `session_event_read` call on the session's own `permission/preset` event, then `DONE`, and the header pin for the class |

Each scenario owns these fixtures:

| Fixture | What it holds |
|---|---|
| `snapshot.yml` | The profile, composition, header class, and recording policy the corpus gate reads |
| `input.json` | The ACP protocol script: the initialize, newSession, and prompt steps |
| `replay.override.json` | The authored model script that replaces the script derived from the session log |
| `session.vN.jsonl` | The persisted log, which is replay input and expected output at once, including the `tool/call` and the `tool/result` text the model reads back |
| `stdout.expected.jsonl` | The ACP JSON-RPC the client sees |
| `tool-schemas.expected.json` | The five `session_*` tools whole, as the model request carries them. Owned by `session-query-turn` |
| `system-prompt.expected.md` | The assembled prompt, including the session-query prior-history section. Owned by `session-query-turn` |

`session-query-turn` is `authored`, not `live`: its model script is the committed `replay.override.json`, which a live model would only reword. The event it reads is the first event of every session, which carries no id or path, and the snapshot normalizer replaces the event time in the result text.

## Running

| Command | What it does |
|---|---|
| `pnpm run test:snapshot snapshots/desktop` | Replays the lane and its fixture guards. Keyless |
| `pnpm run test:snapshot:refresh snapshots/desktop` | Replays the committed model script and rewrites stdout, the session log, and the two owned sidecars. Keyless; review every diff |
| `pnpm vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts` | The corpus gate over every lane's manifests, ownership, and normalization fixed points |

No recording step exists for this lane, because no scenario is `live`. A key-holder who wants a live transcript sets one `snapshot.yml` to `recording: live`, removes its `replay.override.json` and the manifest's `replay.override`, and runs `pnpm run test:snapshot:record -t <name>`; that is the only path that reads `DEEPSEEK_API_KEY`.

## Runtime environment

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Credential for the DeepSeek adapter; record mode only |
| `DSH_SNAPSHOT` | `replay`, `record`, or `refresh`; also selects raw JSONL persistence |
| `DSH_SNAPSHOT_SESSIONS_ROOT` | Session directory the snapshot harness harvests |
| `DSH_SNAPSHOT_FILE`, `DSH_SNAPSHOT_OVERRIDE` | The selected session fixture and model-script override `llm-replay` reads; set by the harness |
