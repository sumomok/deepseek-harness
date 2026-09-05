import { clientBundle, clientLibraryConfig } from '../../client/tsdown.client.ts'

const ID = '@deepseek-ai/dsh-experimental-server-sidebar'

/*
 * Two independent Node bundles rather than one two-entry build: the invariant
 * companion re-runs `validateServerMenu` against each committed document, so
 * `lib/types/index.js` and `lib/types/invariant.js` both reach
 * `src/workflows.ts`, and a single build hoists it into a hash-named shared
 * chunk this package's exact `files` list cannot publish (publint and
 * `verify-built-package-invariants` both refuse that artifact).
 * `packages/core/agent` splits its own entries for the same reason.
 */
export default clientBundle(ID, ['lib/types/index.js'], {
  companions: [clientLibraryConfig(ID, ['lib/types/invariant.js'])],
})
