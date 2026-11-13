<!-- bmad:context -->
<!-- Verified 2026-11-13 against 6a6bbef8ec1b508f5eb331d14662e4d959ea1a80 and current local documents. Managed by bmad-project-context. -->

# Project guidance

Lost and Found is the local Windows operator application for a manually driven camera robot. Product and technical decisions live in the project documents; implementation specifications and tickets live in GitHub issues. Use the following workflow when asked to implement work.

## Policy

- Use the `gh` CLI for issue and PR operations in `alisameh05/Lost-Found_Robotic_Car`. Keep specifications and tickets in GitHub issues only; do not create persistent repository copies. Use temporary files outside the repository for multiline GitHub bodies and remove them afterward.
- Continue the current ticket or its existing PR before selecting another ticket. If no ticket is specified, choose the lowest-numbered open, unassigned `ready-for-agent` implementation ticket whose blockers are all closed. Exclude specification/phase parent issues and tickets already covered by an open PR. Read native blocking relationships; count only open blockers.
- Before implementation, read the complete ticket and comments, its parent specification and comments, blocking issues and any linked PR. Claim the selected ticket and keep work within its acceptance criteria.
- Implement one ticket on a topic branch from current `main`. Preserve unrelated local and staged changes. Complete the ticket's acceptance criteria, relevant tests and required checks before opening its PR. If completion is blocked, report the missing work rather than presenting it as finished.
- Commit and push the completed ticket branch, then open one PR targeting `main`. Include the problem, resulting behavior, actual verification results and `Closes #<ticket-number>`. Keep implementation issues open until merge; this lifecycle takes precedence over generic issue-close/resolve steps in skills.
- Immediately after opening the PR, post the literal comment `@codex review`. Inspect the review response, PR comments and inline review threads. Fix valid actionable findings, explain findings that do not apply, rerun affected checks and request review again after substantive fixes.
- Verify that review covers the current PR head. A review request, pending review or unavailable reviewer is not a completed review; report outstanding review or check failures explicitly.
- Leave the PR open for Alisa to merge. Do not merge it, enable auto-merge or close its ticket before merge. Hand off with the PR link, verification results, review status and any remaining blockers; finish this ticket's handoff before moving to another ticket.

## Where things are

- For implementation, read the relevant requirements in `docs/PRD.md`, technical invariants in `docs/ARCHITECTURE.md`, detailed requirements in `docs/TRD.md` and phase scope/order in `docs/IMPLEMENTATION_PLAN.md`.
- For HTTP, events, frames, errors and retry behavior, read `docs/API.md`. Its approved wire decisions resolve older unresolved API wording without weakening PRD scope or architecture invariants.
- For frontend work, read `docs/design-brief.md` and inspect `pen design/Robot.pen` and the corresponding final-screen exports.
- For issue operations, sub-issues and dependencies, read `docs/agents/issue-tracker.md`. Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix` as described in `docs/agents/triage-labels.md`.
- Use the single-context domain layout: root `GLOSSARY.md` and `docs/adr/`, created when needed. Follow `docs/agents/domain.md` and read applicable existing glossary/ADR material.

## Running and verifying

On this Windows host, Codex's offline sandbox cannot read the signed-in GitHub CLI configuration or reach GitHub. For `gh` commands, use `exec_command` with `sandbox_permissions: "require_escalated"` from the first attempt. Invoke one direct `gh` command per call so the existing command rules can match it. The rules allow common read-only commands; GitHub writes still require the normal approval review. Do not copy credentials into the workspace, print a token, or refresh authentication because a sandboxed `gh` command says "Access is denied". If an outside-sandbox command fails, diagnose and report its actual error.

- Discover executable checks from the owning manifests, scripts and CI. When a ticket establishes tooling, add and run its required checks. Report unavailable or unperformed checks explicitly; planned commands and architecture trees are not evidence of implemented tooling.

## Conventions that differ from defaults

- Keep frontend presentation separate from backend ownership of records, sessions and device authority. Preserve the approved frontend-first phase order and terminate frontend-phase slices at their fixture boundary.
- Keep fixtures visibly labeled and physical wiring/assembly external. Missing device information blocks only the dependent connection; simulator results do not establish device or physical qualification.

<!-- /bmad:context -->
