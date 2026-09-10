!macro customInstall
  WriteRegStr HKCU "Software\Flowdesk\Launcher" "Installed" "1"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FlowdeskLauncher" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
  CreateShortCut "$SMSTARTUP\Flowdesk Launcher.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--hidden"
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FlowdeskLauncher"
  Delete "$SMSTARTUP\Flowdesk Launcher.lnk"
  DeleteRegKey HKCU "Software\Flowdesk\Launcher"
!macroend
