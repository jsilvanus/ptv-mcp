import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiFetch } from '../api/client';
import type { TenantMembership } from '../api/types';
import { useAuth } from '../auth/AuthContext';

const CURRENT_TENANT_KEY = 'ptv_mcp_current_tenant_id';

interface TenantContextValue {
  tenants: TenantMembership[];
  currentTenantId: string | null;
  currentTenant: TenantMembership | null;
  loading: boolean;
  setCurrentTenantId(tenantId: string): void;
  refresh(): Promise<void>;
}

const TenantContext = createContext<TenantContextValue | null>(null);

/** Every page that needs "which tenant, with what role" reads it from here instead of re-fetching. */
export function TenantProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [tenants, setTenants] = useState<TenantMembership[]>([]);
  const [currentTenantId, setCurrentTenantIdState] = useState<string | null>(() =>
    localStorage.getItem(CURRENT_TENANT_KEY),
  );
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setTenants([]);
      return;
    }
    setLoading(true);
    try {
      const list = await apiFetch<TenantMembership[]>('/tenants');
      setTenants(list);
      setCurrentTenantIdState((current) => {
        if (current && list.some((t) => t.tenantId === current)) {
          return current;
        }
        return list[0]?.tenantId ?? null;
      });
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function setCurrentTenantId(tenantId: string): void {
    localStorage.setItem(CURRENT_TENANT_KEY, tenantId);
    setCurrentTenantIdState(tenantId);
  }

  const currentTenant = tenants.find((t) => t.tenantId === currentTenantId) ?? null;

  return (
    <TenantContext.Provider
      value={{ tenants, currentTenantId, currentTenant, loading, setCurrentTenantId, refresh }}
    >
      {children}
    </TenantContext.Provider>
  );
}

export function useTenants(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) {
    throw new Error('useTenants must be used within a TenantProvider');
  }
  return ctx;
}
