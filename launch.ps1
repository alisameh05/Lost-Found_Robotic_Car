$ErrorActionPreference = 'Stop'
$launcherPython = $env:LAF_PYTHON
if (-not $launcherPython) {
    $launcherPython = Join-Path $PSScriptRoot '.local-runtime/venv/Scripts/python.exe'
}
if (-not (Test-Path -LiteralPath $launcherPython -PathType Leaf)) {
    Write-Error 'Python runtime is missing. Run the Windows application setup or set LAF_PYTHON to the installed python.exe.'
}

$launcherPython = (Resolve-Path -LiteralPath $launcherPython).Path
Push-Location -LiteralPath $PSScriptRoot
try {
    & $launcherPython -u -m backend.launcher @args
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
