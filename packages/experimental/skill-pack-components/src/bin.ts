/**
 * Write the component catalog file, `tests/expected/component-catalog.json`,
 * from the catalog this tree registers:
 *
 * ```sh
 * pnpm --filter @deepseek-ai/dsh-experimental-skill-pack-components run component-catalog
 * ```
 *
 * Everything the file says is built in `component-catalog.ts`, where its
 * tests are; this file reads the installed package versions, writes the text
 * and prints where it went.
 * @module @deepseek-ai/dsh-experimental-skill-pack-components/bin
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { componentCatalogText, readComponentCatalogVersions } from './component-catalog.ts'

const target = fileURLToPath(new URL('../tests/expected/component-catalog.json', import.meta.url))
writeFileSync(target, componentCatalogText(readComponentCatalogVersions()))
console.log(`wrote ${target}`)
