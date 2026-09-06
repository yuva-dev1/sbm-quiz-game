import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { api } from './api.js';

const SessionContext = createContext(null);
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, student: null, host: false });

  const refresh = useCallback(async () => {
    const [student, host] = await Promise.all([
      api.get('/api/auth/session').catch(() => ({ authenticated: false })),
      api.get('/api/host/session').catch(() => ({ authenticated: false }))
    ]);
    setState({
      loading: false,
      student: student.authenticated ? student.email : null,
      host: Boolean(host.authenticated)
    });
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

export function RequireStudent({ children }) {
  const { loading, student } = useSession();
  const location = useLocation();
  if (loading) return <FullPageLoader />;
  if (!student) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}

export function RequireHost({ children }) {
  const { loading, host } = useSession();
  if (loading) return <FullPageLoader />;
  if (!host) return <Navigate to="/host/login" replace />;
  return children;
}
