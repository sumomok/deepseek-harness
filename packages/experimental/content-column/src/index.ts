/**
 * Content column, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader, which is what makes the
 * browser half discoverable through the package.json `dsh.client` declaration
 * and the `exports["./client"]` bundle.
 *
 * The column reads nothing on the host: what it shows is the `contentSurface`
 * projection that [`content-surface`](../../content-surface/README.md)
 * publishes, which the framework already carries to the browser with every
 * session's values.
 * @module @deepseek-ai/dsh-experimental-content-column
 */

/** Host plugin body — this surface plugin has no host-side behavior. */
export function apply(): void {}
