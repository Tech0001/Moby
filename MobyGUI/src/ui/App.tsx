import { apiFetch, SESSION_EXPIRED } from './lib/api';
import { useState, useEffect } from 'react';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import { Dashboard } from './components/Dashboard';

interface SetupStatus {
  setupComplete: boolean;
  hasApiKeys: boolean;
}

interface User {
  userId: string;
  username: string;
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const expired = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED, expired);
    void checkStatus();
    return () => window.removeEventListener(SESSION_EXPIRED, expired);
  }, []);

  async function checkStatus() {
    setStatusError('');
    try {
      // Check setup status
      const setupRes = await apiFetch('/api/setup/status');
      if (!setupRes.ok) throw new Error('Could not reach Moby');
      const setup = await setupRes.json();
      setSetupStatus(setup);

      // Check if logged in
      const meRes = await apiFetch('/api/auth/me');
      if (meRes.ok) {
        const userData = await meRes.json();
        setUser(userData);
      }
    } catch (error) {
      if (error instanceof Error && !error.message.includes('session expired')) setStatusError('Could not connect to Moby. Please retry.');
    } finally {
      setLoading(false);
    }
  }

  function handleSetupComplete() {
    checkStatus();
  }

  function handleLogin(userData: User) {
    setUser(userData);
  }

  async function handleLogout() {
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); }
    finally { setUser(null); }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (statusError) return <div className="min-h-screen flex flex-col gap-3 items-center justify-center">
    <p role="alert">{statusError}</p>
    <button className="border rounded px-4 py-2" onClick={() => { void checkStatus(); }}>Retry connection</button>
  </div>;

  // Need initial setup
  if (!setupStatus?.setupComplete) {
    return <Setup onComplete={handleSetupComplete} />;
  }

  // Need login
  if (!user) {
    return <Login onLogin={handleLogin} />;
  }

  // Show dashboard
  return <Dashboard user={user} onLogout={handleLogout} />;
}
