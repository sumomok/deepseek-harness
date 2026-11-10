/**
 * Height of the Windows caption band.
 *
 * The window's native minimize/maximize/close buttons float in an overlay this
 * tall, so the served page must reserve the same band: the window options paint
 * the overlay, `applyThemeReport` recolors it on a palette change, and the
 * shell's preload publishes the height to the shared client, whose
 * `[data-windows-titlebar]` rules pad the frame and paint the drag band.
 */
export const WINDOWS_TITLEBAR_HEIGHT = 40
