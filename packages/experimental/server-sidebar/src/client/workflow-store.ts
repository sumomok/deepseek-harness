/**
 * The sidebar entry's server-menu store: the workflow list, the workbench
 * session id, and the last save error, shown inline in the menu. Module
 * level exports the factory only; a module-level handle would pin the
 * store's identity in the module cache and survive plugin reloads as a
 * de-facto singleton.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/workflow-store
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ServerMenuState } from './workflow-api.ts'

/** Server-menu state. */
export interface ServerMenuStoreState {
  /** The current workflow list, authoritative from the server's own answer to the last read or write. */
  workflows: ServerMenuState['workflows']
  /** The persistent workbench conversation's id, authoritative from the same source. */
  workbenchSessionId: string | undefined
  /** The last save's failure message, cleared by the next successful save. */
  error: string | undefined
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type ServerMenuStoreActions = {
  setServerMenu: (draft: ServerMenuStoreState, next: ServerMenuState) => void
  setError: (draft: ServerMenuStoreState, message: string) => void
}

/**
 * Create the server-menu store handle, seeded with the document this
 * package's client half already read before registering — matching how
 * `dsh-experimental-content-frame`'s own client half awaits its settings
 * route before claiming its slot, rather than rendering a loading state.
 * @param initial - the document read before registration.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkflowStore(initial: ServerMenuState): EngineStoreHandle<ServerMenuStoreState, ServerMenuStoreActions> {
  return defineStore({
    init: (): ServerMenuStoreState => ({
      workflows: [...initial.workflows], workbenchSessionId: initial.workbenchSessionId, error: undefined,
    }),
    actions: {
      setServerMenu: (draft, next) => {
        draft.workflows = next.workflows
        draft.workbenchSessionId = next.workbenchSessionId
        draft.error = undefined
      },
      setError: (draft, message) => { draft.error = message },
    },
  })
}
