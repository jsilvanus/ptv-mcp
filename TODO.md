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

- [ ] **6. v11 writes can be built on a stale published version (partly
      fixed).** Service, channel and connection writes now fall back to the
      public read only on 404. Still open: organisations have no `/active`
      read; `applyConnectionChange` has no `Modified` check.
- [ ] **8. Kept connections are resent in read shape.** `relationToWrite`
      (`src/ptv/v11/connectionWrite.ts`) can lose fax numbers and addresses;
      verify on the test environment.
- [ ] **9. Service and connection writes are not atomic.** A failure of the
      second PUT leaves PTV with half the change; record which step failed.
- [ ] **10. OAuth grant scope is not enforced everywhere.** Resolve and manual
      publish use the proposal's environment; `resourceToolContext` takes the
      tenant from the resource URI.
