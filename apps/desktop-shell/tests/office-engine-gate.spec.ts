/**
 * The packaging check on the staged server's LibreOffice kit: a kit that
 * declares, for both desktop targets, the engine version the package ships
 * and `ENGINE_DOWNLOADS` registers passes, and a kit that declares another
 * version or an unregistered one, cannot be read, or resolves from outside
 * the staged tree stops the run. Each case builds its own staged closure in a
 * temporary directory.
 * @module
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DESKTOP_ENGINE_HOSTS, verifyStagedOfficeEngines, type DesktopEngineHost } from '../scripts/office-engine-gate.ts'

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
 * @param hosts - the hosts and shipped versions to check; the package run's own table when omitted.
 * @returns the error message, or undefined when the check passed.
 */
function refusal(modules: string, hosts: readonly DesktopEngineHost[] = DESKTOP_ENGINE_HOSTS): string | undefined {
  try {
    verifyStagedOfficeEngines(modules, hosts)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return undefined
}

/** The first line of every refusal. */
const HEADER = 'package: the staged server\'s LibreOffice kit does not declare the Office engines this package ships:'

describe('verifyStagedOfficeEngines', () => {
  it('ships engine 0.1.5 on both desktop hosts', () => {
    expect(DESKTOP_ENGINE_HOSTS).toEqual([
      { platform: 'darwin', arch: 'arm64', engineVersion: '0.1.5' },
      { platform: 'win32', arch: 'x64', engineVersion: '0.1.5' },
    ])
  })

  it('passes a kit that declares the version each desktop host ships, registered', () => {
    expect(verifyStagedOfficeEngines(stagedClosure('0.1.5'))).toEqual([`${KIT}-darwin-arm64@0.1.5`, `${KIT}-win32-x64@0.1.5`])
  })

  it('stops the run when the kit declares another registered version, naming the declared version, the shipped one, and where it is set', () => {
    for (const version of ['0.1.1', '0.1.3']) {
      expect(refusal(stagedClosure(version)), version).toBe([
        HEADER,
        `  darwin-arm64: the kit declares ${version}, and this package ships 0.1.5 (DESKTOP_ENGINE_HOSTS in scripts/office-engine-gate.ts)`,
        `  win32-x64: the kit declares ${version}, and this package ships 0.1.5 (DESKTOP_ENGINE_HOSTS in scripts/office-engine-gate.ts)`,
      ].join('\n'))
    }
  })

  it('stops the run when the kit declares the version a host ships and the table does not register it, naming each missing entry', () => {
    const hosts = [{ platform: 'darwin', arch: 'arm64', engineVersion: '0.2.0' }, { platform: 'win32', arch: 'x64', engineVersion: '0.2.0' }] as const
    expect(refusal(stagedClosure('0.2.0'), hosts)).toBe([
      HEADER,
      `  darwin-arm64: the kit declares 0.2.0, and ENGINE_DOWNLOADS has no ${KIT}-darwin-arm64@0.2.0`,
      `  win32-x64: the kit declares 0.2.0, and ENGINE_DOWNLOADS has no ${KIT}-win32-x64@0.2.0`,
    ].join('\n'))
  })

  it('names both problems when the kit declares a version that is neither shipped nor registered', () => {
    expect(refusal(stagedClosure('0.2.0'))?.split('\n').slice(1, 3)).toEqual([
      '  darwin-arm64: the kit declares 0.2.0, and this package ships 0.1.5 (DESKTOP_ENGINE_HOSTS in scripts/office-engine-gate.ts)',
      `  darwin-arm64: the kit declares 0.2.0, and ENGINE_DOWNLOADS has no ${KIT}-darwin-arm64@0.2.0`,
    ])
  })

  it('stops the run when the kit manifest cannot be read', () => {
    const modules = stagedClosure('0.1.5')
    writeFileSync(join(modules, KIT, 'package.json'), '{ not json')
    const lines = refusal(modules)?.split('\n').slice(1) ?? []
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^ {2}darwin-arm64: the LibreOffice kit could not be read: /)
    expect(lines[1]).toMatch(/^ {2}win32-x64: the LibreOffice kit could not be read: /)
  })

  it('stops the run when the kit resolves from outside the staged tree, even at the shipped version', () => {
    const modules = stagedClosure('0.1.5')
    const elsewhere = join(scratch(), KIT)
    writeManifest(elsewhere, kitManifest('0.1.5'))
    rmSync(join(modules, KIT), { recursive: true, force: true })
    // A junction on Windows, which needs no symlink privilege; ignored elsewhere.
    symlinkSync(elsewhere, join(modules, KIT), 'junction')
    expect(refusal(modules)).toBe([
      HEADER,
      `  ${KIT} resolves to ${realpathSync(join(elsewhere, 'package.json'))}, outside the staged ${modules}`,
    ].join('\n'))
  })
})
