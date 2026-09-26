/**
 * What the signed-in visitor may do on one table's data page, as the node half
 * judges it.
 *
 * The verdict is the node half's: it reads the visitor's rights once and judges
 * them by the deployment's own rule table, and this module fetches only the
 * five booleans that come out. Nothing here knows a rule, a rights flag, or
 * which operation needs which flag, so the page cannot disagree with the tools
 * that judge by the same table.
 *
 * Fail closed. Every failure to obtain a verdict — no ability route composed,
 * a refusal, a network fault, a document that is not a complete table — is the
 * table with every ability off, and so is the time before the verdict arrives.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/data-page-abilities
 */
import { COMPONENT_KIT_ABILITIES_ROUTE, NO_ABILITIES, readDataPageAbilities, type DataPageAbilityTable } from '../route.ts'

/**
 * Ask the node half what the visitor may do on one table's data page.
 *
 * Never cached: the answer is one read of the visitor's rights, and a page
 * opened after those rights changed is drawn under the new ones.
 * @param meta - the table, by its name in the backend.
 * @param signal - aborts the read when the page no longer needs it.
 * @returns the verdict, or {@link NO_ABILITIES} when none could be obtained.
 */
export async function readAbilitiesFor(meta: string, signal: AbortSignal): Promise<DataPageAbilityTable> {
  // Document-relative, so a console served under a path prefix reaches its own route.
  const url = new URL(COMPONENT_KIT_ABILITIES_ROUTE.slice(1), document.baseURI)
  url.searchParams.set('meta', meta)
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', signal })
  } catch (_readNeverAnswered) {
    // A network fault or an abort: either way no verdict arrived, and no
    // verdict is every ability off.
    return NO_ABILITIES
  }
  if (!response.ok) return NO_ABILITIES
  let body: unknown
  try {
    body = await response.json()
  } catch (_answerIsNotJson) {
    // The body was not JSON, which is no verdict.
    return NO_ABILITIES
  }
  return readDataPageAbilities(body) ?? NO_ABILITIES
}
