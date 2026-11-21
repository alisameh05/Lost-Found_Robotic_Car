param([switch]$Offline, [switch]$Application)
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '../..')
try {
    $env:UV_CACHE_DIR = Join-Path (Get-Location) '.local-runtime/uv-cache'
    $pythonRoot = '.local-runtime/python'
    $python = "$pythonRoot/cpython-3.11.14-windows-x86_64-none/python.exe"
    if (-not (Test-Path -LiteralPath $python)) {
        if ($Offline) { throw 'Python 3.11.14 is missing; run deliberate online setup first.' }
        uv python install 3.11.14 --install-dir $pythonRoot
        if ($LASTEXITCODE) { throw 'Python setup failed.' }
    }
    $runtimePython = '.local-runtime/venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $runtimePython)) {
        uv venv .local-runtime/venv --python $python --no-managed-python --offline
        if ($LASTEXITCODE) { throw 'Virtual environment setup failed.' }
    }
    & $runtimePython -c 'import sys; sys.exit(0 if sys.version_info[:3] == (3, 11, 14) else 1)'
    if ($LASTEXITCODE) { throw 'The local runtime must use CPython 3.11.14.' }
    & $runtimePython -m ensurepip
    if ($LASTEXITCODE) { throw 'Installer setup failed.' }
    $locks = @('-r', 'experiments/vision/requirements.lock')
    if ($Application) { $locks += @('-r', 'backend/requirements.lock') }
    if (-not $Offline) {
        & $runtimePython -m pip download --no-deps --require-hashes --only-binary=:all: `
            @locks --dest .local-runtime/wheels `
            --extra-index-url https://download.pytorch.org/whl/cu124
        if ($LASTEXITCODE) { throw 'Wheel download failed.' }
    }
    & $runtimePython -m pip install --no-index --find-links .local-runtime/wheels `
        --require-hashes @locks
    if ($LASTEXITCODE) { throw 'Pinned installation failed.' }
    # Both upstream packages declare cv2 providers. Install the pinned contrib
    # build last so optional modules do not depend on wheel installation order.
    & $runtimePython -m pip install --no-index --find-links .local-runtime/wheels `
        --no-deps --force-reinstall --require-hashes -r experiments/vision/opencv-contrib.lock
    if ($LASTEXITCODE) { throw 'OpenCV contrib setup failed.' }
    & $runtimePython -m pip check
    if ($LASTEXITCODE) { throw 'Dependency consistency check failed.' }
    & $runtimePython -m experiments.vision.package_inventory
    if ($LASTEXITCODE) { throw 'Notice inventory failed.' }
    if (-not $Offline) {
        & $runtimePython -m experiments.vision.setup_assets .local-runtime/assets
        if ($LASTEXITCODE) { throw 'Asset setup failed.' }
    } elseif ($Application) {
        & $runtimePython -m experiments.vision.setup_assets .local-runtime/assets --verify
        if ($LASTEXITCODE) { throw 'Offline asset verification failed.' }
    }
} finally {
    Pop-Location
}
