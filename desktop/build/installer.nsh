; Custom NSIS hook: on every install attempt, gather diagnostics (OS, user, any
; running PoE2/electron processes, existing install dir) and POST them to the
; dashboard server so we can see WHY the install fails on a PC we can't touch.
; PowerShell ships with Win10/11, so no NSIS plugin is required. Best-effort and
; silent — a telemetry failure must never affect the install.
;
; NSIS escaping notes: $$ = literal '$' (so PowerShell's $r/$_/$env survive),
; $\" = literal double-quote (wraps the -Command argument).

!macro customInit
  nsExec::Exec "powershell -NoProfile -ExecutionPolicy Bypass -Command $\"$$r=@(); $$r+='os='+[Environment]::OSVersion.VersionString; $$r+='user='+$$env:USERNAME; $$r+='== running procs =='; $$r+=(Get-Process | ? { $$_.ProcessName -match 'PoE2|electron|dashboard' } | Select Id,ProcessName,Path | Format-Table -Auto | Out-String); $$r+='== tasklist match =='; $$r+=(tasklist /v | Select-String 'PoE2|electron|dashboard' | Out-String); $$r+='== existing install =='; $$r+=(Get-ChildItem (Join-Path $$env:LOCALAPPDATA 'Programs') -EA 0 | ? { $$_.Name -match 'poe2|dashboard' } | Select Name | Out-String); try { Invoke-RestMethod -Uri 'http://192.168.1.250:8080/api/installlog?p=init' -Method Post -Body ($$r -join [Environment]::NewLine) -TimeoutSec 8 } catch {}$\""
!macroend
