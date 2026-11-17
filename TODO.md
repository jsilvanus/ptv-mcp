# TODO

Known issues and deferred work that are not part of a phase in
[`PLAN.md`](PLAN.md). Add the date and where the issue was seen; remove an
entry when it is fixed and note the fix in [`EXECUTION_LOG.md`](EXECUTION_LOG.md).

No known issues are open at the moment.

## Open findings from the 2026-11-17 code review

Medium-severity findings that PR #79 did not cover. Details, file names and
suggested fixes are in
[`docs/reviews/2026-11-17-code-review.md`](docs/reviews/2026-11-17-code-review.md)
under the same numbers. Not being fixed now.

- [ ] **6. Organisation drafts cannot be read (v11).** Service, channel and connection writes fall back to the public read only on 404. v11 has no `Organization/active` read, so the `Modified` check in `applyOrganizationChange` compares against the published version only and cannot see a draft or modified organisation. Kept as is until PTV exposes such a read or a live check says otherwise (see `docs/ptv-v11-notes.md`, "Organisations").

## Deployment follow-ups (2026-11-17)

- [ ] First production deploy has not been run: check the Deploy workflow, the Traefik route and `/health` on the host.
- [ ] `/metrics` for Prometheus is not implemented.
- [ ] The Docker image runs as root; switch to the `node` user.
- [ ] v12 write (Phases 10 and 11) waits for DVV's write endpoints; the pilot tenant's v12 read traffic is not yet confirmed.
- [ ] The Drizzle snapshot stops at 0005, so `npm run db:generate` no longer works; migrations 0017 and later are hand-written.
