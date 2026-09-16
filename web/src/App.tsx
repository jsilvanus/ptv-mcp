import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { TenantProvider, useTenants } from './tenants/TenantContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { TenantsPage } from './pages/TenantsPage';
import { MembersPage } from './pages/MembersPage';
import { PtvConnectionsPage } from './pages/PtvConnectionsPage';
import { PtvCallbackPage } from './pages/PtvCallbackPage';
import { AuditLogPage } from './pages/AuditLogPage';

function ProtectedRoutes() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return (
    <TenantProvider>
      <Layout />
    </TenantProvider>
  );
}

/** `/tenants/:tenantId/members` etc. redirect here first so the URL always names the current tenant explicitly. */
function CurrentTenantRedirect({ suffix }: { suffix: string }) {
  const { currentTenantId } = useTenants();
  if (!currentTenantId) {
    return <Navigate to="/tenants" replace />;
  }
  return <Navigate to={`/tenants/${currentTenantId}${suffix}`} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/ptv-connections/v11/callback" element={<PtvCallbackPage />} />

          <Route element={<ProtectedRoutes />}>
            <Route path="/" element={<Navigate to="/tenants" replace />} />
            <Route path="/tenants" element={<TenantsPage />} />
            <Route path="/tenants/:tenantId/members" element={<MembersPage />} />
            <Route path="/tenants/:tenantId/audit-log" element={<AuditLogPage />} />
            <Route path="/members" element={<CurrentTenantRedirect suffix="/members" />} />
            <Route path="/audit-log" element={<CurrentTenantRedirect suffix="/audit-log" />} />
            <Route path="/ptv-connections" element={<PtvConnectionsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
