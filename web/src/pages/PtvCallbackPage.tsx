import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiFetch, errorMessage } from '../api/client';
import { PTV_CONNECT_ENVIRONMENT_KEY } from './PtvConnectionsPage';

export function PtvCallbackPage() {
  const navigate = useNavigate();
  // null while connecting.
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) {
      return;
    }
    ranRef.current = true;

    async function run(): Promise<void> {
      const fragment = window.location.hash.replace(/^#/, '');
      const environment = sessionStorage.getItem(PTV_CONNECT_ENVIRONMENT_KEY);
      sessionStorage.removeItem(PTV_CONNECT_ENVIRONMENT_KEY);

      if (!environment) {
        setError('Missing PTV environment — please retry the connection from PTV connections.');
        return;
      }
      if (!fragment) {
        setError('PTV did not return any authorization data.');
        return;
      }

      try {
        await apiFetch<void>('/ptv-connections/v11/callback', {
          method: 'POST',
          body: JSON.stringify({ environment, fragment }),
        });
        navigate('/ptv-connections', { replace: true });
      } catch (err) {
        setError(errorMessage(err, 'Could not complete the PTV connection.'));
      }
    }

    void run();
  }, [navigate]);

  return (
    <div className="card" style={{ maxWidth: 420, margin: '80px auto' }}>
      <h1>PTV connection</h1>
      {error === null && <p className="muted">Connecting…</p>}
      {error !== null && (
        <>
          <p className="error">{error}</p>
          <Link to="/ptv-connections">Back to PTV connections</Link>
        </>
      )}
    </div>
  );
}
