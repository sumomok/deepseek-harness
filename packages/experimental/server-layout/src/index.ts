/**
 * Service-line shell, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader, which is what makes the
 * browser half discoverable through the package.json `dsh.client` declaration
 * and the `exports["./client"]` bundle.
 * @module @deepseek-ai/dsh-experimental-server-layout
 */

/** Host plugin body — this surface plugin has no host-side behavior. */
export function apply(): void {}
