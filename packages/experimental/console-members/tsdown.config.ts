import { defineConfig } from 'tsdown'

/**
 * Bundle the plugin root and `./credential-access` in one build, so the
 * module that creates the directory state symbol is one shared chunk both
 * entries import; two builds would give each entry its own symbol.
 */
export default defineConfig({
  entry: { index: 'lib/types/index.js', 'credential-access': 'lib/types/credential-access.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
