import { useEffect, useState } from 'react';
import { apiFetch, ApiError } from '../api/client';
import type { TenantSettings } from '../api/types';

/** Tenant-admin settings shown on the members page; currently just four-eyes. */
export function TenantSettingsPanel({ tenantId }: { tenantId: string }) {
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<TenantSettings>(`/tenants/${tenantId}/settings`)
      .then(setSettings)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : 'Could not load settings.'),
      );
  }, [tenantId]);

  async function toggleFourEyes(requireFourEyes: boolean): Promise<void> {
    if (
      !requireFourEyes &&
      !window.confirm(
        'Switch four-eyes off? Members can then approve their own proposals and use the direct export/apply tools.',
      )
    ) {
      return;
    }
    setError(null);
    setSaving(true);
    try {
      setSettings(
        await apiFetch<TenantSettings>(`/tenants/${tenantId}/settings`, {
          method: 'PUT',
          body: JSON.stringify({ requireFourEyes }),
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ marginTop: 24 }}>
      <h2>Settings</h2>
      {settings && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={settings.requireFourEyes}
            disabled={saving}
            onChange={(e) => void toggleFourEyes(e.target.checked)}
          />
          Four-eyes review (neljän silmän periaate)
        </label>
      )}
      <p className="muted">
        When on, nobody can approve a proposal they created, and changes can only reach PTV through
        a proposal resolved by another member. Switch off only if one person handles PTV alone.
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
