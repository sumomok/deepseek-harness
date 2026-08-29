/**
 * The sidebar entry's favorites store: the list plus the last save error,
 * shown inline in the menu. Module level exports the factory only; a
 * module-level handle would pin the store's identity in the module cache and
 * survive plugin reloads as a de-facto singleton.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/favorites-store
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { ServerMenuFavorite } from '../favorites.ts'

/** Favorites menu state. */
export interface FavoritesState {
  /** The current favorites list, authoritative from the server's own answer to the last read or write. */
  favorites: ServerMenuFavorite[]
  /** The last save's failure message, cleared by the next successful save. */
  error: string | undefined
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type FavoritesStoreActions = {
  setFavorites: (draft: FavoritesState, favorites: ServerMenuFavorite[]) => void
  setError: (draft: FavoritesState, message: string) => void
}

/**
 * Create the favorites store handle, seeded with the list this package's
 * client half already read before registering — matching how
 * `dsh-experimental-content-frame`'s own client half awaits its settings
 * route before claiming its slot, rather than rendering a loading state.
 * @param initial - the favorites list read before registration.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createFavoritesStore(initial: readonly ServerMenuFavorite[]): EngineStoreHandle<FavoritesState, FavoritesStoreActions> {
  return defineStore({
    init: (): FavoritesState => ({ favorites: [...initial], error: undefined }),
    actions: {
      setFavorites: (draft, favorites) => { draft.favorites = favorites; draft.error = undefined },
      setError: (draft, message) => { draft.error = message },
    },
  })
}
