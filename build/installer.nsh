; Extra steps for the Windows installer (electron-builder NSIS).
; Allows the phone remote to reach PCTV Home on private (home) networks only.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PCTV Home"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="PCTV Home" dir=in action=allow program="$INSTDIR\PCTV Home.exe" enable=yes profile=private description="Phone remote for PCTV Home"'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="PCTV Home"'
!macroend
