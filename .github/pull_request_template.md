## Summary

<!-- What does this PR implement, and why? If it corresponds to a phase/stream
in docs/phase-plan.md, name it explicitly. -->

- <!-- Component/stream 1 — what changed and why -->
- <!-- Component/stream 2 — what changed and why -->

<!-- If a real bug was found and fixed along the way (not just the feature
work), call it out explicitly here rather than leaving it buried in the diff. -->

### Notable deviations

<!-- Anything that departs from docs/plan.md or docs/phase-plan.md's original
spec, and why. Full detail belongs in EXECUTION_LOG.md — summarize it here.
Delete this section if there are none. -->

## Test plan

- [ ] `npm run format`, `npm run lint`, `npm run typecheck` all pass
- [ ] `npm test` — unit tests passing
- [ ] `npm run test:integration` — integration tests passing against real Postgres (and PTV's live test environment, where relevant)
- [ ] `npm run build` passes
- [ ] `web/`, if touched: `tsc -b && vite build` and `npm run lint` (oxlint) pass
- [ ] `PLAN.md` / `EXECUTION_LOG.md` updated with sync-point verification and deviations, if this closes a phase
