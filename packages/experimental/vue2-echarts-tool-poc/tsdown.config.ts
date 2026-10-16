/**
 * Package build config: the shared client preset with no package-specific
 * decisions. Vue and ECharts stay out of this bundle — the manifest's
 * `dsh.client.external` request keeps the component row an import resolved
 * through the loader's module table, which is what makes both packages share
 * one Vue runtime.
 */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  import.meta.dirname,
  ['lib/types/index.js'],
)
