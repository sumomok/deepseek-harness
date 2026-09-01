/**
 * Minimal type surface for the `dom-accessibility-api` package: the ARIA role
 * and accessible-name implementations testing-library builds its queries on.
 * The package ships `dist/index.d.ts` but its `exports` map declares no `types`
 * condition, so `moduleResolution: bundler` cannot reach those declarations.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/dom-accessibility-api-types
 */

declare module 'dom-accessibility-api' {
  /**
   * The element's ARIA role, explicit or implicit.
   * @param element - the element to classify.
   * @returns the role name, or null for an element HTML gives no role.
   */
  export function getRole(element: Element): string | null

  /**
   * The element's accessible name, per https://w3c.github.io/accname/.
   * @param root - the element to name.
   * @returns the computed name, empty when the element has none.
   */
  export function computeAccessibleName(root: Element): string
}
