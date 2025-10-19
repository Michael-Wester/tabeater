param(
  [string[]]$Targets
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sharedDir = Join-Path $root "src/shared"
$overridesRoot = Join-Path $root "src/overrides"
$distRoot = Join-Path $root "dist"

if (-not (Test-Path $sharedDir)) {
  Write-Error "Shared source folder missing at $sharedDir"
  exit 1
}

if (-not $Targets -or $Targets.Count -eq 0) {
  $Targets = @("firefox", "chrome", "edge")
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null

foreach ($browser in $Targets) {
  $distDir = Join-Path $distRoot $browser
  $overrideDir = Join-Path $overridesRoot $browser

  if (Test-Path $distDir) {
    Remove-Item -Recurse -Force $distDir
  }

  New-Item -ItemType Directory -Force -Path $distDir | Out-Null
  Copy-Item -Path (Join-Path $sharedDir "*") -Destination $distDir -Recurse -Force

  if (Test-Path $overrideDir) {
    Copy-Item -Path (Join-Path $overrideDir "*") -Destination $distDir -Recurse -Force
  } else {
    Write-Warning "No overrides found for '$browser'"
  }

  $resolvedDist = (Resolve-Path $distDir).Path
  Write-Host "Built $browser -> $resolvedDist"
}
