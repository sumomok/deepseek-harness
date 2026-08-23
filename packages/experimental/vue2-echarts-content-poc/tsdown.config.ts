/**
 * Package build config: the shared client preset with no package-specific
 * decisions. Vue and ECharts stay out of this bundle — the manifest's
 * `dsh.client.external` request keeps the component row an import resolved
 * through the loader's module table, which is what makes both packages share
 * one Vue runtime.
 */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-experimental-vue2-echarts-content-poc',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
