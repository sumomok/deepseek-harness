/**
 * The platform-split directories each desktop payload keeps, and the Office
 * engines none of them carries.
 *
 * `package.ts` applies these rules while it copies the staged server into each
 * target's payload, and `payload-gate.ts` checks them against the staged tree.
 * They live apart from the pipeline because `package.ts` runs the build when it
 * is imported, and the table is what the tests have to read.
 * @module
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlatformDirRule } from './payload-gate.ts'

/** The payloads the pipeline derives, one per packaged platform. */
export type PayloadTarget = 'darwin' | 'win'

/** The LibreOffice kit's entry package; its engines are the packages named `<entry>-<suffix>`. */
export const OFFICE_KIT = '@deepseek-ai/libreoffice-kit'

/**
 * Whether a package is one of the LibreOffice kit's engines, which no desktop
 * payload carries.
 *
 * The desktop ships no Office preview: its composition layer disables the
 * `office-to-pdf` row, the one Host entry that would start a converter. The
 * kit's entry package stays, because `@deepseek-ai/dsh-office-to-pdf` imports
 * it statically and the kit resolves an engine only when a converter is
 * created. Each engine is a whole LibreOffice build of well over a hundred
 * megabytes.
 * @param name - a scoped package name.
 * @returns true for `@deepseek-ai/libreoffice-kit-<suffix>`, false for the entry package and everything else.
 */
export function isOfficeEngine(name: string): boolean {
  return name.startsWith(`${OFFICE_KIT}-`)
}

/**
 * The engine packages the staged kit declares, which the finished payloads
 * must not hold at any depth.
 * @param staged - the staged server root.
 * @returns every `optionalDependencies` name of the staged kit that names an engine; empty when no kit is staged.
 */
export async function officeEnginePackages(staged: string): Promise<string[]> {
  const manifest = join(staged, 'node_modules', OFFICE_KIT, 'package.json')
  if (!existsSync(manifest)) return []
  const { optionalDependencies } = JSON.parse(await readFile(manifest, 'utf8')) as { optionalDependencies?: Record<string, string> }
  return Object.keys(optionalDependencies ?? {}).filter(isOfficeEngine).sort()
}

/**
 * Platform-split artifact directories, relative to node_modules: keep only the
 * target's. Both lists must name the same parents wherever a family has members
 * built for both: a parent listed for one target only leaves the other payload
 * carrying binaries it cannot run.
 *
 * `@vscode` is the scope, not `@vscode/ripgrep`. The binaries live in sibling
 * packages (`@vscode/ripgrep-<platform>-<arch>`) that `lib/index.js` resolves at
 * call time; `@vscode/ripgrep` itself publishes no `bin/`, so a rule addressed
 * at it matches nothing and both payloads kept both platforms' `rg`.
 *
 * `@deepseek-ai` drops the Office engines ([[isOfficeEngine]]) on both targets,
 * the host's own included, and on `win` also the `node-addon-system` family.
 * That family publishes no win32 member, and on Windows the entry package never
 * resolves one: `flock` throws `ERR_FLOCK_UNSUPPORTED_PLATFORM` ahead of
 * resolution, and `launcherPath` returns a path that does not exist, which
 * `probe` reports as unusable exactly as an unenforcing kernel does. The win
 * rule therefore drops every `node-addon-system-` directory; the trailing `-`
 * keeps the entry package `@deepseek-ai/node-addon-system` itself, which is the
 * plain JavaScript both call sites live in. The darwin rule keeps that family
 * whole: a macOS host installs only `node-addon-system-darwin-<arch>`, which is
 * the one variant the macOS payload must carry.
 *
 * `verifyPruneRules` fails the build for a rule that drops nothing, which is
 * what a rule addressed at the wrong directory looks like from the outside.
 * @param arch - the `process.arch` of the host building the macOS payload, which is the architecture it runs on.
 * @returns each target's rules.
 */
export function platformDirRules(arch: string): Record<PayloadTarget, PlatformDirRule[]> {
  const shipsFromDeepseek = (name: string): boolean => !isOfficeEngine(`@deepseek-ai/${name}`)
  return {
    win: [
      { parent: join('node-pty', 'prebuilds'), keep: name => name === 'win32-x64' },
      { parent: '@deepseek-ai', keep: name => shipsFromDeepseek(name) && !name.startsWith('node-addon-system-') },
      { parent: '@img', keep: name => !name.includes('darwin') && !name.includes('linux') },
      { parent: '@koromix', keep: name => !name.startsWith('koffi-') || name === 'koffi-win32-x64' },
      { parent: '@vscode', keep: name => !name.startsWith('ripgrep-') || name === 'ripgrep-win32-x64' },
      { parent: '.', keep: name => !name.startsWith('node-addon-require-builtin-') || name === 'node-addon-require-builtin-win32-x64-msvc' },
    ],
    darwin: [
      { parent: join('node-pty', 'prebuilds'), keep: name => name === `darwin-${arch}` },
      { parent: '@deepseek-ai', keep: shipsFromDeepseek },
      { parent: '@img', keep: name => !name.includes('win32') && !name.includes('linux') },
      { parent: '@koromix', keep: name => !name.startsWith('koffi-') || name === `koffi-darwin-${arch}` },
      { parent: '@vscode', keep: name => !name.startsWith('ripgrep-') || name === `ripgrep-darwin-${arch}` },
      { parent: '.', keep: name => !name.startsWith('node-addon-require-builtin-') || name.startsWith(`node-addon-require-builtin-darwin-${arch}`) },
    ],
  }
}
