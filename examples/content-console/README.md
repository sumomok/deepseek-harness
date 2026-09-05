# content-console

English | [中文](README.zh.md)

The console's backend spine under the ACP automation transport: the composition that carries every console row a recorded transcript can observe, and none that only paint a browser.

Composed here: the DeepSeek adapter, the ACP automation app, the projection registry, [`content-surface`](../../packages/experimental/content-surface/README.md) (the content column as one per-session entry stream, which contributes a system-prompt section), [`host-webserver`](../../packages/host/webserver/README.md) on an OS-assigned port, the command registry `show_component`'s description promises a press comes back through, and the two tools that place an entry in that column — [`show_chart`](../../packages/experimental/vue2-echarts-tool-poc/README.md) and [`show_component`](../../packages/experimental/component-surface/README.md).

Absent by construction: `server-layout`, `content-column`, `server-sidebar`, the Vue chart row, and the component row that draws a placed block. They register no tool, no prompt section, and no session event, so a transcript cannot tell them from their own absence; their evidence is the Playwright lane under [`apps/web/tests`](../../apps/web/tests). The spine's own skill, goal, and background-job tools are switched off for the same reason in reverse — they are real but not the console's, and leaving them on would churn this example's pinned header on every upstream edit to their descriptions.

No browser attaches to an ACP process, and neither tool needs one to settle. `show_chart` waits out its verdict deadline and answers unverified — that is the behavior under test, since the deadline is quoted verbatim in the model-facing result line, and this composition sets it to one second because the lane pays it in real time on every call. `show_component` judges its call against the catalog and answers immediately; what a placed block looks like is the browser lane's question, and what the model was offered and told is this one's.

The `show_component` row also carries a `views` entry — a view this deployment wrote rather than one a model places. Nothing about it reaches a transcript: `show-content-view` is a command, and this transport has no method to invoke one. What it is here for is the boot. A configured view is judged at load by the same pass that judges a call, so a spec written by a person that the tool would refuse stops this composition from coming up at all, and every scenario below is that check having passed.

## Snapshot scenarios

[`tests/content-console.snapshot.ts`](tests/content-console.snapshot.ts) is the scenario table over the [`dsh-acp-snapshot`](../../packages/test-support/acp-snapshot/README.md) suite factory. `show-chart-turn` prompts for a bar chart, `show-component-turn` prompts for a confirmation bar, and because both compose the same file they are one header class that the first pins for both:

| Fixture | What it holds |
|---|---|
| `tool-schemas.expected.json` | Both tools whole — each description, the deployment ceilings and the component catalog quoted into those descriptions, and every parameter description. Owned by `show-chart-turn` and read by both scenarios |
| `system-prompt.expected.md` | The assembled prompt, including `content-surface`'s on-display section |
| `stdout.expected.jsonl` | The ACP JSON-RPC the client sees |
| `session.jsonl` | Each scenario's own persisted log, including the arguments its call recorded and the result text the model reads back |

Both scenarios are `authored`, not `recorded`: no browser can answer this composition, so the live API would only re-decide which chart or which wording the model sends, never which code path the fixture exercises. The root `test:snapshot` scripts run every suite, so address this one through vitest directly — the first line replays it keyless, the second rewrites every generated fixture from the committed model script, also keyless.

```sh
pnpm exec vitest run --config vitest.snapshot.config.ts examples/content-console
DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts examples/content-console
```

To take a live transcript instead, set `recorded: true` on a scenario and record with `DEEPSEEK_API_KEY` in the environment or the gitignored root `.env`: `DSH_SNAPSHOT=record pnpm exec vitest run --config vitest.snapshot.config.ts --update examples/content-console`.

## Runtime environment

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Credential for the DeepSeek adapter; record mode only |
| `DEEPSEEK_BASE_URL` | Host endpoint used by `dsh-llm-deepseek` |
| `DSH_SNAPSHOT` | `replay`, `record`, or `refresh`; also selects raw JSONL persistence |
| `DSH_SNAPSHOT_SESSIONS_ROOT` | Session directory the snapshot harness harvests |
