/**
 * Which palette a chart paints with, read from the document once.
 *
 * A canvas resolves no CSS custom properties, so the engine takes literal
 * colors and something has to tell it which set. Whichever shell is composed
 * writes the marker on `document.body` before the client tree boots —
 * `dsh-client-ui-layout`'s theme presenter under the shipped surface,
 * `dsh-experimental-server-layout`'s under the service-line one — so both of
 * this package's placements read the attribute rather than depending on either
 * package.
 */

/** The dark-palette marker on `document.body`. */
const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/**
 * Whether the dark palette is active right now.
 *
 * Read once per mount by its callers, never watched: a component that
 * subscribed to the document from a slot would be inventing its own reactive
 * channel.
 * @returns true while the shell marks the document dark.
 */
export function darkPalette(): boolean {
  return document.body.hasAttribute(DARK_ATTRIBUTE)
}
