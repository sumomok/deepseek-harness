/**
 * Package build config: the shared client preset with no package-specific
 * decisions. The renderer table stays out of this bundle — the manifest's
 * `dsh.client.external` request keeps the component row an import resolved
 * through the loader's module table, which is what keeps one copy of the
 * components in the page.
 */
import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'])
