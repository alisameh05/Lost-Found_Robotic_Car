# Project guidance

## Local GitHub CLI access

On this Windows host, Codex's offline sandbox cannot read the signed-in GitHub CLI configuration or reach GitHub. For `gh` commands, use `exec_command` with `sandbox_permissions: "require_escalated"` from the first attempt. Invoke one direct `gh` command per call so the existing command rules can match it. The rules allow common read-only commands; GitHub writes still require the normal approval review. Do not copy credentials into the workspace, print a token, or refresh authentication because a sandboxed `gh` command says "Access is denied". If an outside-sandbox command fails, diagnose and report its actual error.

## Project documents

Read the documents relevant to the task: `docs/PRD.md`, `docs/TRD.md`, `docs/ARCHITECTURE.md`, and `docs/IMPLEMENTATION_GUIDE.md`.

## Agent skills

### Issue tracker

Track issues and specs in `alisameh05/Lost-Found_Robotic_Car` on GitHub. See `docs/agents/issue-tracker.md`.

### Triage labels

Use `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`, created when needed. See `docs/agents/domain.md`.
