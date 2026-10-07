# 生成独立分发包 —— 一条命令把 sv-dsh 打成自包含的文件夹
#
# 为什么要有它:分发包是**构建产物**,不该和源码并排放(会重复 44 MB 的 py-deps)。
# 需要交付时跑一次即可。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-package.ps1
#   powershell ... -File tools\make-package.ps1 -Out "D:\某处\sv-dsh-standalone"

param(
  [string]$Out = "$env:USERPROFILE\Desktop\sv-dsh-standalone"
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot   # sv-dsh\
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

Write-Host "源:     $src"
Write-Host "目标:   $Out"
Write-Host ""

if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
New-Item -ItemType Directory -Path $Out -Force | Out-Null

# 排除:临时目录、备份、Python 缓存
$xd = @('.piptmp', 'backups', '__pycache__', '.pytest_cache')
foreach ($d in @('plugin', 'tools', 'docs', 'py-deps', 'probe')) {
  $s = Join-Path $src $d
  if (-not (Test-Path $s)) { continue }
  $t = Join-Path $Out $d
  $ex = $xd | ForEach-Object { Join-Path $s $_ }
  robocopy $s $t /E /XD $ex /XF *.pyc /NFL /NDL /NJH /NJS /NP | Out-Null
}

Copy-Item (Join-Path $src 'install-sv-scripts.ps1') $Out -Force
Copy-Item (Join-Path $src 'README.md') $Out -Force

# 包说明(如果源码里有模板就用模板)
$pkgReadme = Join-Path $src 'docs\PACKAGE-README.md'
if (Test-Path $pkgReadme) {
  Copy-Item $pkgReadme (Join-Path $Out 'PACKAGE-README.md') -Force
}

# ---- 自检:确认包能独立跑 ----
Write-Host "=== 自检 ==="
Push-Location (Join-Path $Out 'tools')
try {
  & $node harness.mjs 2>&1 | Select-String -Pattern 'passed$' | ForEach-Object { "  $_" }
  & $node check-lua.mjs '..\plugin\sv\DSHBridge.lua' 2>&1 | ForEach-Object { "  $_" }
  & $node check-plugin.mjs 2>&1 | Select-String -Pattern 'OK:' | ForEach-Object { "  $_" }
  & $node check-client.mjs 2>&1 | Select-String -Pattern 'OK:' | ForEach-Object { "  $_" }
  & $node plugin-tests.mjs 2>&1 | Select-String -Pattern 'OK:' | ForEach-Object { "  $_" }
  & $node panel-tests.mjs 2>&1 | Select-String -Pattern 'OK:' | ForEach-Object { "  $_" }
} finally {
  Pop-Location
}

$sz = (Get-ChildItem $Out -Recurse -File | Measure-Object -Property Length -Sum).Sum
$c = (Get-ChildItem $Out -Recurse -File).Count
Write-Host ""
Write-Host ("完成: {0} 个文件, {1:N1} MB" -f $c, ($sz / 1MB))
