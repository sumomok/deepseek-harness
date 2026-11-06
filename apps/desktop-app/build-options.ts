/**
 * The esbuild options `build.ts` bundles the two Host modules with, kept in
 * their own module so a test can build with exactly them.
 * @module
 */
import { resolve } from 'node:path'
import type { BuildOptions } from 'esbuild'

/**
 * The packages the Host modules import rather than inline. `@deepseek-ai/cordis`
 * must be the server's own instance: the exporter registers on the root logger
 * service, and a second cordis bundled into the module would be a different
 * `Logger` the server never writes through. `@deepseek-ai/schemastery` goes
 * with it, since cordis validates each row's config with its own copy.
 */
export const HOST_EXTERNALS = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'] as const

/** The Host modules under `src/`, each bundled to `lib/<name>.js`. */
export type HostModule = 'index' | 'server-log'

/**
 * Bundle `src/<module>.ts` into `lib/<module>.js`.
 * @param root - the package directory.
 * @param module - the Host module to bundle.
 * @returns the options for one `esbuild.build` call.
 */
export function hostBuild(root: string, module: HostModule): BuildOptions {
  return {
    entryPoints: [resolve(root, `src/${module}.ts`)],
    outfile: resolve(root, `lib/${module}.js`),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: [...HOST_EXTERNALS],
    logLevel: 'warning',
  }
}
