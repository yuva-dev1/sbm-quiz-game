import { NavLink, useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { useSession } from './session.jsx';
import { COURSE_TITLE, OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';

/** Shared page chrome: brand + context-appropriate nav. `variant` is
 *  'student' | 'host'. */
export default function Layout({ variant = 'student', children }) {
  const navigate = useNavigate();
  const { refresh } = useSession();

  const logout = async () => {
    await api.post(variant === 'host' ? '/api/host/logout' : '/api/auth/logout').catch(() => {});
    await refresh();
    navigate(variant === 'host' ? '/host/login' : '/login', { replace: true });
  };

  return (
    <>
      <header className="topbar">
        <NavLink to={variant === 'host' ? '/host' : '/'} className="brand">
          <img src={OFFICIAL_GOD_LOGO_URL} alt="" />
          <strong>{COURSE_TITLE}</strong>
        </NavLink>
        <nav>
          {variant === 'student' ? (
            <>
              <NavLink to="/" end>Course</NavLink>
              <NavLink to="/results">My results</NavLink>
            </>
          ) : (
            <>
              <NavLink to="/host" end>Weeks</NavLink>
              <NavLink to="/host/scores">Scores</NavLink>
            </>
          )}
          <button type="button" className="linkbtn" onClick={logout}>Log out</button>
        </nav>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
