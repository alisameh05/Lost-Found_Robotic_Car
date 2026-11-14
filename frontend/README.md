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

`LAF_MODE=fixture` opts into sample data. Omit it or set it to `disconnected` for the unavailable application state. The reserved backend base address is `http://127.0.0.1:8000/api/v1`. Change its port using `LAF_BACKEND_PORT`. Backend connection support is planned for a later phase. Fixture bootstrap context stays in request memory. Production and development previews use the same runtime composition.

Install dependencies and the test browser while online. Normal fixture use works with local assets. Node.js 24 is an LTS line and Next.js 16 supports Node.js 20.9 or later. Exact direct dependency versions, including Next.js, React, TypeScript and testing tools, are recorded in [package.json](package.json). [Node.js release schedule](https://nodejs.org/en/about/previous-releases), [Next.js installation requirements](https://nextjs.org/docs/app/getting-started/installation).

## Verification

```powershell
npx.cmd playwright install chromium
npm.cmd run verify
```

| Command | Checks |
| --- | --- |
| `npm run contracts:generate` | Extract the v1 schema and read endpoints from `docs/API.md` and regenerate TypeScript. |
| `npm run contracts:check` | Fail on seed or generated TypeScript drift. |
| `npm run lint` | Check lint and frontend import directions. |
| `npm run typecheck` | Generate Next.js route types and check strict TypeScript. |
| `npm test` | Verify accessible shell navigation and validate fixture responses. |
| `npm run build` | Create the local production build. |
| `npm run test:e2e` | Test both modes against the production build on loopback ports 3100 and 3101. |

The contract generator normalizes line endings before hashing the versioned API document. The seed retains the full constraints for the selected read contracts and their dependencies. Ajv verifies these constraints against fixture payloads.

Instrument Sans Variable ships from the pinned Fontsource package under the [SIL Open Font License](Instrument-Sans-LICENSE.txt). The sidebar uses local Lucide icons distributed under the [Lucide license notices](Lucide-LICENSE.txt).
