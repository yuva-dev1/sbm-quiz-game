import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, KeyRound, LoaderCircle, LogIn, MailCheck, UserPlus } from 'lucide-react';
import { api } from './api.js';
import { useSession } from './session.jsx';
import { COURSE_TITLE, OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const MAX_NAME_LENGTH = 80;

const COPY = {
  login: { heading: 'Welcome back', sub: 'Log in with your email and password.' },
  register: { heading: 'Create your account', sub: 'Your name, email, and a password to get started.' },
  forgot: { heading: 'Reset your password', sub: 'Enter the email on your account.' },
  reset: { heading: 'Choose a new password', sub: 'Set a new password for your account.' }
};

export default function AuthGate({ initialView = 'login' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refresh } = useSession();

  const resetParams = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return { token: params.get('token') || '', email: (params.get('email') || '').trim().toLowerCase() };
  }, []);

  const [view, setView] = useState(resetParams.token ? 'reset' : initialView);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState(resetParams.token ? resetParams.email : '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Strip the token from the URL so a refresh doesn't replay it.
  useEffect(() => {
    if (resetParams.token) window.history.replaceState({}, '', '/reset');
  }, [resetParams.token]);

  const switchView = (next) => {
    setView(next);
    setError('');
    setInfo('');
    setPassword('');
    setConfirmPassword('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setInfo('');

    const normalizedEmail = email.trim().toLowerCase();
    if (view !== 'reset' && !EMAIL_PATTERN.test(normalizedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (view === 'register' && (!firstName.trim() || !lastName.trim())) {
      setError('Please enter your first and last name.');
      return;
    }
    if (view === 'register' && (firstName.trim().length > MAX_NAME_LENGTH || lastName.trim().length > MAX_NAME_LENGTH)) {
      setError('That name is too long.');
      return;
    }
    if ((view === 'register' || view === 'reset') && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if ((view === 'register' || view === 'reset') && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (view === 'forgot') {
        await api.post('/api/auth/forgot', { email: normalizedEmail });
        setInfo('If that email matches an account, a reset link is on its way. Check your inbox, including spam.');
        setEmail('');
        return;
      }

      if (view === 'register') {
        await api.post('/api/auth/register', {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: normalizedEmail,
          password
        });
      } else if (view === 'reset') {
        await api.post('/api/auth/reset', { email: resetParams.email || normalizedEmail, token: resetParams.token, password });
      } else {
        await api.post('/api/auth/login', { email: normalizedEmail, password });
      }
      await refresh();
      navigate(location.state?.from || '/', { replace: true });
    } catch (submitError) {
      setError(submitError.message || 'Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const showNames = view === 'register';
  const showEmail = view !== 'reset';
  const showPassword = view === 'login' || view === 'register' || view === 'reset';
  const showConfirm = view === 'register' || view === 'reset';

  const submitLabel = { login: 'Log in', register: 'Create account', forgot: 'Send reset link', reset: 'Set new password' }[view];
  const SubmitIcon = { login: LogIn, register: UserPlus, forgot: MailCheck, reset: KeyRound }[view];

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <img className="logo" src={OFFICIAL_GOD_LOGO_URL} alt="" />
        <p className="eyebrow">{COURSE_TITLE}</p>
        <h1>{COPY[view].heading}</h1>
        <p className="sub">{COPY[view].sub}</p>

        <form onSubmit={submit}>
          {showNames && (
            <div className="row">
              <label className="field">
                <span>First name</span>
                <input value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" maxLength={MAX_NAME_LENGTH} required />
              </label>
              <label className="field">
                <span>Last name</span>
                <input value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" maxLength={MAX_NAME_LENGTH} required />
              </label>
            </div>
          )}
          {showEmail && (
            <label className="field">
              <span>Email</span>
              <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" required />
            </label>
          )}
          {showPassword && (
            <label className="field">
              <span>{view === 'reset' ? 'New password' : 'Password'}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={view === 'login' ? 'current-password' : 'new-password'}
                minLength={view === 'login' ? undefined : MIN_PASSWORD_LENGTH}
                required
              />
            </label>
          )}
          {showConfirm && (
            <label className="field">
              <span>Confirm password</span>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required />
            </label>
          )}

          {view === 'login' && (
            <button className="auth-forgot" type="button" onClick={() => switchView('forgot')}>Forgot your password?</button>
          )}

          {error && <p className="error" role="alert">{error}</p>}
          {info && <p className="info" role="status">{info}</p>}

          <button className="btn" type="submit" disabled={isSubmitting}>
            {isSubmitting ? <LoaderCircle className="spin" size={17} /> : <SubmitIcon size={17} />}
            {submitLabel}
            {!isSubmitting && <ArrowRight size={16} />}
          </button>
        </form>

        {(view === 'login' || view === 'register') && (
          <button className="auth-switch" type="button" onClick={() => switchView(view === 'register' ? 'login' : 'register')}>
            {view === 'register' ? 'Already enrolled? Log in' : "New here? Create an account"}
          </button>
        )}
        {(view === 'forgot' || view === 'reset') && (
          <button className="auth-switch" type="button" onClick={() => switchView('login')}>Back to log in</button>
        )}
      </div>
    </div>
  );
}
