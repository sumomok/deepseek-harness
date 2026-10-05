/**
 * The one route this package claims: what the pack root and the offered
 * organization set hold, and for each pack whether it is offered and, when it
 * is not, every requirement it is waiting on.
 *
 * A pack that is inactive is invisible everywhere else by design — the model
 * is not told it exists and no command offers it — so without this route a
 * deployment that installed a pack and cannot find it has nothing to read. The
 * document carries names, versions, where each pack is installed, an
 * organization entry's channel, and refusal reasons, and nothing else: no file
 * contents, no paths inside the pack, no configuration.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/route
 */

import type { ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PlaceRequest } from './members.ts'
import type { PackStatus, PackStatusDocument } from './types.ts'

/** Exact route answering {@link PackStatusDocument}. */
export const SKILL_PACK_STATUS_ROUTE = '/skill-pack/status'

/**
 * Claim the status route over a live view of the pack statuses.
 * @param statuses - reads the current statuses; called per request so the answer is never a cached state the reader cannot see change.
 * @param place - decides, before anything is read, whether a request is answered.
 * @returns the route to register on `ctx.webServer`.
 */
export function packStatusRoute(statuses: () => Promise<readonly PackStatus[]>, place: PlaceRequest): WebRoute {
  return {
    kind: 'exact',
    path: SKILL_PACK_STATUS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const refusal = place(req)
      if (refusal !== undefined) {
        answer(res, refusal.status, { error: refusal.error })
        return
      }
      const document: PackStatusDocument = { packs: await statuses() }
      answer(res, 200, document)
    },
  }
}

/** Answer JSON with no caching: a pack's state flips with the plugins around it, and a refusal with the member directory. */
function answer(res: ServerResponse, status: number, body: PackStatusDocument | { readonly error: string }): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}
