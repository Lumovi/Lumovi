; What Lumovi writes for itself on Windows as it runs, removed with it: the lumovi:// links it
; opens, under the person's own classes. (An update keeps it: the new version writes it again.)
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\lumovi"
  ${endIf}
!macroend
