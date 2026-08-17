$ErrorActionPreference = 'Continue'
$repo = 'https://github.com/yiyuanrvk77/qneural.git'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ''
Write-Host '============================================'
Write-Host '  QNEURAL - PUSH TO GITHUB'
Write-Host '============================================'
Write-Host ''

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host '[ERROR] Git not found.' -ForegroundColor Red
  Write-Host 'Install: https://git-scm.com/download/win'
  return
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host '[ERROR] GitHub CLI (gh) not found.' -ForegroundColor Red
  Write-Host 'Install: https://cli.github.com'
  return
}

& gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Not logged in. A browser will open.'
  Write-Host 'Choose: GitHub.com > HTTPS > Login with a web browser'
  Write-Host ''
  & gh auth login
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[ERROR] Login not completed.' -ForegroundColor Red
    return
  }
}

& gh auth setup-git

$tmp = Join-Path $env:TEMP ('qneural_push_' + (Get-Random -Maximum 999999))
Write-Host 'Cloning remote repo...'
& git clone $repo $tmp 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host '[ERROR] Clone failed. Check repo name and permissions.' -ForegroundColor Red
  return
}

Write-Host 'Copying updated files...'
Get-ChildItem $here -Force | ForEach-Object {
  Copy-Item $_.FullName -Destination $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# Protect API key: remove the local data folder before committing
$dataDir = Join-Path $tmp 'data'
if (Test-Path $dataDir) { Remove-Item $dataDir -Recurse -Force }

Push-Location $tmp
& git add -A
& git commit -m 'feat: embedded vision + neural depth preview (v1.2.0)' 2>&1 | Out-Null
& git push origin
$ok = ($LASTEXITCODE -eq 0)
Pop-Location

Write-Host ''
if ($ok) {
  Write-Host 'DONE. Pushed to: https://github.com/yiyuanrvk77/qneural' -ForegroundColor Green
} else {
  Write-Host '[ERROR] Push failed. See messages above.' -ForegroundColor Red
}

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
