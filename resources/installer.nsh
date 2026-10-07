; Extra registration so Plume shows up in Windows Settings > Default apps and
; in the "Open with" list for every Markdown extension. electron-builder's
; fileAssociations already create the Plume.Markdown ProgID.

!macro plumeRegisterExt EXT
  WriteRegStr SHELL_CONTEXT "Software\Plume\Capabilities\FileAssociations" ".${EXT}" "Plume.Markdown"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Plume.exe\SupportedTypes" ".${EXT}" ""
!macroend

; electron-builder points ".ext" at Plume.Markdown without keeping the old
; value, and only deletes the ProgID on uninstall. Drop a default that still
; names Plume so Windows falls back to the user's choice or asks.
!macro plumeClearExtDefault ROOT EXT
  ReadRegStr $0 ${ROOT} "Software\Classes\.${EXT}" ""
  ${if} $0 == "Plume.Markdown"
    DeleteRegValue ${ROOT} "Software\Classes\.${EXT}" ""
  ${endIf}
!macroend

!macro plumeClearExtDefaults ROOT
  !insertmacro plumeClearExtDefault ${ROOT} "md"
  !insertmacro plumeClearExtDefault ${ROOT} "markdown"
  !insertmacro plumeClearExtDefault ${ROOT} "mdown"
  !insertmacro plumeClearExtDefault ${ROOT} "mkd"
  !insertmacro plumeClearExtDefault ${ROOT} "mkdn"
  !insertmacro plumeClearExtDefault ${ROOT} "mdwn"
  !insertmacro plumeClearExtDefault ${ROOT} "mdtxt"
  !insertmacro plumeClearExtDefault ${ROOT} "mdtext"
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Plume\Capabilities" "ApplicationName" "Plume"
  WriteRegStr SHELL_CONTEXT "Software\Plume\Capabilities" "ApplicationDescription" "A feather-light Markdown viewer"
  WriteRegStr SHELL_CONTEXT "Software\Plume\Capabilities" "ApplicationIcon" "$appExe,0"
  !insertmacro plumeRegisterExt "md"
  !insertmacro plumeRegisterExt "markdown"
  !insertmacro plumeRegisterExt "mdown"
  !insertmacro plumeRegisterExt "mkd"
  !insertmacro plumeRegisterExt "mkdn"
  !insertmacro plumeRegisterExt "mdwn"
  !insertmacro plumeRegisterExt "mdtxt"
  !insertmacro plumeRegisterExt "mdtext"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Plume" "Software\Plume\Capabilities"

  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Plume.exe" "FriendlyAppName" "Plume"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Plume.exe\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Plume.exe\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Plume.Markdown" "FriendlyTypeName" "Markdown Document"
  ; electron-builder writes this command with the exe path unquoted, which
  ; under "C:\Program Files" makes Windows try "C:\Program.exe" first.
  WriteRegStr SHELL_CONTEXT "Software\Classes\Plume.Markdown\shell\open\command" "" '"$appExe" "%1"'

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Plume"
  DeleteRegKey SHELL_CONTEXT "Software\Plume"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\Plume.exe"
  ; An update reinstalls straight away and registers everything again.
  ${ifNot} ${isUpdated}
    Push $0
    !insertmacro plumeClearExtDefaults SHELL_CONTEXT
    ; Leftovers of an earlier per-user install, unless one is still there.
    ${if} $installMode == "all"
      ReadRegStr $0 HKCU "Software\Classes\Plume.Markdown\shell\open\command" ""
      ${if} $0 == ""
        !insertmacro plumeClearExtDefaults HKCU
      ${endIf}
    ${endIf}
    Pop $0
  ${endIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
