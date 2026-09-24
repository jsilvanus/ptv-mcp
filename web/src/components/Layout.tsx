import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useTenants } from '../tenants/TenantContext';
import { ROLE_LABELS, roleAtLeast } from '../auth/roles';

export function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { tenants, currentTenantId, currentTenant, setCurrentTenantId } = useTenants();

  async function handleLogout(): Promise<void> {
    await logout();
    navigate('/login');
  }

  const canReviewProposals = roleAtLeast(currentTenant?.role, 'contributor');

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <nav
        className="card"
        style={{
          width: 220,
          borderRadius: 0,
          borderTop: 'none',
          borderLeft: 'none',
          borderBottom: 'none',
        }}
      >
        <h2>PTV MCP</h2>

        <p>
          <label htmlFor="tenant-switcher">Tenant</label>
          <br />
          <select
            id="tenant-switcher"
            value={currentTenantId ?? ''}
            onChange={(e) => setCurrentTenantId(e.target.value)}
            style={{ width: '100%' }}
          >
            {tenants.length === 0 && <option value="">No tenants yet</option>}
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.tenantName} ({ROLE_LABELS[t.role]})
              </option>
            ))}
          </select>
        </p>

        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <li>
            <NavLink to="/tenants">Tenants</NavLink>
          </li>
          {currentTenant?.role === 'tenant_admin' && (
            <li>
              <NavLink to={`/tenants/${currentTenantId}/members`}>Members</NavLink>
            </li>
          )}
          <li>
            <NavLink to="/ptv-connections">PTV connection</NavLink>
          </li>
          {currentTenant?.role === 'tenant_admin' && (
            <li>
              <NavLink to={`/tenants/${currentTenantId}/audit-log`}>Audit log</NavLink>
            </li>
          )}
          {canReviewProposals && (
            <li>
              <NavLink to={`/tenants/${currentTenantId}/proposals`}>Proposal queue</NavLink>
            </li>
          )}
          {canReviewProposals && (
            <li>
              <NavLink to={`/tenants/${currentTenantId}/reviews`}>Content review</NavLink>
            </li>
          )}
        </ul>

        <button type="button" onClick={handleLogout}>
          Log out
        </button>
      </nav>

      <main style={{ flex: 1, padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
