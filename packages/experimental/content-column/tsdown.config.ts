/**
 * Package build config: the shared client preset with no package-specific
 * decisions. The browser half carries no cross-package value import, so it
 * declares no module request — the kind renderers live in the feature packages
 * and reach this row through the slot registry alone.
 */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-experimental-content-column',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
