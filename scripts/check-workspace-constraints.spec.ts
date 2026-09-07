/** Experimental-package and private-app publication and dependency constraints. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isPublicExperimentalPackageDirectory,
  PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
} from './experimental-package-policy.ts'
import {
  checkDshFamilyVersion,
  checkWorkspaceManifest,
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkPrivateAppManifest,
  checkWorkspaceManifest,
  expectedDshPackageFiles,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental = {
  dir: 'packages/experimental/prototype',
  manifest: {
    name: '@deepseek-ai/dsh-experimental-prototype',
    publishConfig: { access: 'public' },
  },
} satisfies WorkspaceManifest

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires public metadata for unlisted experimental packages', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { name: experimental.manifest.name, private: true },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: public experimental package must not set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: public experimental package must set publishConfig.access to "public"',
    ])
  })

  it('requires private metadata for an explicitly excluded prototype', () => {
    const { dir, manifest: { name } } = experimental
    const privateDirectories = [dir]
    expect(isPublicExperimentalPackageDirectory(dir, privateDirectories)).toBe(false)
    expect(checkExperimentalManifest({ dir, manifest: { name, private: true } }, privateDirectories)).toEqual([])
    expect(checkExperimentalManifest(experimental, privateDirectories)).toEqual([
      `${name}: experimental package must set "private": true`,
      `${name}: experimental package must omit publishConfig`,
    ])
  })

  it('keeps the current experimental publication set unrestricted', () => {
    expect(PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES).toEqual([])
  })

  it('limits the public default to experimental package directories', () => {
    expect(isPublicExperimentalPackageDirectory(experimental.dir)).toBe(true)
    for (const dir of [
      'packages/core/session',
      'apps/cli',
      'vendor/cordis',
      'packages/experimental',
      'packages/experimental/prototype/src',
      ...PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES,
    ]) {
      expect(isPublicExperimentalPackageDirectory(dir)).toBe(false)
    }
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows the dsh installation to ship the optional bundles the launcher names, and nothing else experimental', () => {
    const listed = { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' }
    const installation = { dir: 'apps/cli', manifest: { name: '@deepseek-ai/dsh', dependencies: listed } } satisfies WorkspaceManifest
    expect(checkExperimentalDependencyIsolation([experimental, installation], ['@deepseek-ai/dsh-experimental-prototype'])).toEqual([])
    expect(checkExperimentalDependencyIsolation([experimental, installation], [])).toEqual([
      '@deepseek-ai/dsh: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
    // Only a plain dependency edge is offered; a peer would make the bundle a requirement of every consumer.
    expect(checkExperimentalDependencyIsolation([experimental, {
      dir: 'apps/cli',
      manifest: { name: '@deepseek-ai/dsh', peerDependencies: listed },
    }], ['@deepseek-ai/dsh-experimental-prototype'])).toEqual([
      '@deepseek-ai/dsh: peerDependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('dsh family version coherence', () => {
  it('rejects a package carrying a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh-http-proxy: package.json version must match root version 0.1.2-rc.1')
  })

  it('rejects the root-named CLI app on a stale shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh', version: '0.1.2-alpha.5' },
      '0.1.2-rc.1',
    )).toBe('@deepseek-ai/dsh: package.json version must match root version 0.1.2-rc.1')
  })

  it('accepts a manifest carrying the shared version', () => {
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/dsh-http-proxy', version: '0.1.2-rc.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
  })

  it('leaves other sequences to their own version lines', () => {
    expect(checkDshFamilyVersion({ name: '@deepseek-ai/cordis', version: '4.0.1' }, '0.1.2-rc.1')).toBeUndefined()
    expect(checkDshFamilyVersion(
      { name: '@deepseek-ai/node-addon-system', version: '0.1.1' },
      '0.1.2-rc.1',
    )).toBeUndefined()
    expect(checkDshFamilyVersion({ version: '0.1.2-alpha.5' }, '0.1.2-rc.1')).toBeUndefined()
  })
})

describe('package payload constraints', () => {
  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })

  it.each([
    'packages/client/ui-sidebar-documentpreview',
    'packages/client/ui-sidebar-terminal',
  ])('accepts package-local Client chunks from %s', (dir) => {
    const manifest = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
    expect(checkWorkspaceManifest({ dir, manifest })).toEqual([])
  })
})

it('publishes CLI runtime declarations and rejects a payload that omits them', () => {
  const manifest = JSON.parse(readFileSync(new URL('../apps/cli/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'apps/cli', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'apps/cli', manifest: { ...manifest, files: ['lib/*.js'] } }))
    .toEqual([expect.stringContaining('@deepseek-ai/dsh: package.json files must be ["lib/*.js","lib/types/*.d.ts"]')])
})

it('requires the shared Web injection entry in the published payload', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/client/web/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'packages/client/web', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'packages/client/web', manifest: {
    ...manifest, files: ['lib/index.js', 'lib/**/*.css', 'lib/types/**/*.d.ts'],
  } })).toEqual([expect.stringContaining('package.json files must be')])
})

it('requires Office skill bodies and helpers in the published payload', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/skill/skill-office/package.json', import.meta.url), 'utf8')) as WorkspaceManifest['manifest']
  expect(checkWorkspaceManifest({ dir: 'packages/skill/skill-office', manifest })).toEqual([])
  expect(checkWorkspaceManifest({ dir: 'packages/skill/skill-office', manifest: {
    ...manifest, files: ['lib/index.js', 'lib/types/**/*.d.ts'],
  } })).toEqual([expect.stringContaining('package.json files must be')])
})

const privateApp: WorkspaceManifest = {
  dir: 'apps/shell',
  manifest: { name: '@deepseek-ai/dsh-shell-app', private: true },
}

describe('private app workspace constraints', () => {
  it('accepts an app that ships inside a client build', () => {
    expect(checkPrivateAppManifest(privateApp)).toEqual([])
  })

  it('ignores published apps and private packages outside apps/', () => {
    expect(checkPrivateAppManifest({
      ...privateApp,
      manifest: { name: '@deepseek-ai/dsh', publishConfig: { access: 'public' } },
    })).toEqual([])
    expect(checkPrivateAppManifest({
      dir: 'packages/core/agent',
      manifest: { name: '@deepseek-ai/dsh-agent', private: true, publishConfig: { access: 'public' } },
    })).toEqual([])
  })

  it('rejects publication metadata a private app can never use', () => {
    expect(checkPrivateAppManifest({
      ...privateApp,
      manifest: { ...privateApp.manifest, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-shell-app: private app must omit publishConfig',
    ])
  })

  it('rejects a published app that turned itself private', () => {
    expect(checkPrivateAppManifest({
      dir: 'apps/cli',
      manifest: { name: '@deepseek-ai/dsh', private: true },
    })).toEqual([
      '@deepseek-ai/dsh: private app must not hold a publication files policy',
    ])
  })

  it('leaves a private app on its own product version', () => {
    expect(checkWorkspaceManifest({
      ...privateApp,
      manifest: { ...privateApp.manifest, version: '0.1.0-rc.30' },
    })).toEqual([])
  })

  it('still holds a published app to the shared dsh family version', () => {
    const rootVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    expect(checkWorkspaceManifest({
      dir: 'apps/cli',
      manifest: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.30' },
    })).toContain(`apps/cli/package.json: @deepseek-ai/dsh: package.json version must match root version ${rootVersion}`)
  })
})
