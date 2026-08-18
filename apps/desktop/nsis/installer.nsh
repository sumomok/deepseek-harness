; electron-builder custom NSIS macros for the DSH desktop installer.
; The payload is a large node_modules tree, so extraction takes a while on
; antivirus-scanned machines — show the per-file details pane instead of a
; silent progress bar, so a stall or an extraction error is visible.
!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend
