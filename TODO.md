# TODO

Known issues and deferred work that are not part of a phase in
[`PLAN.md`](PLAN.md). Add the date and where the issue was seen; remove an
entry when it is fixed and note the fix in [`EXECUTION_LOG.md`](EXECUTION_LOG.md).

## Known issues

- [ ] **Duplicate `ApplyServiceChange` audit entry (flaky test, possible
      double apply).** Seen 2026-11-17. The integration test "applies a
      queued proposal over REST with approve_and_apply, using the tenant
      write API" (`src/routes/proposals.integration.test.ts`) sometimes
      finds two `ApplyServiceChange` audit entries where it expects one.
      It happened in CI after PR #81 and on the first run of PR #83, and
      passed on re-run. It may be a real race in which one resolution
      applies the change twice despite `ProposalService.claimForApply`, or
      an audit write repeated on a retry path; not yet investigated.
      Deferred: not being fixed now.

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
- [ ] **14. Tenant governance gaps.** Any account can create tenants, the last
      Tenant Admin can leave, removed required reviewers block approval, and
      `addMember` reveals which emails have accounts.
