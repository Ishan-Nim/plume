; Extra registration so Plume shows up in Windows Settings > Default apps and
; in the "Open with" list for every Markdown extension. electron-builder's
; fileAssociations already create the Plume.Markdown ProgID.

!macro plumeRegisterExt EXT
  WriteRegStr SHELL_CONTEXT "Software\Plume\Capabilities\FileAssociations" ".${EXT}" "Plume.Markdown"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Plume.exe\SupportedTypes" ".${EXT}" ""
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

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Plume"
  DeleteRegKey SHELL_CONTEXT "Software\Plume"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\Plume.exe"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend
