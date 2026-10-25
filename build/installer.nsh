; Flown's additions to electron-builder's NSIS installer (nsis.include in electron-builder.config.cjs).
;
; The app was called "Screen Studio for Windows". The installer keeps that version's product GUID
; (nsis.guid), so it finds the old install and runs its uninstaller (which removes the old
; shortcuts and keeps the user's data) before installing. The old install folder, by default
; ...\Programs\Screen Studio for Windows, would then be reused as is, or get a "\Flown" appended
; by the directory page; instead Flown goes into the folder next to it, ...\Programs\Flown.
; A folder the user chose under another name is kept.

!define FLOWN_LEGACY_DIR "\Screen Studio for Windows"
!define FLOWN_LEGACY_SHORTCUT "Screen Studio for Windows"

; $INSTDIR ends with \Screen Studio for Windows (any case) -> the sibling \Flown.
!macro flownMoveLegacyInstDir
  Push $R0
  StrLen $R0 "${FLOWN_LEGACY_DIR}"
  IntOp $R0 0 - $R0
  StrCpy $R0 "$INSTDIR" "" $R0
  ${if} $R0 == "${FLOWN_LEGACY_DIR}"
    StrLen $R0 "${FLOWN_LEGACY_DIR}"
    IntOp $R0 0 - $R0
    StrCpy $INSTDIR "$INSTDIR" $R0
    StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
  ${endIf}
  Pop $R0
!macroend

; After the install mode is known from the registry (covers silent upgrades too).
!macro customInit
  !insertmacro flownMoveLegacyInstDir
!macroend

; The install mode page sets $INSTDIR from the registry again: fix it once more before installing.
; A page that aborts in its "pre" function is never shown.
!macro customPageAfterChangeDir
  Page custom flownLegacyInstDirPage
  Function flownLegacyInstDirPage
    !insertmacro flownMoveLegacyInstDir
    Abort
  FunctionEnd
!macroend

; The old uninstaller removes its shortcuts; this covers one that failed or was skipped.
!macro customInstall
  ${if} ${FileExists} "$DESKTOP\${FLOWN_LEGACY_SHORTCUT}.lnk"
    Delete "$DESKTOP\${FLOWN_LEGACY_SHORTCUT}.lnk"
  ${endIf}
  ${if} ${FileExists} "$SMPROGRAMS\${FLOWN_LEGACY_SHORTCUT}.lnk"
    Delete "$SMPROGRAMS\${FLOWN_LEGACY_SHORTCUT}.lnk"
  ${endIf}
!macroend
