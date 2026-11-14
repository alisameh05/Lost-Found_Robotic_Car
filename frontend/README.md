# Lost & Found frontend

The Phase 01 fixture application runs locally on Windows. The eleven previews use synthetic records. The fixture shell requires Node and a browser.

## Setup and startup

Install Node.js 24.19.0 LTS with npm 11.17.0. From PowerShell in the repository root:

```powershell
Set-Location frontend
npm.cmd ci
Copy-Item .env.example .env.local
npm.cmd run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). For a production preview, stop the development server and run `npm.cmd run build` followed by `npm.cmd start`.

Both servers bind only to `127.0.0.1`. Set `$env:LAF_FRONTEND_PORT = '3100'` in PowerShell before starting to use another port. If the configured port is occupied, free it or explicitly choose a different port and restart.

`LAF_MODE=fixture` opts into sample data. Add `LAF_FIXTURE_HARNESS=1` to show development and test controls on the Dashboard. Select a scenario to replace the fixture transport and its snapshot. Reset repeats the selected scenario from its fixed time, and refresh returns to idle. The media preview uses temporary object URLs. Use **Expire sample media** to advance the fixture clock and clear an eligible image. The preview's data and clock belong to the Dashboard harness instance.

In **Shared control specimens**, choose **Commit** or **Fail**, enter a sample label and select **Save sample**. **Deliver save result** resolves the waiting request with the outcome chosen at submission. **Load data** shows a loading state and then an unavailable read. **Retry read** returns an empty result. **Inspect sample media** opens an inline panel alongside the reserved action slot. The slot check displays a local acknowledgment.

Omit `LAF_MODE` or set it to `disconnected` for the unavailable application state. The reserved backend base address is `http://127.0.0.1:8000/api/v1`. Change its port using `LAF_BACKEND_PORT`. Backend connection support is planned for a later phase. Fixture bootstrap context and the scripted cursor, preview and media paths use only in-memory synthetic values.

Install dependencies and the test browser while online. Normal fixture use works with local assets. Node.js 24 is an LTS line and Next.js 16 supports Node.js 20.9 or later. Exact direct dependency versions, including Next.js, React, TypeScript and testing tools, are recorded in [package.json](package.json). [Node.js release schedule](https://nodejs.org/en/about/previous-releases), [Next.js installation requirements](https://nextjs.org/docs/app/getting-started/installation).

## Verification

```powershell
npx.cmd playwright install chromium
npm.cmd run verify
```

| Command | Checks |
| --- | --- |
| `npm run contracts:generate` | Extract the v1 schema and endpoint catalogue from `docs/API.md` and regenerate HTTP, event and frame TypeScript types. |
| `npm run contracts:check` | Fail on seed or generated TypeScript drift or on fixture validation failures. |
| `npm run lint` | Check lint and frontend import directions. |
| `npm run typecheck` | Generate Next.js route types and check strict TypeScript. |
| `npm test` | Verify accessible navigation, fields, pending actions and read retry, and validate fixture responses and binary vectors. |
| `npm run contracts:fixtures` | Run the public contract and fixture checks on their own. |
| `npm run build` | Create the local production build. |
| `npm run test:e2e` | Test both modes against the production build on loopback ports 3100 and 3101. |

The seed records the API document version, its line-ending-normalized SHA-256 and the endpoint catalogue. Ajv verifies the complete Draft 2020-12 definitions against fixture payloads. The contract checks also validate relationships between resources, readiness and profile bounds, and binary frame envelopes. Deliberately invalid vectors are exercised separately. In Phase 04, replace the documentation-derived generation input with backend-owned OpenAPI plus event and frame exports. Compare wire fields, required/nullability rules, enums, limits and fixture validation against this baseline before removing the seed.

Frame admission checks the bounds, metadata and bytes of the known synthetic JPEG. General JPEG decoding and live display acknowledgment belong to the later workspace implementation. Scripted registration requests accept the catalogue's synthetic JPEG or PNG so tests can exercise envelopes and outcomes without uploading personal imagery.

Instrument Sans Variable weights 400–700 ship as local WOFF2 files from the pinned Fontsource package under the [SIL Open Font License](Instrument-Sans-LICENSE.txt). Navigation and controls use bundled Lucide icons distributed under the [Lucide license notices](Lucide-LICENSE.txt). The fixture adapter bundles original synthetic 32 × 24 JPEG and PNG swatches generated with System.Drawing. The swatches are repository-authored assets with no third-party source.

The shared-controls Playwright check captures the 1440 × 960 baseline, the 1366 × 768 media specimen and 200% text enlargement with external browser requests blocked. Run `npm.cmd run test:e2e -- controls.spec.ts --reporter=html` after building to view the screenshots and computed contrast results together.
