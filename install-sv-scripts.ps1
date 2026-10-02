<#
Deploy the two SV2-side scripts into the host's scripts folder.

Usage:
  powershell -File install-sv-scripts.ps1
  powershell -File install-sv-scripts.ps1 -WhatIf
  powershell -File install-sv-scripts.ps1 -ScriptsDir "<path>"

NOTE: this file is deliberately ASCII-only.
      Windows PowerShell 5.1 reads a .ps1 without a BOM using the system ANSI code
      page (936 here), which turns any non-ASCII text into mojibake and can even
      produce syntax errors. ASCII output works on both 5.1 and 7.x.
      The Chinese explanation lives in README.md.

Why this step exists:
  The DSH plugin runs OUTSIDE the host process, so it cannot make Synthesizer V
  Studio load a script. Scripts can only be placed in the host's scripts folder by
  the user, and then started once from the Scripts menu. That is the host's
  security boundary, not a choice of ours.

Reminders:
  * The bridge is a RESIDENT script and does NOT hot-reload. After overwriting the
    files you must stop the old instance ([Scripts] > [Abort All Running Scripts],
    or restart the host) and run [Scripts] > [DSH] > [DSH Bridge] again.
  * The panel script needs the host to reload scripts (reopen the side panel or
    restart the host).
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # Auto-detected by default; pass explicitly to target another host version.
  [string]$ScriptsDir
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'plugin\sv'

$files = @('DSHBridge.lua', 'DSHPanel.js')

function Resolve-Sv2ScriptsDir {
  $candidates = @(
    (Join-Path $env:APPDATA 'Dreamtonics\Synthesizer V Studio 2\scripts'),
    (Join-Path $env:USERPROFILE 'Documents\Dreamtonics\Synthesizer V Studio 2\scripts')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

if (-not $ScriptsDir) {
  $ScriptsDir = Resolve-Sv2ScriptsDir
}

if (-not $ScriptsDir) {
  Write-Host 'ERROR: could not find the SV2 scripts folder.' -ForegroundColor Red
  Write-Host 'Open [Scripts] > [Open Scripts Folder] in SV2, then re-run with:'
  Write-Host '  powershell -File install-sv-scripts.ps1 -ScriptsDir "<that folder>"'
  exit 1
}

if (-not (Test-Path -LiteralPath $ScriptsDir)) {
  Write-Host "ERROR: scripts folder does not exist: $ScriptsDir" -ForegroundColor Red
  Write-Host 'Open [Scripts] > [Open Scripts Folder] in SV2 once so the host creates it.'
  exit 1
}

$target = Join-Path $ScriptsDir 'DSH'

Write-Host "source : $source"
Write-Host "target : $target"
Write-Host ''

if ($PSCmdlet.ShouldProcess($target, 'create folder and copy scripts')) {
  if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Path $target | Out-Null
    Write-Host "created $target"
  }

  # The channel folder must exist BEFORE the bridge runs: the bridge lives inside
  # the host and Lua cannot mkdir, so it can only pick a folder that already
  # exists. The probe measured bridgeDirExists=false, so the bridge would fail to
  # start without this. The DSH plugin also creates it, but ordering is not
  # guaranteed -- creating it here is the cheap fix.
  $ipcDirs = @(
    (Join-Path $env:USERPROFILE '.dsh\sv-bridge'),
    (Join-Path $env:TEMP 'dsh-sv-bridge')
  )
  foreach ($d in $ipcDirs) {
    if (-not (Test-Path -LiteralPath $d)) {
      try {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Host "created channel folder $d"
      } catch {
        Write-Host "WARN: could not create $d (the bridge will try the other candidate)" -ForegroundColor Yellow
      }
    } else {
      Write-Host "channel folder already exists: $d"
    }
  }

  foreach ($name in $files) {
    $from = Join-Path $source $name
    if (-not (Test-Path -LiteralPath $from)) {
      Write-Host "ERROR: missing source file: $from" -ForegroundColor Red
      exit 1
    }
    $to = Join-Path $target $name

    # Keep one backup: the bridge is resident, so rollback should be easy.
    if (Test-Path -LiteralPath $to) {
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $bak = "$to.bak-$stamp"
      Copy-Item -LiteralPath $to -Destination $bak -Force
      Write-Host "backed up $name -> $(Split-Path -Leaf $bak)"
    }

    Copy-Item -LiteralPath $from -Destination $to -Force
    $hash = (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash.Substring(0, 12)
    Write-Host ("deployed {0}  (sha256 {1}..., {2} bytes)" -f $name, $hash, (Get-Item -LiteralPath $to).Length)
  }

  Write-Host ''
  Write-Host 'Next steps (must be done inside the host):' -ForegroundColor Yellow
  Write-Host '  1. SV2: [Scripts] > [Rescan]'
  Write-Host '  2. if the bridge already ran: [Scripts] > [Abort All Running Scripts]'
  Write-Host '     (resident scripts do NOT hot-reload -- the old instance must go)'
  Write-Host '  3. run [Scripts] > [DSH] > [DSH Bridge]'
  Write-Host '  4. open the [DSH] panel from the side bar'
  Write-Host ''
  Write-Host 'NOTE: the two probe scripts from P0 are NOT deployed by this script.'
  Write-Host '      If ProbePanel.lua is still in the scripts folder, delete it -- the'
  Write-Host '      P0 probe has already served its purpose.'
}
