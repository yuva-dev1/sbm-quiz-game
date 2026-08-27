import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, KeyRound, LoaderCircle, LogIn, MailCheck, UserPlus } from 'lucide-react';
import { OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';

const REG_NO_LENGTH = 5;
const MIN_PASSWORD_LENGTH = 8;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// A reset email links back as /?token=…&reg=… — read it once on mount.
function readResetParams() {
  if (typeof window === 'undefined') return { token: '', reg: '' };
  const params = new URLSearchParams(window.location.search);
  return { token: params.get('token') || '', reg: (params.get('reg') || '').trim().toUpperCase() };
}

const COPY = {
  login: { heading: 'Welcome back', subtitle: 'Log in with your registration number to continue.' },
  register: { heading: 'Create your account', subtitle: 'Registration number, email, and a password to get started.' },
  forgot: { heading: 'Reset your password', subtitle: 'Enter your registration number and the email on your account.' },
  reset: { heading: 'Choose a new password', subtitle: 'Set a new password for your account.' }
};

export default function AuthGate({ onAuthenticated }) {
  const resetParams = useMemo(() => readResetParams(), []);
  const [resetToken] = useState(resetParams.token);
  const [view, setView] = useState(resetParams.token ? 'reset' : 'login');
  const [regNo, setRegNo] = useState(resetParams.token ? resetParams.reg : '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Strip the token from the URL so a refresh doesn't replay it.
  useEffect(() => {
    if (resetParams.token) window.history.replaceState({}, '', window.location.pathname);
  }, [resetParams.token]);

  const switchView = (nextView) => {
    setView(nextView);
    setError('');
    setInfo('');
    setPassword('');
    setConfirmPassword('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    setInfo('');

    const normalizedRegNo = regNo.trim().toUpperCase();
    const normalizedEmail = email.trim().toLowerCase();
    const needsRegNo = view !== 'reset';

    if (needsRegNo && normalizedRegNo.length !== REG_NO_LENGTH) {
      setError(`Registration number must be exactly ${REG_NO_LENGTH} characters.`);
      return;
    }
    if ((view === 'register' || view === 'forgot') && !EMAIL_PATTERN.test(normalizedEmail)) {
      setError('Enter a valid email address.');
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
        await fetch('/api/auth/forgot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ regNo: normalizedRegNo, email: normalizedEmail })
        });
        setInfo('If those details match an account, a password reset link is on its way. Check your email, including spam.');
        setRegNo('');
        setEmail('');
        return;
      }

      const endpoint =
        view === 'register' ? '/api/auth/register' : view === 'reset' ? '/api/auth/reset' : '/api/auth/login';
      const body =
        view === 'register'
          ? { regNo: normalizedRegNo, email: normalizedEmail, password }
          : view === 'reset'
            ? { regNo: normalizedRegNo, token: resetToken, password }
            : { regNo: normalizedRegNo, password };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Something went wrong. Please try again.');
      onAuthenticated(payload.regNo || normalizedRegNo);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const showRegNo = view !== 'reset';
  const showEmail = view === 'register' || view === 'forgot';
  const showPassword = view === 'login' || view === 'register' || view === 'reset';
  const showConfirm = view === 'register' || view === 'reset';

  const submitLabel = {
    login: 'Log in',
    register: 'Create account',
    forgot: 'Send reset link',
    reset: 'Set new password'
  }[view];
  const submittingLabel = {
    login: 'Logging in…',
    register: 'Creating account…',
    forgot: 'Sending…',
    reset: 'Saving…'
  }[view];
  const SubmitIcon = { login: LogIn, register: UserPlus, forgot: MailCheck, reset: KeyRound }[view];

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <span className="brand-logo-art auth-logo" aria-hidden="true"><img src={OFFICIAL_GOD_LOGO_URL} alt="" /></span>
        <p className="eyebrow gold">Bhagavatam Self Study</p>
        <h1>{COPY[view].heading}</h1>
        <p className="auth-subtitle">{COPY[view].subtitle}</p>

        <form onSubmit={submit}>
          {showRegNo && (
            <label className="auth-field">
              <span className="field-label">Registration number</span>
              <input
                value={regNo}
                onChange={(event) => setRegNo(event.target.value)}
                maxLength={REG_NO_LENGTH}
                autoCapitalize="characters"
                autoComplete="username"
                placeholder="AB123"
                required
              />
            </label>
          )}

          {showEmail && (
            <label className="auth-field">
              <span className="field-label">Email</span>
              <input
                type="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
            </label>
          )}

          {showPassword && (
            <label className="auth-field">
              <span className="field-label">{view === 'reset' ? 'New password' : 'Password'}</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={view === 'login' ? 'current-password' : 'new-password'}
                minLength={view === 'login' ? undefined : MIN_PASSWORD_LENGTH}
                required
              />
            </label>
          )}

          {showConfirm && (
            <label className="auth-field">
              <span className="field-label">Confirm password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
          )}

          {view === 'login' && (
            <button className="auth-forgot" type="button" onClick={() => switchView('forgot')}>
              Forgot your password?
            </button>
          )}

          {error && <p className="auth-error" role="alert">{error}</p>}
          {info && <p className="auth-info" role="status">{info}</p>}

          <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <><LoaderCircle className="spin" size={17} /> {submittingLabel}</>
            ) : (
              <><SubmitIcon size={17} /> {submitLabel} <ArrowRight size={16} /></>
            )}
          </button>
        </form>

        {(view === 'login' || view === 'register') && (
          <button className="auth-switch" type="button" onClick={() => switchView(view === 'register' ? 'login' : 'register')}>
            {view === 'register' ? 'Already have an account? Log in' : "Don't have an account? Create one"}
          </button>
        )}
        {(view === 'forgot' || view === 'reset') && (
          <button className="auth-switch" type="button" onClick={() => switchView('login')}>
            Back to log in
          </button>
        )}
      </div>
    </div>
  );
}
