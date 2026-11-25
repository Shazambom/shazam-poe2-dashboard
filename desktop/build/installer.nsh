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

; Shared graceful shutdown sequence for Arbiter.exe (installer preInit, interactive reinstall,
; and uninstaller checkAppRunning). Stops the pure-Python backend first (no GPU context), then
; requests a clean WM_CLOSE (taskkill without /F) and waits up to 8 seconds for Arbiter.exe and
; its Chromium GPU child process to exit naturally before falling back to `taskkill /F /T`.
; Sending TerminateProcess directly into a live Electron 45 GPU process triggered Windows
; VIDEO_SCHEDULER_INTERNAL_ERROR (0x119) BSODs.
!macro stopArbiterGracefully _SKIP_CLOSE_IF_SILENT
  !ifndef _ARBITER_STOP_UID
    !define /math _ARBITER_STOP_UID 0 + 1
  !else
    !define /redef /math _ARBITER_STOP_UID ${_ARBITER_STOP_UID} + 1
  !endif
  nsExec::Exec 'taskkill /F /T /IM "poe2arb-backend.exe"'
  Pop $0
  Push $R0
  !if "${_SKIP_CLOSE_IF_SILENT}" == "1"
    ; Silent auto-updates (/S) are launched by quitAndInstall while Arbiter.exe is already closing;
    ; interactive installs send graceful WM_CLOSE first.
    IfSilent wait_arbiter_exit_${_ARBITER_STOP_UID} request_arbiter_close_${_ARBITER_STOP_UID}
  request_arbiter_close_${_ARBITER_STOP_UID}:
  !endif
    nsExec::Exec 'taskkill /IM "Arbiter.exe"'
    Pop $0
  !if "${_SKIP_CLOSE_IF_SILENT}" == "1"
  wait_arbiter_exit_${_ARBITER_STOP_UID}:
  !endif
    IntOp $R0 0 + 0
  wait_arbiter_loop_${_ARBITER_STOP_UID}:
    nsExec::Exec 'cmd /C tasklist /FI "IMAGENAME eq Arbiter.exe" /NH | find /I "Arbiter.exe"'
    Pop $0
    StrCmp $0 "0" arbiter_still_running_${_ARBITER_STOP_UID} arbiter_exited_${_ARBITER_STOP_UID}
  arbiter_still_running_${_ARBITER_STOP_UID}:
    IntOp $R0 $R0 + 1
    IntCmp $R0 32 kill_arbiter_now_${_ARBITER_STOP_UID} 0 kill_arbiter_now_${_ARBITER_STOP_UID}
    Sleep 250
    Goto wait_arbiter_loop_${_ARBITER_STOP_UID}

  kill_arbiter_now_${_ARBITER_STOP_UID}:
    nsExec::Exec 'taskkill /F /T /IM "Arbiter.exe"'
    Pop $0

  arbiter_exited_${_ARBITER_STOP_UID}:
  Pop $R0
!macroend

; Replaces electron-builder's default _CHECK_APP_RUNNING (which only waits 1.3s before
; Stop-Process -Force) in both installSection and un.checkAppRunning, so uninstalling while
; Arbiter is open also waits up to 8s for uiohook + Chromium GPU teardown before any force-kill.
!macro customCheckAppRunning
  !insertmacro stopArbiterGracefully 0
!macroend

!macro preInit
  ; Force-kill legacy app names first, then stop backend + gracefully close/wait on Arbiter.exe.
  nsExec::Exec 'taskkill /F /T /IM "ShazamDash.exe"'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM "PoE2 Dashboard.exe"'
  Pop $0
  !insertmacro stopArbiterGracefully 1
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
