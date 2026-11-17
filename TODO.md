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
