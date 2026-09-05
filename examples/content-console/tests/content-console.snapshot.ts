import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-acp-snapshot'

/**
 * The content-console example's snapshot suite: the assembled evidence for the
 * console's model-visible surface. `dsh-acp-snapshot`'s suite factory owns every
 * compare/guard mechanic; this file is the scenario table and the agent paths.
 *
 * What the pin covers is the point of the lane. `tool-schemas.expected.json`
 * carries both tools whole — each description, the deployment bounds and the
 * component catalog quoted into those descriptions, and every parameter
 * description — and `system-prompt.expected.md` carries `content-surface`'s
 * on-display section, so an edit to any of it shows up as a reviewed fixture
 * diff instead of reaching a model unnoticed. `stdout.expected.jsonl` and
 * `session.jsonl` carry the arguments each call recorded and the result text the
 * model reads back.
 *
 * Fixtures live under `snapshots/<name>/`; `pnpm run test:snapshot:refresh`
 * rewrites them keyless from the committed model script. See the suite kit's
 * README (packages/test-support/acp-snapshot) and this example's README for the
 * record path.
 */

// The dsh-acp-demo bin (the demo:acp entry), this example's cordis.yml, and the
// repo-root tsconfig (three levels up from examples/content-console/tests) —
// all ABSOLUTE: the subprocess cwd is a temp dir outside the repo.
const AGENT = {
  binScript: fileURLToPath(new URL('../../../packages/examples/acp-demo/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
  tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}

/**
 * Every scenario composes the same cordis.yml, so they are one header class and
 * `show-chart-turn` pins it for all of them: its `tool-schemas.expected.json`
 * carries every tool the console offers, `show_component` included, and its
 * `system-prompt.expected.md` carries the composed prompt. Each scenario still
 * owns its own stdout and session log, which is where a tool's result text is.
 *
 * The `show_component` scenarios are one per component whose arguments are a
 * shape of their own, because what a placed block costs a model is the arguments
 * it has to get right: `show-component-turn` places the one that asks a
 * question, `show-record-turn` the one that only displays, `show-table-turn` the
 * one whose properties nest a column list inside a configuration object and
 * whose rows are records the model chooses the field names of, and
 * `show-filter-turn` the one whose properties are an attribute table and a
 * narrowed list of match strategies. The metric ball has no scenario: its
 * properties are seven scalars, which the description already states and no
 * other scenario would exercise differently.
 *
 * What none of them carries is a gesture. `/component-action` reaches the host
 * through `remote.commands` and the ACP protocol has no command method, so this
 * lane pins the placement and the description that promises a gesture comes
 * back, and `apps/web/tests/component-surface.e2e.ts` pins the gesture itself
 * against a real browser and the shipped bundles.
 *
 * `recorded: false` on all of them because no browser can answer this
 * composition under ACP: a chart's verdict deadline always lapses and a placed
 * block is never looked at, so the live API would only re-decide which chart or
 * which wording the model sends, never which code path the fixture exercises. A
 * key-holder who wants a live transcript flips one to `true` and runs
 * `pnpm run test:snapshot:record -t <name>`.
 */
const SCENARIOS: Scenario[] = [
  { name: 'show-chart-turn', hasModelTurn: true, recorded: false, pinsHeader: true },
  { name: 'show-component-turn', hasModelTurn: true, recorded: false },
  { name: 'show-record-turn', hasModelTurn: true, recorded: false },
  { name: 'show-table-turn', hasModelTurn: true, recorded: false },
  { name: 'show-filter-turn', hasModelTurn: true, recorded: false },
]

/**
 * Map `$DSH_SNAPSHOT` onto the factory's mode.
 * @param value The raw environment value.
 * @returns The suite mode.
 */
function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

defineAcpSnapshotSuite({
  agent: AGENT,
  snapshotsDir: join(dirname(fileURLToPath(import.meta.url)), 'snapshots'),
  scenarios: SCENARIOS,
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
