/**
 * How the payload's installation manifest loses its `workspace:` ranges.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { pinWorkspaceRanges } from '../scripts/pin-workspace-ranges.ts'

const versions: Record<string, string> = { '@deepseek-ai/dsh-base': '0.2.1-alpha.4', '@deepseek-ai/cordis': '4.0.5-alpha.2' }
const versionOf = (name: string): string | undefined => versions[name]

describe('pinWorkspaceRanges', () => {
  it('pins each workspace range the way pnpm publish does and keeps registry ranges', () => {
    const { manifest, pinned } = pinWorkspaceRanges({
      name: '@deepseek-ai/dsh',
      dependencies: { '@deepseek-ai/dsh-base': 'workspace:*', yaml: '^2.8.1', '@deepseek-ai/cordis': 'workspace:^' },
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:~' },
      optionalDependencies: { sharp: 'workspace:0.35.5' },
      devDependencies: { '@deepseek-ai/dsh-test-support': 'workspace:*' },
    }, versionOf)

    expect(pinned).toBe(4)
    expect(manifest).toEqual({
      name: '@deepseek-ai/dsh',
      dependencies: { '@deepseek-ai/dsh-base': '0.2.1-alpha.4', yaml: '^2.8.1', '@deepseek-ai/cordis': '^4.0.5-alpha.2' },
      peerDependencies: { '@deepseek-ai/cordis': '~4.0.5-alpha.2' },
      optionalDependencies: { sharp: '0.35.5' },
      devDependencies: { '@deepseek-ai/dsh-test-support': 'workspace:*' },
    })
  })

  it('refuses a workspace dependency the staged tree does not carry', () => {
    expect(() => pinWorkspaceRanges({ dependencies: { '@deepseek-ai/dsh-missing': 'workspace:*' } }, versionOf))
      .toThrow('dependencies.@deepseek-ai/dsh-missing is workspace:*, and the staged tree has no @deepseek-ai/dsh-missing')
  })
})
