/**
 * The desktop application's recorded-session suite: model-request and
 * session-log evidence for the rows `apps/desktop-app/cordis.patch.yml` adds
 * to a composition, driven through the shipped `dsh --profile acp` interface.
 *
 * The desktop profile itself (`desktop-shell`) is seeded by the Electron shell
 * into a user's home and composes the web bundle plus vendored third-party
 * plugins, so no shipped profile reproduces it. This lane instead applies the
 * desktop application's own patch file, unmodified, as the base patch over
 * `acp`, and this lane's `cordis.yml` on top of it; under replay the launcher
 * applies the base patch and the sibling `cordis.snapshot.yml`.
 * `dsh-session-snapshot`'s suite factory owns every compare and guard; this
 * file is the agent paths and the scenario table.
 *
 * Fixtures live under `snapshots/desktop/<name>/`;
 * `pnpm run test:snapshot:refresh snapshots/desktop` rewrites them keyless
 * from the committed model script. See this lane's README.
 * @module
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  parseSnapshotManifest,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-session-snapshot'

const corpusDir = fileURLToPath(new URL('./', import.meta.url))

/**
 * The shipped `dsh` CLI, the desktop application's patch as the base layer,
 * and the repo-root tsconfig — all absolute, because the subprocess cwd is a
 * temporary directory outside the repo.
 */
const AGENT = {
  binScript: fileURLToPath(new URL('../../apps/cli/src/bin.ts', import.meta.url)),
  configPath: fileURLToPath(new URL('../../apps/desktop-app/cordis.patch.yml', import.meta.url)),
  profile: 'acp',
  tsconfigPath: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
}

/** This lane's live patch, applied after the base patch outside replay. */
const LANE_PATCH = join(corpusDir, 'cordis.yml')

/**
 * Every scenario composes the same two patches, so they are one header class.
 * `session-query-turn` pins it: its `tool-schemas.expected.json` carries the
 * five `session_*` tools the desktop patch mounts, and its
 * `system-prompt.expected.md` carries their prior-history section. Its
 * session log carries one `session_event_read` call and the result the model
 * reads back.
 *
 * The scenario is `authored`: its model script is the committed
 * `replay.override.json`, which a live model would only reword. Refresh
 * replays it and needs no key.
 */
const CONTROLLER_CASES: readonly string[] = ['session-query-turn']

const SCENARIOS: Scenario[] = CONTROLLER_CASES.map((name) => {
  const manifestPath = join(corpusDir, name, 'snapshot.yml')
  const manifest = parseSnapshotManifest(readFileSync(manifestPath, 'utf8'), manifestPath)
  if (manifest.recording === undefined || manifest.header === undefined) {
    throw new Error(`${name}: desktop snapshot manifest lacks recording or header metadata`)
  }
  return {
    name,
    hasModelTurn: true,
    recorded: manifest.recording === 'live',
    headerClass: manifest.header.class,
    configPath: LANE_PATCH,
    ...(manifest.header.pin === true ? { pinsHeader: true } : {}),
    ...(manifest.replay?.override === true ? { overridden: true } : {}),
  }
})

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
  snapshotsDir: corpusDir,
  scenarios: SCENARIOS,
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
