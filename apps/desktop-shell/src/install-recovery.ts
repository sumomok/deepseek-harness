/** Office service environment replacement after an install teardown. */
import { ENGINE_MODULES_ENV } from './office-engine.ts'
import { ENDPOINT_ENV, TOKEN_ENV } from './office-engine-service.ts'

/**
 * Replace the Office connection and module paths before restarting the server.
 * A listener that cannot reopen returns no credentials; the closed listener's
 * address and token are never retained. A rejected open prevents the restart.
 * @param previous - environment of the stopped server.
 * @param open - return the live Office environment, recreating its manager and listener when closed.
 * @returns a new environment preserving the other shell services.
 */
export async function restoreOfficeEnvironment(
  previous: Readonly<Record<string, string>>,
  open: () => Promise<Record<string, string>>,
): Promise<Record<string, string>> {
  const replaced = new Set([ENDPOINT_ENV, TOKEN_ENV, ENGINE_MODULES_ENV, 'NODE_PATH'])
  const env = Object.fromEntries(Object.entries(previous).filter(([key]) => !replaced.has(key)))
  return { ...env, ...await open() }
}
