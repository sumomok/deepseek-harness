import { describe, expect, it } from 'vitest'
import { builtDeclarationPath } from './doc-typecheck-paths.ts'

describe('builtDeclarationPath', () => {
  it('maps package source directories and exact entry files to built declarations', () => {
    expect(builtDeclarationPath('./packages/*/*/src')).toBe('./packages/*/*/lib/types')
    expect(builtDeclarationPath('./packages/core/session/src/index.ts'))
      .toBe('./packages/core/session/lib/types/index.d.ts')
    expect(builtDeclarationPath('./packages/core/session/src/types.ts'))
      .toBe('./packages/core/session/lib/types/types.d.ts')
    expect(builtDeclarationPath('./packages/experimental/claude-code-mods/examples/*'))
      .toBe('./packages/experimental/claude-code-mods/examples/*')
    expect(builtDeclarationPath('./packages/experimental/server-base/deploy/proxy.mts'))
      .toBe('./packages/experimental/server-base/deploy/proxy.mts')
    expect(builtDeclarationPath('./packages/experimental/server-base/deploy/proxy.mjs'))
      .toBe('./packages/experimental/server-base/deploy/proxy.mjs')
  })

  it('rejects aliases without a supported source target', () => {
    expect(() => builtDeclarationPath('./packages/core/session/source/index.ts'))
      .toThrow('cannot map workspace source path')
    expect(() => builtDeclarationPath('./packages/experimental/server-base/deploy/nested/proxy.mjs'))
      .toThrow('cannot map workspace source path')
    expect(() => builtDeclarationPath('./packages/experimental/server-base/deploy/proxy.js'))
      .toThrow('cannot map workspace source path')
  })
})
