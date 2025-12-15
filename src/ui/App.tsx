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
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    checkStatus();
  }, []);

  async function checkStatus() {
    try {
      // Check setup status
      const setupRes = await fetch('/api/setup/status');
      const setup = await setupRes.json();
      setSetupStatus(setup);

      // Check if logged in
      const meRes = await fetch('/api/auth/me');
      if (meRes.ok) {
        const userData = await meRes.json();
        setUser(userData);
      }
    } catch (error) {
      console.error('Failed to check status:', error);
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
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

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
