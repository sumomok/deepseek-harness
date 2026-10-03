/**
 * The packaging check on the staged server's LibreOffice kit: a kit whose
 * engines for both desktop targets `ENGINE_DOWNLOADS` registers passes, and a
 * kit that declares another version, cannot be read, or resolves from outside
 * the staged tree stops the run. Each case builds its own staged closure in a
 * temporary directory.
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyStagedOfficeEngines } from '../scripts/office-engine-gate.ts'

/** The kit's entry package; its engines are `<entry>-<target>`. */
const KIT = '@deepseek-ai/libreoffice-kit'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A fresh temporary directory, removed after the case.
 * @returns its path.
 */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-engine-gate-'))
  roots.push(root)
  return root
}

/**
 * Write one package manifest.
 * @param dir - the package directory, created when absent.
 * @param manifest - the manifest's fields.
 */
function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

/**
 * The kit's manifest, declaring one engine version for both desktop targets.
 * @param version - the engine version declared.
 * @returns the manifest's fields.
 */
function kitManifest(version: string): Record<string, unknown> {
  return { name: KIT, version, optionalDependencies: { [`${KIT}-darwin-arm64`]: version, [`${KIT}-win32-x64`]: version } }
}

/**
 * A hoisted staged closure: the three packages the server reaches the kit
 * through, and the kit itself.
 * @param version - the engine version the kit declares.
 * @returns the closure's `node_modules`.
 */
function stagedClosure(version: string): string {
  const modules = join(scratch(), 'node_modules')
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-office-to-pdf']) {
    writeManifest(join(modules, name), { name, version: '0.0.0' })
  }
  writeManifest(join(modules, KIT), kitManifest(version))
  return modules
}

/**
 * The message the check throws for a closure.
 * @param modules - the closure's `node_modules`.
 * @returns the error message, or undefined when the check passed.
 */
function refusal(modules: string): string | undefined {
  try {
    verifyStagedOfficeEngines(modules)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

describe('verifyStagedOfficeEngines', () => {
  it('passes a kit whose engines are registered for both desktop targets, at every registered kit version', () => {
    for (const version of ['0.1.1', '0.1.3', '0.1.5']) {
      expect(verifyStagedOfficeEngines(stagedClosure(version))).toEqual([`${KIT}-darwin-arm64@${version}`, `${KIT}-win32-x64@${version}`])
    }
  })

  it('stops the run when the kit declares an engine version the table does not register, naming the version and each missing entry', () => {
    expect(refusal(stagedClosure('0.2.0'))).toBe([
      'package: the staged server\'s LibreOffice kit declares engines the desktop cannot offer:',
      `  darwin-arm64: the kit declares 0.2.0, and ENGINE_DOWNLOADS has no ${KIT}-darwin-arm64@0.2.0`,
      `  win32-x64: the kit declares 0.2.0, and ENGINE_DOWNLOADS has no ${KIT}-win32-x64@0.2.0`,
    ].join('\n'))
  })

  it('stops the run when the kit manifest cannot be read', () => {
    const modules = stagedClosure('0.1.3')
    writeFileSync(join(modules, KIT, 'package.json'), '{ not json')
    const lines = refusal(modules)?.split('\n').slice(1) ?? []
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^ {2}darwin-arm64: the LibreOffice kit could not be read: /)
    expect(lines[1]).toMatch(/^ {2}win32-x64: the LibreOffice kit could not be read: /)
  })

  it('stops the run when the kit resolves from outside the staged tree, even at a registered version', () => {
    const modules = stagedClosure('0.1.3')
    const elsewhere = join(scratch(), KIT)
    writeManifest(elsewhere, kitManifest('0.1.3'))
    rmSync(join(modules, KIT), { recursive: true, force: true })
    // A junction on Windows, which needs no symlink privilege; ignored elsewhere.
    symlinkSync(elsewhere, join(modules, KIT), 'junction')
    expect(refusal(modules)).toBe([
      'package: the staged server\'s LibreOffice kit declares engines the desktop cannot offer:',
      `  ${KIT} resolves to ${realpathSync(join(elsewhere, 'package.json'))}, outside the staged ${modules}`,
    ].join('\n'))
  })
})
