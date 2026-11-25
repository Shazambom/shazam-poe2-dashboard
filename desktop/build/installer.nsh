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
  ; Force-kill the bundled backend (pure Python, no GPU process) and legacy names first so
  ; nothing holds a lock on the install dir — poe2arb-backend.exe is the process that broke
  ; updates once the app became self-contained.
  nsExec::Exec 'taskkill /F /T /IM "poe2arb-backend.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "ShazamDash.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "PoE2 Dashboard.exe"'
  Pop $0
  ; During silent auto-updates (/S), wait for Arbiter.exe (and its Chromium GPU child process)
  ; to exit cleanly on its own before falling back to a force-kill. Running `taskkill /F /T`
  ; immediately sends TerminateProcess into a live Chromium GPU process mid-teardown, which
  ; triggered Windows VIDEO_SCHEDULER_INTERNAL_ERROR (0x119) BSODs on Electron 45.
  IfSilent wait_arbiter_exit kill_arbiter_now

  wait_arbiter_exit:
    IntOp $R0 0 + 0
  wait_arbiter_loop:
    nsExec::Exec 'cmd /C tasklist /FI "IMAGENAME eq Arbiter.exe" /NH | find /I "Arbiter.exe"'
    Pop $0
    StrCmp $0 "0" arbiter_still_running arbiter_exited
  arbiter_still_running:
    IntOp $R0 $R0 + 1
    IntCmp $R0 32 kill_arbiter_now 0 kill_arbiter_now
    Sleep 250
    Goto wait_arbiter_loop

  kill_arbiter_now:
    nsExec::Exec 'taskkill /F /T /IM "Arbiter.exe"'
    Pop $0

  arbiter_exited:
  ; DESTRUCTIVE self-heal (delete stale install dir + uninstall registry + shortcuts) is
  ; only for repairing a broken INTERACTIVE fresh install. electron-updater runs the update
  ; installer SILENTLY (/S); doing this deletion mid-update nukes the very install being
  ; upgraded, so the update aborts and the app just closes without upgrading. Skip it when
  ; silent — the checks above already release any locks the update needs.
  IfSilent skip_heal_preinit
  nsExec::Exec "powershell -NoProfile -ExecutionPolicy Bypass -Command $\"$$ErrorActionPreference='SilentlyContinue'; $$dir=Join-Path $$env:LOCALAPPDATA 'Programs\poe2-dashboard-desktop'; Get-Process | Where-Object { $$_.ProcessName -match '^(Arbiter|PoE2 Dashboard|ShazamDash|poe2arb-backend)$$' -or ($$_.Path -and $$_.Path -like (Join-Path $$dir '*')) } | Stop-Process -Force; Start-Sleep -Milliseconds 900; if (Test-Path $$dir) { Remove-Item -LiteralPath $$dir -Recurse -Force }; Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $$_.PSPath).DisplayName -match 'Arbiter|PoE2 Dashboard|ShazamDash' } | Remove-Item -Recurse -Force; foreach ($$n in 'Arbiter','PoE2 Dashboard','ShazamDash') { Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) ($$n+'.lnk')) -Force; Remove-Item (Join-Path ([Environment]::GetFolderPath('StartMenu')) ('Programs\'+$$n+'.lnk')) -Force }$\""
  Pop $0
  skip_heal_preinit:
!macroend
