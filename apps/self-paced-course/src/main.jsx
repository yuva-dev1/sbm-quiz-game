import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { FullPageLoader, RequireHost, SessionProvider, useSession } from './session.jsx';
import TakeQuiz from './TakeQuiz.jsx';
import HostLogin from './host/HostLogin.jsx';
import HostWeeks from './host/HostWeeks.jsx';
import HostWeekEditor from './host/HostWeekEditor.jsx';
import HostScores from './host/HostScores.jsx';
import HostAttempts from './host/HostAttempts.jsx';

function App() {
  const { loading, host } = useSession();
  if (loading) return <FullPageLoader />;

  return (
    <Routes>
      {/* Student-facing quiz — embedded from the Squarespace course page,
          identified by the ?sid= param. No login. */}
      <Route path="/q/:n" element={<TakeQuiz />} />

      <Route path="/host/login" element={host ? <Navigate to="/host" replace /> : <HostLogin />} />
      <Route path="/host" element={<RequireHost><HostWeeks /></RequireHost>} />
      <Route path="/host/week/:n" element={<RequireHost><HostWeekEditor /></RequireHost>} />
      <Route path="/host/scores" element={<RequireHost><HostScores /></RequireHost>} />
      <Route path="/host/attempts" element={<RequireHost><HostAttempts /></RequireHost>} />

      <Route path="*" element={<Navigate to="/host/login" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <SessionProvider>
      <App />
    </SessionProvider>
  </BrowserRouter>
);
