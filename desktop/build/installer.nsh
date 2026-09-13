; Custom NSIS hooks for a self-healing Windows install.
;
; preInit runs FIRST in .onInit — before electron-builder's app-running / overwrite
; checks — so we repair a broken/stale/locked previous install here automatically.
; This is what stops the "PoE2 Dashboard cannot be closed" failure for non-technical
; users: no manual process-killing, folder deletion, or reboot required.
;
; Everything is done in one best-effort PowerShell call (present on Win10/11). A
; failure here must never block the install, so all errors are swallowed.
;
; NSIS escaping: $$ = literal '$' (so PowerShell's $_/$env/$d survive), $\" = literal
; double-quote (wraps the -Command argument).

!macro preInit
  nsExec::Exec "powershell -NoProfile -ExecutionPolicy Bypass -Command $\"$$ErrorActionPreference='SilentlyContinue'; $$dir=Join-Path $$env:LOCALAPPDATA 'Programs\poe2-dashboard-desktop'; Get-Process | Where-Object { $$_.ProcessName -eq 'PoE2 Dashboard' -or ($$_.Path -and $$_.Path -like (Join-Path $$dir '*')) } | Stop-Process -Force; Start-Sleep -Milliseconds 600; if (Test-Path $$dir) { Remove-Item -LiteralPath $$dir -Recurse -Force }; Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $$_.PSPath).DisplayName -match 'PoE2 Dashboard' } | Remove-Item -Recurse -Force$\""
  Pop $0
!macroend

; customInit runs after preInit — report the (now cleaned-up) state to the server so
; we can confirm the self-heal worked and diagnose anything that still slips through.
!macro customInit
  nsExec::Exec "powershell -NoProfile -ExecutionPolicy Bypass -Command $\"$$ErrorActionPreference='SilentlyContinue'; $$r=@(); $$r+='os='+[Environment]::OSVersion.VersionString; $$r+='user='+$$env:USERNAME; $$r+='== running procs (post-heal) =='; $$r+=(Get-Process | ? { $$_.ProcessName -match 'PoE2|electron|dashboard' } | Select Id,ProcessName,Path | Format-Table -Auto | Out-String); $$r+='== existing install (post-heal) =='; $$r+=(Get-ChildItem (Join-Path $$env:LOCALAPPDATA 'Programs') -EA 0 | ? { $$_.Name -match 'poe2|dashboard' } | Select Name | Out-String); try { Invoke-RestMethod -Uri 'http://192.168.1.250:8080/api/installlog?p=init' -Method Post -Body ($$r -join [Environment]::NewLine) -TimeoutSec 8 } catch {}$\""
  Pop $0
!macroend
