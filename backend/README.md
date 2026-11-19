# Local records backend

Use two PowerShell 7 terminals on Windows x64. The tested records interpreter is CPython 3.11.14 with SQLite 3.50.4. The frontend uses Node 24.19.0 and npm 11.17.0. The hash lock keeps the records and vision experiment pins aligned where they share dependencies. The records process imports no vision packages or hardware adapters.

## Install

From the repository root, use uv 0.10.4 to install an isolated interpreter and the locked dependencies. This setup downloads the interpreter and wheels.

```powershell
uv python install 3.11.14 --install-dir .local-runtime/python --cache-dir .local-runtime/uv-cache
$recordsInterpreter = '.local-runtime/python/cpython-3.11.14-windows-x86_64-none/python.exe'
uv venv .local-runtime/records --python $recordsInterpreter --no-managed-python --offline --cache-dir .local-runtime/uv-cache
$recordsPython = '.local-runtime/records/Scripts/python.exe'
uv pip sync backend/requirements.lock --require-hashes --only-binary :all: --python $recordsPython --cache-dir .local-runtime/uv-cache
```

Install the Node dependencies from `frontend` with `npm.cmd ci`. Install the Playwright Chromium build for browser verification with `node node_modules/@playwright/test/cli.js install chromium` from the same directory.

## Start

From the repository root in the backend terminal:

```powershell
.local-runtime/records/Scripts/python.exe -m backend.app
```

From the repository root in the frontend terminal:

```powershell
Set-Location frontend
$env:npm_config_script_shell = (Get-Process -Id $PID).Path
$env:LAF_MODE = 'records'
npm.cmd run build
npm.cmd start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Dashboard and Objects show an empty history on first use. Register Object saves a JPEG or PNG reference and selected rectangle to a new Lost record. Settings starts at seven days and previews the immediate impact before you confirm a change. Devices shows the records service and unqualified search paths. Shutdown uses Ctrl+C in each terminal. Running the installed application uses local assets and loopback HTTP.

| Environment variable | Default | Where to set it |
| --- | --- | --- |
| `LAF_FRONTEND_PORT` | `3000` | Both terminals. The backend derives the allowed browser Origin from this value. |
| `LAF_BACKEND_PORT` | `8000` | Both terminals. Browse to the frontend port. |
| `LAF_DATA_ROOT` | `%LOCALAPPDATA%\LostAndFound` | Backend terminal. Use an absolute application directory under `LOCALAPPDATA`. |
| `LAF_MODE` | Disconnected | Frontend terminal. Use `records` for the local backend or `fixture` for the browser-only sample application. |
| `LAF_SIMULATION_PROFILE` | Unset | Backend terminal. Set `fixture-v1` before starting to enable the protected simulator. |

With the profile enabled, open an eligible saved Lost object and select **Open Search Setup**. The robot preview displays **Backend simulation · Disarmed**. Select Gestures or PS4, acquire control, wait for readiness, and choose **Start Search**. The simulator supplies neutral input, a held forward input, and release. Watch the selected input feedback and motion permission in the Live Search Workspace. The proximity advisory follows simulated samples independently of permission. Pause keeps the target and mode locked. Stop Search saves an ended attempt and keeps the object Lost. Emergency Stop remains available during saves. Other tabs can spectate, and releasing control pauses an active search. The versioned profile and sample provenance are in [preview_fixture](app/preview_fixture). Stop and restart the backend to change profiles.

Each service reports an occupied port and exits. Only one backend owns a data root, even across different ports. Close the owner before changing its configuration. The OS releases the lock on process exit. Keep the database, its SQLite sidecars and the managed media together under the local root. SQLite uses WAL and synchronous FULL, enables foreign keys on every connection, and applies migration SQL and its receipt in one immediate transaction. Registration flushes the normalized reference into staging, journals the preparation, and promotes the file before committing the object, Ready media and receipt together. Restart rolls back interrupted preparations and preserves committed references.

The backend checks expiry at startup and in the running service. Expiry uses the saved retention period and original registration time. The backend journals owned paths, removes managed copies, then deletes the owner and its dependent rows and receipts. Searching and Paused sessions keep access to their owner until the session ends. On restart, interrupted sessions end before the purge runs.

Settings, Devices and Object Details report cleanup progress. A cleanup fault keeps expired records inaccessible and blocks new registration. The backend retries cleanup after managed storage is repaired and resumes incomplete work on restart. Health stays available with the current capability. If a save response is interrupted, use Retry Same Request to recover the result.

Object Details links to saved sessions and their captured matches. Startup ends unfinished sessions as Interrupted and keeps durable pending captures as Not reviewed. Missing or corrupt evidence leaves the saved outcome intact. Fresh installations have empty histories. Records views revalidate over HTTP on focus, reconnect and visible-tab polling. The simulation profile enables Start, Pause, Stop Search, and Emergency Stop.

## Verify

From the repository root:

```powershell
$recordsPython = '.local-runtime/records/Scripts/python.exe'
& $recordsPython -m pytest backend/tests
& $recordsPython -m ruff check --config backend/pyproject.toml backend
& $recordsPython -m mypy --config-file backend/pyproject.toml backend/app backend/contracts
& $recordsPython -m backend.contracts.export --check
```

Run `npm.cmd run verify` from `frontend` with the same PowerShell npm script setting above. The browser suite starts temporary backends and uses temporary SQLite roots. The initialization journey holds the actual storage initialization in its test process until the browser reads the live 503 diagnostic. Its frontend ports are 3100–3103 and its records backend port is 8110. Set `LAF_TEST_PYTHON` to an absolute path when using a different Python environment with the locked dependencies.

Refresh exports with `python -m backend.contracts.export` using the installed environment, then run `npm.cmd run contracts:generate` in `frontend`. The [wire manifest](contracts/v1/openapi.json) includes later operations. Its `x-laf-records-runtime` flag identifies the mounted HTTP operations. Backend tests compare the exports with the approved API and verify that the mounted routes agree. Frontend contract checks validate existing fixture payloads and frame vectors against the generated definitions.
