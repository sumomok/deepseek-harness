/**
 * Package build for the desktop composition layer's two halves.
 *
 * esbuild bundles `src/index.ts` into the node half `lib/index.js`, and
 * `src/client/index.ts` into `lib/client.js` in the closure-factory form the
 * web shell's module loader consumes:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … } })
 *
 * The browser half requests exactly the web shell's platform module table and
 * inlines everything else; React in particular must come from the table, since
 * a second React has its own hook dispatcher. The half reads no `process.env`
 * value, so the bundle substitutes none. The bundle carries no source map: the
 * package publishes no `.map` file for it to name.
 * @module
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { PLATFORM_MODULES } from '../../packages/client/web/src/platform.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-desktop-app'
const root = import.meta.dirname

rmSync(resolve(root, 'lib'), { recursive: true, force: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  logLevel: 'warning',
})

await build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  outfile: resolve(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [...PLATFORM_MODULES],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'warning',
})

console.log(`built ${PACKAGE_NAME}: lib/index.js, lib/client.js`)
