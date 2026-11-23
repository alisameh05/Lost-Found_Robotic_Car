# Lost & Found frontend

The frontend runs locally on Windows and connects to the protected SQLite backend by default. Fixture mode uses labeled synthetic records and device observations and requires only Node and a browser.

Phases 01–03 are completed at the fixture boundary. The 2026-11-17 amendment changes gesture guidance and fixture feedback to finger counts while retaining the screens, API shapes and recovery workflow. The [roadmap](../docs/IMPLEMENTATION_PLAN.md) and [reuse/environment assessment](../docs/TRD.md#21-reuse-and-license-assessment) cover the device and qualification phases.

## Setup and startup

Install Node.js 24.19.0 LTS with npm 11.17.0 and start the [local backend](../backend/README.md#start). In a second PowerShell terminal at the repository root, run the frontend:

```powershell
Set-Location frontend
npm.cmd ci
npm.cmd run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). For a production preview, stop the development server and run `npm.cmd run build` followed by `npm.cmd start`.

Both servers bind only to `127.0.0.1`. The frontend connects to `http://127.0.0.1:8000/api/v1` in records mode. Set `$env:LAF_FRONTEND_PORT = '3100'` in both terminals before starting to use another frontend port. The [backend setup guide](../backend/README.md#start) covers both port settings and the backend profiles for search. If an earlier setup copied `LAF_MODE=fixture` into `frontend/.env.local`, change that line to `LAF_MODE=records` and restart the frontend.

`LAF_MODE=fixture` opts into sample data. Add `LAF_FIXTURE_HARNESS=1` to show development and test controls on the Dashboard. Select a scenario to replace the fixture transport and its snapshot. The selection follows in-app navigation. Reset repeats the selected scenario from its fixed time, and a browser reload returns to idle. The media preview uses temporary object URLs. Use **Expire sample media** to advance the fixture clock and clear an eligible image.

In **Shared control specimens**, choose **Commit** or **Fail**, enter a sample label and select **Save sample**. **Deliver save result** resolves the waiting request with the outcome chosen at submission. **Load data** shows a loading state and then an unavailable read. **Retry read** returns an empty result. **Inspect sample media** opens an inline modeless panel.

Choose **searching**, **paused** or **expiry grace** to exercise **Return to Active Search** and **Emergency Stop**. Try **emergency pending**, **emergency failed** and **emergency network** while the sample save is held open. The shell reports logical motion permission separately from save progress. Press **Emergency Stop** again after an unconfirmed request to retry the same request ID. The opt-in **Fixture mutation requests** log shows the dispatches accepted by the fixture adapter. **Retry snapshot** reads the current snapshot and health again.

Set `LAF_MODE=disconnected` to exercise the unavailable application state without opening a backend connection. Fixture bootstrap context and the scripted cursor, preview and media paths use only in-memory synthetic values.

Install dependencies and the test browser while online. Normal fixture use works with local assets. Node.js 24 is an LTS line and Next.js 16 supports Node.js 20.9 or later. Exact direct dependency versions, including Next.js, React, TypeScript and testing tools, are recorded in [package.json](package.json). [Node.js release schedule](https://nodejs.org/en/about/previous-releases), [Next.js installation requirements](https://nextjs.org/docs/app/getting-started/installation).

## Verification

Run verification from PowerShell 7 with the [locked records environment](../backend/README.md#install) installed. Set the script shell for this process so npm's Windows command shims do not split the `&` in the repository path. Install the browser required by the pinned Playwright version before the first run:

```powershell
$env:npm_config_script_shell = (Get-Process -Id $PID).Path
node node_modules/@playwright/test/cli.js install chromium
npm.cmd run verify
```

| Command | Checks |
| --- | --- |
| `npm run contracts:generate` | Regenerate HTTP, event and frame TypeScript types from backend-owned exports. |
| `npm run contracts:check` | Fail on seed or generated TypeScript drift or on fixture validation failures. |
| `npm run lint` | Check lint and frontend import directions. |
| `npm run typecheck` | Generate Next.js route types and check strict TypeScript. |
| `npm test` | Verify accessible navigation, fields, pending actions and read retry, and validate fixture responses and binary vectors. |
| `npm run contracts:fixtures` | Run the public contract and fixture checks on their own. |
| `npm run build` | Create the local production build. |
| `npm run test:e2e` | Test the production build on ports 3100 (fixture with harness), 3101 (disconnected), 3102 (fixture without harness) and 3103 (default connected startup). Records tests start real temporary backends on 8110. |

The seed records the backend contract version and an export digest. Ajv validates fixture payloads against the published Draft 2020-12 definitions. The contract checks also validate relationships between resources, readiness and profile bounds, and binary frame envelopes. Backend tests compare these exports independently with the approved API, including the wire fields, required and nullable values, enums, and limits.

Search Setup decodes bounded fixture robot frames and reports successful display through the controlling workspace heartbeat. Open Setup from an eligible Lost record, inspect the preview, then select **Acquire control** to check readiness. The opt-in Search Setup fixture controls can freeze or disconnect the preview and restore fresh frames. Registration validates JPEG and PNG files locally and saves their normalized references in fixture memory. Select **registration recovery** to exercise a failed save followed by a Pending request and a lost response. **Retry Same Request** recovers the matching receipt. Playwright uses generated images for registration checks.

In the gesture workspace, the fixture **Hold forward/backward/left/right** actions represent already validated stable counts of 1/2/3/4 fingers; **Release input** represents a valid 0-count neutral. Extra observations exercise five fingers, no hand, multiple hands and a changing count, all stopped and unable to satisfy recovery neutral. These are synthetic adapter observations, not recognition or timing measurements. A fresh neutral and directional hold are required after Start/Resume/recovery. The standalone Control Guide and modeless workspace help share the same mapping. PS4 uses the existing held D-pad and Circle behavior.

Instrument Sans Variable weights 400–700 ship as local WOFF2 files from the pinned Fontsource package under the [SIL Open Font License](Instrument-Sans-LICENSE.txt). Navigation and controls use bundled Lucide icons distributed under the [Lucide license notices](Lucide-LICENSE.txt). The fixture adapter bundles original synthetic 32 × 24 JPEG and PNG swatches generated with System.Drawing. The swatches are repository-authored assets with no third-party source.

The shared-controls Playwright check captures Emergency Stop at 1440 × 960, beside the modeless sample media at 1366 × 768, and at 200% text enlargement with external browser requests blocked. Run `npm.cmd run test:e2e -- controls.spec.ts --reporter=html` after building to view the screenshots and computed contrast results together. The design export puts Emergency Stop beside the live workspace heading. The fixture shell uses a sticky row above the current page so the same action stays reachable across routes and while scrolling.

## Phase 02 handoff

Reuse the root shell, page layout, fields, buttons, feedback, and protected-image lifecycle. Product views read generated types through the injected runtime and `ApplicationTransport`. The adapter owns the scenario, responses and fixture clock. Replacing a scenario disposes its transport, and navigation releases route-local reads, subscriptions, and media URLs. The shell keeps the current snapshot and emergency response in memory while navigating. Phase 02 owns the record, registration, device and settings workflow presentations.

Phase 03 exercises ticketed channels, lease lifecycle, event synchronization, heartbeats, focus and navigation, video, review and deliberate recovery through the fixture adapter. Phase 04 owns backend persistence and schema exports. Later phases qualify the devices and measure physical stopping. The Phase 01 seven-hour allocation is a planning assumption.
