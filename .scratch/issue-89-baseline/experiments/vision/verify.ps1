$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '../..')
try {
    $python = '.local-runtime/venv/Scripts/python.exe'
    & $python -m unittest discover -s experiments/vision -v
    if ($LASTEXITCODE) { throw 'Probe checks failed.' }
    & $python -m ruff check experiments/vision
    if ($LASTEXITCODE) { throw 'Lint failed.' }
    & $python -m mypy --config-file experiments/vision/pyproject.toml experiments/vision
    if ($LASTEXITCODE) { throw 'Type checking failed.' }
    & $python -m pip check
    if ($LASTEXITCODE) { throw 'Dependency check failed.' }
} finally {
    Pop-Location
}
