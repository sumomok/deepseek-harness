# console

English | [中文](README.zh.md)

The console's backend spine under the ACP automation transport: the composition that carries every console row a recorded transcript can observe, and none that only paint a browser.

[`cordis.yml`](cordis.yml) patches the shipped `acp` profile. Stated here: the DeepSeek adapter, raw-JSONL persistence, the console persona, [`content-surface`](../../packages/experimental/content-surface/README.md) (the content column as one per-session entry stream, which contributes a system-prompt section), [`host-webserver`](../../packages/host/webserver/README.md) on an OS-assigned port, the [`auth-gate`](../../packages/experimental/auth-gate/README.md) that holds a visitor's access token and names the backend it may be spent on, and the two tools that place an entry in that column — [`show_chart`](../../packages/experimental/vue2-echarts-tool-poc/README.md) and [`show_component`](../../packages/experimental/component-surface/README.md). The projection registry and the command registry `show_component`'s description promises a press comes back through are already in the base bundle.

Absent by construction: `server-layout`, `content-column`, `server-sidebar`, the Vue chart row, and the component row that draws a placed block. They register no tool, no prompt section, and no session event, so a transcript cannot tell them from their own absence; their evidence is the Playwright lane under [`apps/web/tests`](../../apps/web/tests). Every other tool family the base bundle offers is disabled row by row for the same reason in reverse — bash, filesystem, skill, goal, background job, subagent, workflow, todo, web, and plan are real but not the console's, and leaving them on would churn this lane's pinned header on every upstream edit to their descriptions. What the model is offered here is exactly `show_chart` and `show_component`.

No browser attaches to an ACP process, and neither tool needs one to settle. `show_chart` waits out its verdict deadline and answers unverified — that is the behavior under test, since the deadline is quoted verbatim in the model-facing result line, and this composition sets it to one second because the lane pays it in real time on every call. `show_component` judges its call against the catalog and answers immediately; what a placed block looks like is the browser lane's question, and what the model was offered and told is this one's.

The `show_component` row also carries a `views` entry — a view this deployment wrote rather than one a model places. Nothing about it reaches a transcript: `show-content-view` is a command, and this transport has no method to invoke one. What it is here for is the boot. A configured view is judged at load by the same pass that judges a call, so a spec written by a person that the tool would refuse stops this composition from coming up at all, and every scenario below is that check having passed.

## Snapshot scenarios

[`console.snapshot.ts`](console.snapshot.ts) is the scenario table over the [`dsh-session-snapshot`](../../packages/test-support/session-snapshot/README.md) suite factory, plus the fake data backend the data-source scenarios read. Eleven scenarios compose the same `cordis.yml`, so they are one header class that `show-chart-turn` pins for all of them:

| Scenario | What it exercises |
|---|---|
| `show-chart-turn` | A bar chart, and the header pin for the whole class |
| `show-component-turn` | The component that asks a question |
| `show-record-turn` | The component that only displays |
| `show-table-turn` | The component whose properties nest a column list inside a configuration object |
| `show-filter-turn` | The component whose properties are an attribute table and a narrowed list of match strategies |
| `show-view-turn` | Two blocks arranged by `layout`, the second bound to the first with `$from` |
| `reject-view-turn` | A layout naming a block the call never placed, and the sentence naming the path to fix |
| `show-datasource-turn` | A read of the deployment's own data: the question, the rows, and the result line counting them |
| `refuse-datasource-turn` | The same question answered `reject_once`: no event, no entry, no read |
| `show-default-columns-turn` | A call naming no columns, drawn in the ones the deployment's default query scheme chose |
| `empty-datasource-turn` | A filtered read that matched nothing, which is zero rows rather than an unreachable source |

Each scenario owns these fixtures:

| Fixture | What it holds |
|---|---|
| `snapshot.yml` | The profile, composition, header class, and recording policy the corpus gate reads |
| `input.json` | The ACP protocol script: the initialize/newSession/prompt steps and any permission answers |
| `session.jsonl` | The persisted log — replay input and expected output at once, including the arguments the call recorded and the result text the model reads back |
| `stdout.expected.jsonl` | The ACP JSON-RPC the client sees |
| `tool-schemas.expected.json` | Both tools whole — each description, the deployment ceilings and the component catalog quoted into those descriptions, and every parameter description. Owned by `show-chart-turn` and read for the whole class |
| `system-prompt.expected.md` | The assembled prompt, including `content-surface`'s on-display section. Owned by `show-chart-turn` |

Every scenario is `authored`, not `live`: no browser can answer this composition, so the live API would only re-decide which chart or which wording the model sends, never which code path the fixture exercises.

## Running

| Command | What it does |
|---|---|
| `pnpm run test:snapshot -t show-chart-turn` | Replays one scenario. Keyless |
| `pnpm run test:snapshot snapshots/console` | Replays the whole lane and its fixture guards. Keyless |
| `pnpm run test:snapshot:refresh snapshots/console` | Replays the committed model scripts and rewrites stdout, the session logs, and the two owned sidecars. Keyless; review every diff |
| `pnpm vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts` | The corpus gate over every lane's manifests, ownership, and normalization fixed points |

No recording step exists for this lane, because no scenario is `live`. A key-holder who wants a live transcript sets one `snapshot.yml` to `recording: live` and runs `pnpm run test:snapshot:record -t <name>`; that is the only path that reads `DEEPSEEK_API_KEY`.

## Runtime environment

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Credential for the DeepSeek adapter; record mode only |
| `DEEPSEEK_BASE_URL` | Host endpoint used by `dsh-llm-deepseek` |
| `DSH_SNAPSHOT` | `replay`, `record`, or `refresh`; also selects raw JSONL persistence |
| `DSH_SNAPSHOT_SESSIONS_ROOT` | Session directory the snapshot harness harvests |
| `DSH_CONSOLE_BIZ_UPSTREAM` | Base of the data backend the gate spends a token on; the suite points it at the fake backend it starts |
| `DSH_CONSOLE_HTTP_PORT` | Port the composition's HTTP host binds, for the scenarios that post a token to the gate themselves |
