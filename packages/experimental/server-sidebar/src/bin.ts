/**
 * One-time CLI over `nav-snapshot-migration.ts`: rewrites a settings
 * document's pre-view `navSnapshot: string[]` workflows to the
 * `{kind, entryId}[]` form the current schema accepts, and writes the empty
 * `groups` list the current format carries when the document has none.
 *
 * Run it against the document the settings file provider serves — normally
 * `$DSH_HOME/settings.yaml`, or whatever `path` that row configures:
 *
 * ```sh
 * pnpm --filter @deepseek-ai/dsh-experimental-server-sidebar run convert-nav-snapshot ~/.dsh/settings.yaml --dry-run
 * pnpm --filter @deepseek-ai/dsh-experimental-server-sidebar run convert-nav-snapshot ~/.dsh/settings.yaml
 * ```
 *
 * The path is required rather than defaulted: a converter that guesses which
 * document it is rewriting is one that can rewrite the wrong one. Everything
 * this file does beyond reading `argv` and printing lives in
 * `nav-snapshot-migration.ts`, which is where its tests are.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/bin
 */

import { changedAnything, convertSettingsFile } from './nav-snapshot-migration.ts'

const USAGE = 'usage: convert-nav-snapshot <settings file> [--dry-run]'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const [filename, ...rest] = argv.filter(argument => argument !== '--dry-run')

if (filename === undefined || rest.length > 0) {
  console.error(USAGE)
  process.exitCode = 2
} else {
  const outcome = await convertSettingsFile(filename, { dryRun })
  if (!changedAnything(outcome)) {
    console.log(`${filename}: already in the current format`)
  } else {
    const parts = [`${String(outcome.converted)} workflow(s) converted`]
    if (outcome.groupsSeeded) parts.push('groups list added')
    console.log(`${filename}: ${parts.join(', ')}${dryRun ? ' (--dry-run, nothing written)' : ''}`)
  }
}
