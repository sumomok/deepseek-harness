/**
 * Package build config: the shared client preset with no package-specific
 * decisions. The renderers are ordinary React components with no cross-package
 * value import, so the bundle declares no module request; the placement package
 * that draws them requests this row instead.
 */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-experimental-component-kit',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
