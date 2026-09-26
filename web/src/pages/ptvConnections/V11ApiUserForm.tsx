import { useState } from 'react';
import { apiFetch, errorMessage } from '../../api/client';
import type { PtvEnvironment, PtvV11ApiUserStatus, TenantMembership } from '../../api/types';
import { EnvironmentSelect } from '../../components/EnvironmentSelect';
import {
  PTV_TEST_API_ACCOUNTS,
  PTV_TEST_ORGANISATIONS,
  TEST_ACCOUNTS_URL,
} from '../../ptv/testOrganisations';
import { FormStatus, type FormStatusValue } from './FormStatus';

const HAS_TEST_API_ACCOUNTS = Object.keys(PTV_TEST_API_ACCOUNTS).length > 0;

/** Saves and tests the tenant's PTV v11 API user (IN-API writes). */
export function V11ApiUserForm({
  tenant,
  onSaved,
}: {
  tenant: TenantMembership | null;
  /** Receives the tenant's v11 API users after a successful save. */
  onSaved(apiUsers: PtvV11ApiUserStatus[]): void;
}) {
  const [environment, setEnvironment] = useState<PtvEnvironment>('test');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiUserOrganisation, setApiUserOrganisation] = useState('');
  const [testOrganisationId, setTestOrganisationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<FormStatusValue | null>(null);

  async function saveAndTest(): Promise<void> {
    if (!tenant || !username.trim() || !password) return;
    setBusy(true);
    setStatus(null);
    try {
      await apiFetch<void>(`/tenants/${tenant.tenantId}/ptv/v11/api-user`, {
        method: 'PUT',
        body: JSON.stringify({
          environment,
          username,
          password,
          ...(environment === 'production' && apiUserOrganisation.trim()
            ? { apiUserOrganisation: apiUserOrganisation.trim() }
            : {}),
          ...(environment === 'test' && testOrganisationId
            ? { organisationId: testOrganisationId }
            : {}),
        }),
      });
      await apiFetch<{ ok: boolean }>(
        `/tenants/${tenant.tenantId}/ptv/v11/api-user/${environment}/test`,
        { method: 'POST' },
      );
      onSaved(
        await apiFetch<PtvV11ApiUserStatus[]>(`/tenants/${tenant.tenantId}/ptv/v11/api-user`),
      );
      setPassword('');
      setStatus({ ok: true, message: `Connected to PTV v11 as API user (${environment}).` });
    } catch (err) {
      setStatus({ ok: false, message: errorMessage(err, 'PTV v11 API login failed.') });
    } finally {
      setBusy(false);
    }
  }

  function pickTestOrganisation(organisationId: string): void {
    setTestOrganisationId(organisationId);
    const account = PTV_TEST_API_ACCOUNTS[organisationId];
    if (account) {
      setUsername(account.username);
      setPassword(account.password);
    }
  }

  return (
    <>
      <h2 style={{ marginTop: 24 }}>Connect a PTV v11 API user</h2>
      <p className="muted">
        The organisation&apos;s PTV API user (issued by DVV for IN-API access) is used for writes.
        It is stored encrypted and belongs to the selected tenant. For the test environment, pick
        one of DVV&apos;s test organisations and use its <code>API…@testi.fi</code> user from{' '}
        <a href={TEST_ACCOUNTS_URL} target="_blank" rel="noopener noreferrer">
          DVV&apos;s public test account list
        </a>
        . A test API user can only write to its own organisation.
      </p>
      {tenant ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{tenant.tenantName}</strong>
          <EnvironmentSelect value={environment} onChange={setEnvironment} />
          {environment === 'test' && (
            <select
              value={testOrganisationId}
              onChange={(e) => pickTestOrganisation(e.target.value)}
              aria-label="Test organisation"
            >
              <option value="">Pick a test organisation…</option>
              {PTV_TEST_ORGANISATIONS.map((organisation) => {
                // Only organisations with a configured API account can be
                // picked; if none are configured, all stay open for manual entry.
                const unavailable =
                  HAS_TEST_API_ACCOUNTS && !PTV_TEST_API_ACCOUNTS[organisation.id];
                return (
                  <option key={organisation.id} value={organisation.id} disabled={unavailable}>
                    {organisation.name} ({organisation.type})
                    {unavailable ? ' — no API account configured' : ''}
                  </option>
                );
              })}
            </select>
          )}
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="API username"
            autoComplete="off"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="new-password"
          />
          {environment === 'production' && (
            <input
              value={apiUserOrganisation}
              onChange={(e) => setApiUserOrganisation(e.target.value)}
              placeholder="apiUserOrganisation (optional)"
              autoComplete="off"
              style={{ minWidth: 280 }}
            />
          )}
          <button
            className="primary"
            onClick={() => void saveAndTest()}
            disabled={
              busy ||
              !username.trim() ||
              !password ||
              (environment === 'test' && !testOrganisationId)
            }
          >
            {busy ? 'Testing…' : 'Save & test'}
          </button>
        </div>
      ) : (
        <p className="muted">Select a tenant first.</p>
      )}
      <FormStatus status={status} />
    </>
  );
}
