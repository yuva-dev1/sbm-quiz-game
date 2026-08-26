import { useState } from 'react';
import { ArrowRight, LoaderCircle, LogIn, UserPlus } from 'lucide-react';
import { OFFICIAL_GOD_LOGO_URL } from './brandAssets.js';

const REG_NO_LENGTH = 5;
const MIN_PASSWORD_LENGTH = 8;

export default function AuthGate({ onAuthenticated }) {
  const [view, setView] = useState('login');
  const [regNo, setRegNo] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const isRegister = view === 'register';

  const switchView = (nextView) => {
    setView(nextView);
    setError('');
    setPassword('');
    setConfirmPassword('');
  };

  const submit = async (event) => {
    event.preventDefault();
    const normalizedRegNo = regNo.trim().toUpperCase();
    if (normalizedRegNo.length !== REG_NO_LENGTH) {
      setError(`Registration number must be exactly ${REG_NO_LENGTH} characters.`);
      return;
    }
    if (isRegister && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (isRegister && password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsSubmitting(true);
    setError('');
    try {
      const response = await fetch(isRegister ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regNo: normalizedRegNo, password })
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

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <span className="brand-logo-art auth-logo" aria-hidden="true"><img src={OFFICIAL_GOD_LOGO_URL} alt="" /></span>
        <p className="eyebrow gold">Bhagavatam Self Study</p>
        <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
        <p className="auth-subtitle">
          {isRegister ? 'Use your registration number to start practicing.' : 'Log in with your registration number to continue.'}
        </p>

        <form onSubmit={submit}>
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
          <label className="auth-field">
            <span className="field-label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={isRegister ? MIN_PASSWORD_LENGTH : undefined}
              required
            />
          </label>
          {isRegister && (
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

          {error && <p className="auth-error" role="alert">{error}</p>}

          <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <><LoaderCircle className="spin" size={17} /> {isRegister ? 'Creating account...' : 'Logging in...'}</>
            ) : (
              <>{isRegister ? <UserPlus size={17} /> : <LogIn size={17} />} {isRegister ? 'Create account' : 'Log in'} <ArrowRight size={16} /></>
            )}
          </button>
        </form>

        <button className="auth-switch" type="button" onClick={() => switchView(isRegister ? 'login' : 'register')}>
          {isRegister ? 'Already have an account? Log in' : "Don't have an account? Create one"}
        </button>
      </div>
    </div>
  );
}
