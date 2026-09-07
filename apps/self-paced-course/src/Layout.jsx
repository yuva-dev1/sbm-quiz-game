import { NavLink, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { useSession } from './session.jsx';
import { COURSE_TITLE, OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';

/** Host page chrome: brand + nav + log out. */
export default function Layout({ children }) {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const logout = async () => {
    await api.post('/api/host/logout').catch(() => {});
    await refresh();
    navigate('/host/login', { replace: true });
  };

  return (
    <>
      <header className="topbar">
        <NavLink to="/host" className="brand">
          <img src={OFFICIAL_GOD_LOGO_URL} alt="" />
          <strong>{COURSE_TITLE}</strong>
        </NavLink>
        <nav>
          <NavLink to="/host" end>Quizzes</NavLink>
          <NavLink to="/host/scores">Scores</NavLink>
          <button type="button" className="linkbtn" onClick={logout}>Log out</button>
        </nav>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
