/**
 * The esbuild options `build.ts` bundles the server-log exporter with, kept in
 * their own module so a test can build with exactly them.
 * @module
 */
import { resolve } from 'node:path'
import type { BuildOptions } from 'esbuild'

/**
 * The packages the exporter imports rather than inlines. `@deepseek-ai/cordis`
 * must be the server's own instance: the exporter registers on the root logger
 * service, and a second cordis bundled into the module would be a different
 * `Logger` the server never writes through. `@deepseek-ai/schemastery` goes
 * with it, since cordis validates the row's config with its own copy.
 */
export const SERVER_LOG_EXTERNALS = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'] as const

/**
 * Bundle `src/server-log.ts` into `lib/server-log.js`.
 * @param root - the package directory.
 * @returns the options for one `esbuild.build` call.
 */
export function serverLogBuild(root: string): BuildOptions {
  return {
    entryPoints: [resolve(root, 'src/server-log.ts')],
    outfile: resolve(root, 'lib/server-log.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: [...SERVER_LOG_EXTERNALS],
    logLevel: 'warning',
  }
}
