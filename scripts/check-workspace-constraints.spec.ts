/** Experimental-package and private-app publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkPrivateAppManifest,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
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
})
