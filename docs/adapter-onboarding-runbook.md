# Adapter onboarding runbook

Standard runbook for adding a new PTV adapter implementation (first written in Phase 6, reused in Phase 7+).

## Preconditions

- Shared domain model and `PtvAdapter` contract are stable.
- Target API documentation/spec is available.
- Credential scope decision is made (`user` or `tenant`).
- Tenant/role model and RLS expectations are unchanged.

## Steps

1. **Vendor API spec**
   - Import upstream OpenAPI/Swagger under `src/ptv/<version>/`.
   - Generate wire types (and validators when needed).

2. **Implement read surface**
   - Implement all required read methods against the shared domain model.
   - Verify behavior with contract tests.

3. **Implement authentication**
   - `user` scope: consent/token lifecycle and secure storage in `UserPtvConnection`.
   - `tenant` scope: secure credential storage in `TenantEnvironment`.

4. **Implement write path**
   - Implement write methods and mapping logic.
   - Keep support gated with `PtvAdapterConfig.supports_write` until rollout-ready.

5. **Register adapter in `DbPtvAdapterRegistry`**
   - Add adapter factory wiring keyed by `api_version`.
   - Ensure role checks run before credential lookup.

6. **Enable configuration path**
   - Ensure `PtvAdapterConfig` rows exist for target tenant/environment.
   - Set `supports_read` first; `supports_write` only for staged rollout.

7. **Test hardening**
   - Contract tests against the real adapter.
   - Integration tests for role gating and tenant isolation.
   - Same-user multi-tenant reuse tests for user-scoped credentials.

8. **Operational readiness**
   - Update deployment docs and rollback notes.
   - Add/adjust CI/CD checks and image build paths.
   - Document launch gate evidence in `EXECUTION_LOG.md`.

## Exit criteria

- Read tools are stable in target environment.
- Write path is either production-ready or explicitly gated off.
- Audit trail correctness and multi-tenant isolation are verified.
- Onboarding steps are reproducible for the next adapter version.
