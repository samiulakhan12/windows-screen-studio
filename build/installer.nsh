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

; Find private info's text reader (docs/design/auto-blur.md §10.5, question 14 (a)): a crash dump
; of ssw-ocr.exe would hold frames with secrets, so Windows Error Reporting leaves it out. One DWORD
; named after Flown's own helper, written where the install is (HKLM for every user, HKCU for this
; user; $installMode is "all" or "CurrentUser") and removed from the same place on uninstall. The
; helper also asks Windows itself to leave its heap out of any report and ends without one.
!define FLOWN_WER_EXCLUDED "Microsoft\Windows\Windows Error Reporting\ExcludedApplications"
!define FLOWN_WER_HELPER "ssw-ocr.exe"

; The old uninstaller removes its shortcuts; this covers one that failed or was skipped.
!macro customInstall
  ${if} ${FileExists} "$DESKTOP\${FLOWN_LEGACY_SHORTCUT}.lnk"
    Delete "$DESKTOP\${FLOWN_LEGACY_SHORTCUT}.lnk"
  ${endIf}
  ${if} ${FileExists} "$SMPROGRAMS\${FLOWN_LEGACY_SHORTCUT}.lnk"
    Delete "$SMPROGRAMS\${FLOWN_LEGACY_SHORTCUT}.lnk"
  ${endIf}
  ${if} $installMode == "all"
    WriteRegDWORD HKLM "SOFTWARE\${FLOWN_WER_EXCLUDED}" "${FLOWN_WER_HELPER}" 1
  ${else}
    WriteRegDWORD HKCU "Software\${FLOWN_WER_EXCLUDED}" "${FLOWN_WER_HELPER}" 1
  ${endIf}
!macroend

; The uninstaller removes the value from where the install wrote it.
!macro customUnInstall
  ${if} $installMode == "all"
    DeleteRegValue HKLM "SOFTWARE\${FLOWN_WER_EXCLUDED}" "${FLOWN_WER_HELPER}"
  ${else}
    DeleteRegValue HKCU "Software\${FLOWN_WER_EXCLUDED}" "${FLOWN_WER_HELPER}"
  ${endIf}
!macroend
