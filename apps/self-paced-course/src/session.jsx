import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { api } from './api.js';

const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

/** Tracks only the host passcode session. Students have no session here —
 *  their identity rides in from the Squarespace embed as a `sid` param. */
export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, host: false });

  const refresh = useCallback(async () => {
    const host = await api.get('/api/host/session').catch(() => ({ authenticated: false }));
    setState({ loading: false, host: Boolean(host.authenticated) });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return <SessionContext.Provider value={{ ...state, refresh }}>{children}</SessionContext.Provider>;
}

export function FullPageLoader() {
  return (
    <div className="center-load">
      <LoaderCircle className="spin" size={28} />
    </div>
  );
}

export function RequireHost({ children }) {
  const { loading, host } = useSession();
  if (loading) return <FullPageLoader />;
  if (!host) return <Navigate to="/host/login" replace />;
  return children;
}
