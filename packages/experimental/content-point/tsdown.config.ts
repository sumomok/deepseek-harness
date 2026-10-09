/**
 * Package build config: the shared client preset with no package-specific
 * decisions. Both bundles inline the vendored `@haoran/dsh-point-anchor`: the
 * Node half its neutral entry, the browser half its `/page` entry as well.
 */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle('@deepseek-ai/dsh-experimental-content-point', ['lib/types/index.js'])
