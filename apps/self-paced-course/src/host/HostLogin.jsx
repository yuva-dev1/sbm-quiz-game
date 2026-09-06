import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, KeyRound, LoaderCircle } from 'lucide-react';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { OFFICIAL_GOD_LOGO_URL } from '../brandAssets.js';

export default function HostLogin() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.post('/api/host/login', { passcode });
      await refresh();
      navigate('/host', { replace: true });
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <img className="logo" src={OFFICIAL_GOD_LOGO_URL} alt="" />
        <p className="eyebrow">Course host</p>
        <h1>Host sign-in</h1>
        <p className="sub">Enter the shared host passcode.</p>
        <form onSubmit={submit}>
          <label className="field">
            <span>Passcode</span>
            <input type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="current-password" required />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />} Enter {!submitting && <ArrowRight size={16} />}
          </button>
        </form>
      </div>
    </div>
  );
}
