# Windows production launcher

## Set up the local release

Use Windows x64 with PowerShell 7, Node.js 24 and npm, and uv on PATH. Run the following from the repository root during setup with internet access. The Python installer downloads the locked Windows wheels and the pinned YOLOE and MediaPipe assets. npm installs the locked Node dependencies. The frontend build uses locally installed fonts and icons.

```powershell
./experiments/vision/setup.ps1 -Application
Push-Location frontend
try {
    $env:npm_config_script_shell = (Get-Process -Id $PID).Path
    $env:NEXT_TELEMETRY_DISABLED = '1'
    npm.cmd ci
    if ($LASTEXITCODE) { throw 'Frontend dependency installation failed.' }
    npm.cmd run build
    if ($LASTEXITCODE) { throw 'Frontend production build failed.' }
} finally {
    Pop-Location
}
```

If the setup wheels and models are already cached, `./experiments/vision/setup.ps1 -Application -Offline` reinstalls the locked Python environment and checks the installed asset hashes. Keep the build's `frontend/.next`, `frontend/node_modules`, the backend and its migrations, and the local Python and model installation available. The setup downloads models for local use. Check the [model and native package notices](../experiments/vision/NOTICES.md) and [font](../frontend/Instrument-Sans-LICENSE.txt) and [icon](../frontend/Lucide-LICENSE.txt) notices before redistributing any release bundle.

## Start and stop

```powershell
./launch.ps1
```

The launcher starts Next.js and a single FastAPI worker on `127.0.0.1`, then opens the default browser when the frontend and protected backend are reachable. Wait for **Records storage ready** before working with records. An unavailable Device qualification profile keeps the search workspace disarmed. Open **Devices** for the affected paths and their next checks. Registration and saved records are available with healthy storage. To open the browser yourself, use `./launch.ps1 --no-browser`.

Press Enter in the launcher window to shut down. Wait for both services to exit before restarting, upgrading the build, or changing configuration. The backend revokes motion permission, stops command renewals, uses the configured STOP path when available, and drains admitted saves. If the launcher reports pending saves or an incomplete shutdown, check History or retry the same request from the app where offered. Startup reconciles unfinished searches as **Interrupted** and starts a fresh control lifecycle.

| Setting | Default and use |
| --- | --- |
| `LAF_PYTHON` | `.local-runtime/venv/Scripts/python.exe`. Set to the absolute path of an existing application environment to reuse it. |
| `LAF_FRONTEND_PORT`, `LAF_BACKEND_PORT` | `3000`, `8000`. Choose distinct ports. The launcher derives the exact frontend origin used by the backend from the same frontend setting. |
| `LAF_DATA_ROOT` | `%LOCALAPPDATA%\LostAndFound`. Use an absolute application directory under `LOCALAPPDATA`, outside source, build and synced folders. Keep the database, sidecars and managed media together across upgrades. |
| `LAF_YOLOE_ASSETS`, `LAF_GESTURE_ASSETS` | `.local-runtime/assets`. Point each at the directory containing its installed model. |
| `LAF_BACKEND_MODE` | `device`. For an explicitly labeled replay, set it to `fixture` with the documented `LAF_SIMULATION_PROFILE`. See the [Phase 06 fixture guide](../backend/PHASE_06.md) and [Device configuration](../backend/PHASE_07_DEVICE_STARTUP.md). |

## Troubleshoot startup

| Launcher or browser state | Operator action |
| --- | --- |
| Missing Python, Node.js, dependencies or build | Complete setup and rebuild the frontend. Check the installed Python path and Node.js PATH. |
| Model missing, unreadable or invalid | Rerun the asset setup or correct the model directory setting. Inspect affected readiness in **Devices**. |
| Port occupied or data root already owned | Use the original running app, or shut it down before launching again. To run a separate test installation, use an isolated data root and free ports. |
| Backend available, checking storage | Wait for migration, retention and startup recovery to complete. An initialization timeout calls for checking the backend output and local storage. |
| Data-root lock inaccessible or storage unavailable | Check folder permissions, free space, and the database diagnostic. Keep the original database and media intact for recovery. An incompatible schema requires a compatible release or a recoverable compatible copy. |
| Frontend or protected health did not become reachable | Check the service named in the error, its console output and configured port. The launcher closes its owned services after a startup failure. |

## Qualification record

Launcher verification uses Windows 11 26H2 x64 (26300.9974), PowerShell 7.6.9, CPython 3.11.14, SQLite 3.50.4, Node 24.21.0, npm 11.19.0, Next.js 16.4.6, and Playwright Chromium 159.0.8154.6. The installed backend used FastAPI 0.163.2 and Uvicorn 0.41.0. The production browser test uses only the two application loopback origins. The Windows Wi-Fi connection stayed enabled for this run. This slice exercises protected records and disarmed Device startup with temporary data roots. The [Phase 06 workload record](../backend/PHASE_06.md#windows-replay-measurements) has the earlier local inference and GPU evidence.

| Release input | Identity and provenance |
| --- | --- |
| Frontend | [npm lock and package integrity](../frontend/package-lock.json), bundled assets under `frontend/.next/static`, local font and icon notices above |
| Python | [backend lock](../backend/requirements.lock) and [native runtime lock](../experiments/vision/requirements.lock), both with wheel hashes |
| Database | [Migration SQL](../backend/app/migrations) and the backend's startup schema and receipt validation |
| Local AI assets | [Asset inventory and SHA-256 values](../experiments/vision/assets.json). The installed YOLOE checkpoint and Hand Landmarker task matched the inventory. |
| Device interfaces | [API v1](API.md), [Uno protocol and build evidence](../backend/PHASE_07_COMMAND.md), and [camera protocol and build evidence](../firmware/ESP32_CAMERA.md). Keep the selected Device bundle and identifiers in local application data. |

Record the source commit and `frontend/.next/BUILD_ID` for the exact release build. To capture the file inventory for a handoff, run from the repository root:

```powershell
$releaseInputs = Get-ChildItem frontend/.next/static,backend/app/migrations -Recurse -File
$releaseInputs | Sort-Object FullName | Get-FileHash -Algorithm SHA256 |
    Select-Object @{ n = 'Path'; e = { Resolve-Path -Relative -LiteralPath $_.Path } }, Hash
Get-FileHash -Algorithm SHA256 -LiteralPath frontend/package-lock.json,backend/requirements.lock,experiments/vision/requirements.lock,experiments/vision/assets.json
```

Repeat the clean-root and populated-root browser journey with `npm.cmd run test:e2e -- launcher.spec.ts --workers=1` from `frontend` after building and installing Playwright Chromium. Set `LAF_TEST_PYTHON` when using an environment outside the checkout. The process and watchdog checks are in `backend/tests/test_process.py` and `backend/tests/test_motion_process.py`. They cover exclusive ownership, recovery after backend death, and simulated command expiry without a STOP acknowledgment. The final release record still needs a host-disconnected run and physical sleep/wake observation.
