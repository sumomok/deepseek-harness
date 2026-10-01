/**
 * Which platform-split directories each desktop payload keeps, and how the
 * payload gate treats the LibreOffice engines no payload carries.
 * @module
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  snapshotPayload, verifyPrunedPayload, verifyPruneRules, type PayloadPlatform, type PlatformDirRule,
} from '../scripts/payload-gate.ts'
import {
  isOfficeEngine, namesWindowsX64, OFFICE_KIT, officeEnginePackages, pinnedVariantVersion, platformDirRules, type PayloadTarget,
} from '../scripts/platform-dir-rules.ts'
import { findWithheldDirectories } from '../scripts/staged-boot-gate.ts'

/** Every engine the kit publishes, as its 0.1.1 manifest declares them. */
const ENGINES = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'wasm'].map(suffix => `${OFFICE_KIT}-${suffix}`)

/** The machine each payload runs on, for a macOS host of `arch`. */
function runsOn(target: PayloadTarget, arch: string): PayloadPlatform {
  return target === 'win' ? { platform: 'win32', arch: 'x64' } : { platform: 'darwin', arch }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A staged server tree holding the given `node_modules` directories, with the
 * kit's entry manifest declaring every engine.
 * @param dirs - directories to create, relative to `node_modules`.
 * @returns the staged root.
 */
function staged(dirs: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'platform-dir-rules-'))
  roots.push(root)
  for (const dir of dirs) mkdirSync(join(root, 'node_modules', dir), { recursive: true })
  mkdirSync(join(root, 'node_modules', OFFICE_KIT), { recursive: true })
  const optionalDependencies = Object.fromEntries(ENGINES.map(name => [name, '0.1.1']))
  writeFileSync(join(root, 'node_modules', OFFICE_KIT, 'package.json'), JSON.stringify({ name: OFFICE_KIT, optionalDependencies }))
  return root
}

/**
 * Copy a staged tree the way `package.ts` derives a payload from it, rules only.
 * @param root - the staged root.
 * @param rules - the target's rules.
 * @returns the payload root and the `node_modules`-relative directories the rules dropped.
 */
function derive(root: string, rules: readonly PlatformDirRule[]): { payload: string; dropped: string[] } {
  const payload = mkdtempSync(join(tmpdir(), 'platform-dir-rules-payload-'))
  roots.push(payload)
  const prefix = join(root, 'node_modules') + sep
  const dropped: string[] = []
  cpSync(root, payload, {
    recursive: true,
    filter: (source) => {
      if (!source.startsWith(prefix)) return true
      const relative = source.slice(prefix.length)
      const parent = dirname(relative)
      const name = relative.slice(relative.lastIndexOf(sep) + 1)
      if (rules.some(rule => rule.parent === parent && !rule.keep(name))) {
        dropped.push(relative.split(sep).join('/'))
        return false
      }
      return true
    },
  })
  return { payload, dropped }
}

/** The platform-split families a macOS arm64 host stages, with both platforms' members where the pipeline fetches them. */
const MAC_HOST_STAGED = [
  'node-pty/prebuilds/darwin-arm64', 'node-pty/prebuilds/win32-x64',
  '@img/sharp-darwin-arm64', '@img/sharp-win32-x64',
  '@koromix/koffi-darwin-arm64', '@koromix/koffi-win32-x64',
  '@vscode/ripgrep', '@vscode/ripgrep-darwin-arm64', '@vscode/ripgrep-win32-x64',
  'node-addon-require-builtin-darwin-arm64', 'node-addon-require-builtin-win32-x64-msvc',
  '@deepseek-ai/node-addon-system', '@deepseek-ai/node-addon-system-darwin-arm64',
  'sherpa-onnx-node', 'sherpa-onnx-darwin-arm64', 'sherpa-onnx-win-x64',
  `${OFFICE_KIT}-darwin-arm64`,
]

describe('isOfficeEngine', () => {
  it('names every engine the kit publishes and not the kit itself', () => {
    for (const name of ENGINES) expect(isOfficeEngine(name)).toBe(true)
    expect(isOfficeEngine(OFFICE_KIT)).toBe(false)
    expect(isOfficeEngine('@deepseek-ai/dsh-office-to-pdf')).toBe(false)
  })
})

describe('officeEnginePackages', () => {
  it('reads the engines from the staged kit manifest', async () => {
    expect(await officeEnginePackages(staged([]))).toEqual([...ENGINES].sort())
  })

  it('finds none when no kit is staged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'platform-dir-rules-'))
    roots.push(root)
    expect(await officeEnginePackages(root)).toEqual([])
  })
})

describe('platformDirRules', () => {
  for (const arch of ['arm64', 'x64']) {
    for (const target of ['darwin', 'win'] as const) {
      it(`drops every Office engine from the ${target} payload of a ${arch} host and keeps the kit`, () => {
        const rules = platformDirRules(arch)[target].filter(rule => rule.parent === '@deepseek-ai')
        expect(rules).toHaveLength(1)
        for (const name of ENGINES) expect(rules[0]?.keep(name.slice('@deepseek-ai/'.length))).toBe(false)
        expect(rules[0]?.keep('libreoffice-kit')).toBe(true)
        expect(rules[0]?.keep('dsh-office-to-pdf')).toBe(true)
      })
    }
  }

  it('keeps the node-addon-system family whole on darwin and only its entry on win', () => {
    const rules = platformDirRules('arm64')
    const deepseek = (target: PayloadTarget): PlatformDirRule | undefined => rules[target].find(rule => rule.parent === '@deepseek-ai')
    expect(deepseek('darwin')?.keep('node-addon-system-darwin-arm64')).toBe(true)
    expect(deepseek('win')?.keep('node-addon-system-darwin-arm64')).toBe(false)
    expect(deepseek('win')?.keep('node-addon-system')).toBe(true)
  })

  it('keeps sherpa-onnx-node on both targets and only the target\'s own member', () => {
    const rules = platformDirRules('arm64')
    const top = (target: PayloadTarget): PlatformDirRule | undefined => rules[target].find(rule => rule.parent === '.')
    for (const target of ['darwin', 'win'] as const) expect(top(target)?.keep('sherpa-onnx-node')).toBe(true)
    expect(top('darwin')?.keep('sherpa-onnx-darwin-arm64')).toBe(true)
    expect(top('darwin')?.keep('sherpa-onnx-darwin-x64')).toBe(false)
    expect(top('darwin')?.keep('sherpa-onnx-win-x64')).toBe(false)
    expect(top('win')?.keep('sherpa-onnx-win-x64')).toBe(true)
    expect(top('win')?.keep('sherpa-onnx-win-ia32')).toBe(false)
    expect(top('win')?.keep('sherpa-onnx-darwin-arm64')).toBe(false)
    expect(top('win')?.keep('yaml')).toBe(true)
  })

  it('drops something with every rule on the tree a macOS host stages', async () => {
    await expect(verifyPruneRules(staged(MAC_HOST_STAGED), platformDirRules('arm64'))).resolves.toBeUndefined()
  })
})

describe('the payload gate on the Office engines', () => {
  for (const target of ['darwin', 'win'] as const) {
    it(`accepts the ${target} payload the rules derive, which holds no engine`, async () => {
      const root = staged([...MAC_HOST_STAGED, `${OFFICE_KIT}-win32-x64`])
      const { payload, dropped } = derive(root, platformDirRules('arm64')[target])
      await verifyPrunedPayload({
        target,
        runsOn: runsOn(target, 'arm64'),
        staged: await snapshotPayload(root),
        afterPlatformPrune: await snapshotPayload(payload),
        payload,
        droppedByRules: dropped,
      })
      expect(await findWithheldDirectories(payload, await officeEnginePackages(root))).toEqual([])
    })
  }

  // The exemption that lets the darwin payload leave its own engine out names
  // the win32 engine too, so the gate alone passes a payload whose rules keep
  // both; the absence check is what refuses it.
  it('passes an engine riding into a payload, which the absence check refuses', async () => {
    const root = staged([...MAC_HOST_STAGED, `${OFFICE_KIT}-win32-x64`])
    const keepsEngines = platformDirRules('arm64').darwin.filter(rule => rule.parent !== '@deepseek-ai')
    const { payload, dropped } = derive(root, keepsEngines)
    await verifyPrunedPayload({
      target: 'darwin',
      runsOn: runsOn('darwin', 'arm64'),
      staged: await snapshotPayload(root),
      afterPlatformPrune: await snapshotPayload(payload),
      payload,
      droppedByRules: dropped,
    })
    expect(await findWithheldDirectories(payload, await officeEnginePackages(root))).toEqual([
      `node_modules/${OFFICE_KIT}-darwin-arm64`,
      `node_modules/${OFFICE_KIT}-win32-x64`,
    ])
  })
})

describe('namesWindowsX64', () => {
  it('names the Windows x64 member under either platform spelling', () => {
    for (const name of ['@img/sharp-win32-x64', '@koromix/koffi-win32-x64', 'node-addon-require-builtin-win32-x64-msvc', 'sherpa-onnx-win-x64']) {
      expect(namesWindowsX64(name)).toBe(true)
    }
  })

  it('names no other platform or architecture', () => {
    for (const name of ['sherpa-onnx-win-ia32', 'sherpa-onnx-darwin-arm64', '@img/sharp-win32-arm64', 'sherpa-onnx-node', 'window-x64']) {
      expect(namesWindowsX64(name)).toBe(false)
    }
  })
})

describe('pinnedVariantVersion', () => {
  it('fetches an exact version as written', () => {
    expect(pinnedVariantVersion('@img/sharp-win32-x64', '0.35.4', [])).toBe('0.35.4')
    expect(pinnedVariantVersion('x-win32-x64', '1.0.0-rc.2', [])).toBe('1.0.0-rc.2')
  })

  it('pins a range to the one version the installed siblings share', () => {
    expect(pinnedVariantVersion('sherpa-onnx-win-x64', '^1.13.8', ['1.13.8'])).toBe('1.13.8')
  })

  it('refuses a range with no sibling, or with siblings that disagree', () => {
    expect(() => pinnedVariantVersion('sherpa-onnx-win-x64', '^1.13.8', [])).toThrow(/no installed sibling/)
    expect(() => pinnedVariantVersion('sherpa-onnx-win-x64', '^1.13.8', ['1.13.8', '1.13.9'])).toThrow(/1\.13\.8, 1\.13\.9/)
  })
})

describe('the payload gate on sherpa-onnx members', () => {
  /**
   * Run the gate on a payload derived with some rules and the whole staged tree.
   * @param target - the payload target.
   * @param rules - the rules the payload is derived with.
   * @returns the gate's settled promise.
   */
  async function gate(target: PayloadTarget, rules: readonly PlatformDirRule[]): Promise<void> {
    const root = staged(MAC_HOST_STAGED)
    const { payload, dropped } = derive(root, rules)
    await verifyPrunedPayload({
      target, runsOn: runsOn(target, 'arm64'), staged: await snapshotPayload(root),
      afterPlatformPrune: await snapshotPayload(payload), payload, droppedByRules: dropped,
    })
  }

  it('reads a win- member as a Windows variant, so the win payload that lacks it fails', async () => {
    const dropsSherpa = [...platformDirRules('arm64').win, { parent: '.', keep: (name: string) => name !== 'sherpa-onnx-win-x64' }]
    await expect(gate('win', dropsSherpa)).rejects.toThrow(/sherpa-onnx-win-x64 names win32-x64 and is missing from the win payload/)
  })

  it('refuses the win member riding into the darwin payload', async () => {
    const keepsSherpa = platformDirRules('arm64').darwin.filter(rule => rule.parent !== '.')
    await expect(gate('darwin', keepsSherpa)).rejects.toThrow(/sherpa-onnx-win-x64 names win32-x64 and rode into the darwin payload/)
  })
})
