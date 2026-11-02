/** IPC channels for the product window's native input and keybinding preferences. */
export const SHORTCUT_CHANNELS = {
  /** Main → renderer: one verified key press for the current configuration. */
  input: 'dsh-desktop:shortcuts-input',
  /** Renderer → main: read the device configuration for the product catalog. */
  get: 'dsh-desktop:shortcuts-get',
  /** Renderer → main: apply one reviewed edit. */
  edit: 'dsh-desktop:shortcuts-edit',
  /** Main → renderer: the accepted configuration changed. */
  changed: 'dsh-desktop:shortcuts-changed',
  /** Renderer → main: close the window that owns the accepted configuration. */
  closeWindow: 'dsh-desktop:shortcuts-close-window',
} as const
