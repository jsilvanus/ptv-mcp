import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch, ApiError, errorMessage } from '../api/client';
import type { Member, MembershipRole } from '../api/types';
import { ROLE_LABELS, ROLES } from '../auth/roles';
import { TenantSettingsPanel } from './TenantSettingsPanel';

export function MembersPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MembershipRole>('viewer');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [rowError, setRowError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const loadMembers = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setLoadError(null);
    setForbidden(false);
    try {
      const list = await apiFetch<Member[]>(`/tenants/${tenantId}/members`);
      setMembers(list);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        setLoadError(errorMessage(err, 'Could not load members.'));
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  async function handleAdd(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!tenantId) return;
    setAddError(null);
    setAdding(true);
    try {
      await apiFetch<void>(`/tenants/${tenantId}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      });
      setEmail('');
      setRole('viewer');
      await loadMembers();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setAddError('No user is registered with that email.');
      } else {
        setAddError(errorMessage(err, 'Could not add member.'));
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleRoleChange(member: Member, newRole: MembershipRole): Promise<void> {
    if (!tenantId || newRole === member.role) return;
    if (
      !window.confirm(
        `Change ${member.name}'s role from ${ROLE_LABELS[member.role]} to ${ROLE_LABELS[newRole]}?`,
      )
    ) {
      return;
    }
    setRowError(null);
    setPendingUserId(member.userId);
    try {
      await apiFetch<void>(`/tenants/${tenantId}/members/${member.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      });
      await loadMembers();
    } catch (err) {
      setRowError(errorMessage(err, 'Could not change role.'));
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleRemove(member: Member): Promise<void> {
    if (!tenantId) return;
    if (!window.confirm(`Remove ${member.name} (${member.email}) from this tenant?`)) {
      return;
    }
    setRowError(null);
    setPendingUserId(member.userId);
    try {
      await apiFetch<void>(`/tenants/${tenantId}/members/${member.userId}`, {
        method: 'DELETE',
      });
      await loadMembers();
    } catch (err) {
      setRowError(errorMessage(err, 'Could not remove member.'));
    } finally {
      setPendingUserId(null);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h1>Members</h1>
        <p className="error">You don't have permission to manage members for this tenant.</p>
      </div>
    );
  }

  return (
    <div>
      <h1>Members</h1>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : loadError ? (
        <p className="error">{loadError}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>
                  <select
                    value={m.role}
                    disabled={pendingUserId === m.userId}
                    onChange={(e) => void handleRoleChange(m, e.target.value as MembershipRole)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    disabled={pendingUserId === m.userId}
                    onClick={() => void handleRemove(m)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  No members yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {rowError && <p className="error">{rowError}</p>}

      <h2 style={{ marginTop: 24 }}>Add a member</h2>
      <p className="muted">The user must already have an account before they can be added.</p>
      <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
        <input
          type="email"
          placeholder="Email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as MembershipRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button type="submit" className="primary" disabled={adding}>
          {adding ? 'Adding…' : 'Add'}
        </button>
      </form>
      {addError && <p className="error">{addError}</p>}

      {tenantId && <TenantSettingsPanel tenantId={tenantId} />}
    </div>
  );
}
