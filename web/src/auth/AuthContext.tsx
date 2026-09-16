import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiFetch, clearSession, getAccessToken, getRefreshToken, setSession } from '../api/client';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface AuthContextValue {
  isAuthenticated: boolean;
  login(email: string, password: string): Promise<void>;
  register(email: string, name: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => getAccessToken() !== null);

  async function login(email: string, password: string): Promise<void> {
    const session = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setSession(session);
    setIsAuthenticated(true);
  }

  async function register(email: string, name: string, password: string): Promise<void> {
    await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    });
  }

  async function logout(): Promise<void> {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      try {
        await apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
      } catch {
        // Logging out locally still matters even if the server call fails
        // (e.g. the refresh token had already expired) — never block on it.
      }
    }
    clearSession();
    setIsAuthenticated(false);
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
