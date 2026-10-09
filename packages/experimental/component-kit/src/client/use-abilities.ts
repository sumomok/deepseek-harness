/**
 * The host's verdict on what the visitor may do on one table, held for a
 * block that draws one of the kit's write paths — the data page and the form
 * page beside it.
 *
 * Its own module rather than `data-page-abilities.ts`'s, because that module is
 * the network read a test replaces: the hook has to keep running over whatever
 * read stands in for it.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/use-abilities
 */
import { useEffect, useState } from 'react'
import { readAbilitiesFor } from './data-page-abilities.ts'
import { NO_ABILITIES, type DataPageAbilityTable } from '../route.ts'

/**
 * What the visitor may do on one table, as the node half judged it.
 * @param meta - the table, or `undefined` for a block naming none.
 * @returns the verdict for that table, or {@link NO_ABILITIES} until it arrives.
 */
export function useAbilities(meta: string | undefined): DataPageAbilityTable {
  const [held, setHeld] = useState<{ readonly meta?: string; readonly table: DataPageAbilityTable }>({ table: NO_ABILITIES })
  useEffect(() => {
    if (meta === undefined) return undefined
    const abort = new AbortController()
    void readAbilitiesFor(meta, abort.signal).then((table) => {
      if (!abort.signal.aborted) setHeld({ meta, table })
    })
    return () => { abort.abort() }
  }, [meta])
  // A verdict about another table is no verdict about this one.
  return held.meta === meta ? held.table : NO_ABILITIES
}
