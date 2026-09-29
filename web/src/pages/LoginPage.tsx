import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';

/**
 * The single sign-on button's label, or null when the server has no OIDC
 * configured (then `/oidc/config` is a 404 and no button is shown).
 */
function useOidcButtonLabel(): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/oidc/config')
      .then(async (res) => (res.ok ? ((await res.json()) as { buttonLabel?: unknown }) : null))
      .then((config) => {
        if (!cancelled && typeof config?.buttonLabel === 'string') setLabel(config.buttonLabel);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return label;
}

function readOidcCode(): string | null {
  const match = /^#oidc=(.+)$/.exec(window.location.hash);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function LoginPage() {
  const { login, loginWithOidcCode } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The server's OIDC callback redirects here with a one-time code in the
  // fragment (never sent to a server); it is exchanged once for the session.
  const [oidcCode] = useState(readOidcCode);
  const oidcExchanged = useRef(false);
  const [submitting, setSubmitting] = useState(oidcCode !== null);
  const oidcButtonLabel = useOidcButtonLabel();

  useEffect(() => {
    if (!oidcCode || oidcExchanged.current) return;
    oidcExchanged.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    loginWithOidcCode(oidcCode)
      .then(() => navigate('/'))
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 423
            ? 'Account temporarily locked after too many failed attempts.'
            : 'Single sign-on failed. Please try again.',
        );
      })
      .finally(() => setSubmitting(false));
  }, [oidcCode, loginWithOidcCode, navigate]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) {
        setError('Account temporarily locked after too many failed attempts.');
      } else {
        setError('Invalid email or password.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 360, margin: '80px auto' }}>
      <h1>Log in</h1>
      {oidcButtonLabel && (
        <p>
          <a className="button primary" href="/oidc/login">
            {oidcButtonLabel}
          </a>
        </p>
      )}
      <form onSubmit={handleSubmit}>
        <p>
          <label htmlFor="email">Email</label>
          <br />
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: '100%' }}
          />
        </p>
        <p>
          <label htmlFor="password">Password</label>
          <br />
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%' }}
          />
        </p>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <p className="muted">
        No account? <Link to="/register">Register</Link>
      </p>
    </div>
  );
}
