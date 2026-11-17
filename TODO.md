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
