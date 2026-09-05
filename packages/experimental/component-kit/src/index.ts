/**
 * Component row, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader, which is what makes the
 * browser half discoverable through the package.json `dsh.client` declaration
 * and the `exports["./client"]` bundle.
 *
 * Nothing here knows a content column, a session, or a tool. The row's whole
 * contribution is the renderer table its browser half exports, and the package
 * that places blocks requests that table through the loader's module table.
 * @module @deepseek-ai/dsh-experimental-component-kit
 */

/** Host plugin body — this component row has no host-side behavior. */
export function apply(): void {}
