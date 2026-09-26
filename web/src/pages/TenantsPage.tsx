import { useState, type FormEvent } from 'react';
import { apiFetch } from '../api/client';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useTenants } from '../tenants/TenantContext';
import { ROLE_LABELS } from '../auth/roles';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function TenantsPage() {
  const { tenants, loading, refresh, setCurrentTenantId } = useTenants();
  const [name, setName] = useState('');
  const { busy: submitting, error, run } = useAsyncAction();

  async function handleCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    await run(async () => {
      const created = await apiFetch<{ tenantId: string }>('/tenants', {
        method: 'POST',
        body: JSON.stringify({ name, slug: `${slugify(name)}-${Date.now().toString(36)}` }),
      });
      setName('');
      await refresh();
      setCurrentTenantId(created.tenantId);
    }, 'Could not create tenant.');
  }

  return (
    <div>
      <h1>Tenants</h1>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Your role</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.tenantId}>
                <td>{t.tenantName}</td>
                <td>{t.tenantSlug}</td>
                <td>{ROLE_LABELS[t.role]}</td>
              </tr>
            ))}
            {tenants.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  You don't belong to any tenant yet — create one below.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <h2 style={{ marginTop: 24 }}>Create a tenant</h2>
      <p className="muted">Creating a tenant makes you its Tenant Admin.</p>
      <form onSubmit={handleCreate} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
        <input
          placeholder="Tenant name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
