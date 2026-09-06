import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { FullPageLoader, RequireHost, RequireStudent, SessionProvider, useSession } from './session.jsx';
import AuthGate from './auth.jsx';
import CourseHome from './student/CourseHome.jsx';
import WeekPage from './student/WeekPage.jsx';
import TakeQuiz from './student/TakeQuiz.jsx';
import Results from './student/Results.jsx';
import HostLogin from './host/HostLogin.jsx';
import HostWeeks from './host/HostWeeks.jsx';
import HostWeekEditor from './host/HostWeekEditor.jsx';
import HostScores from './host/HostScores.jsx';

function App() {
  const { loading, student, host } = useSession();
  if (loading) return <FullPageLoader />;

  return (
    <Routes>
      <Route path="/login" element={student ? <Navigate to="/" replace /> : <AuthGate />} />
      <Route path="/reset" element={<AuthGate initialView="reset" />} />

      <Route path="/" element={<RequireStudent><CourseHome /></RequireStudent>} />
      <Route path="/week/:n" element={<RequireStudent><WeekPage /></RequireStudent>} />
      <Route path="/week/:n/quiz" element={<RequireStudent><TakeQuiz /></RequireStudent>} />
      <Route path="/results" element={<RequireStudent><Results /></RequireStudent>} />

      <Route path="/host/login" element={host ? <Navigate to="/host" replace /> : <HostLogin />} />
      <Route path="/host" element={<RequireHost><HostWeeks /></RequireHost>} />
      <Route path="/host/week/:n" element={<RequireHost><HostWeekEditor /></RequireHost>} />
      <Route path="/host/scores" element={<RequireHost><HostScores /></RequireHost>} />

      <Route path="*" element={<Navigate to="/" replace />} />
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
