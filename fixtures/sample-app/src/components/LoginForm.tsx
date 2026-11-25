import { useState, type FormEvent } from 'react';
import { login, type LoginResponse } from '@/services/authApi';
import { isValidEmail, MIN_PASSWORD_LENGTH } from '../utils/validation';
import { Button } from './Button';

type Status = 'idle' | 'loading' | 'error' | 'success';

interface FieldErrors {
  email?: string;
  password?: string;
}

export interface LoginFormProps {
  onSuccess?: (result: LoginResponse) => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<Status>('idle');
  const [apiError, setApiError] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);

  function validate(): FieldErrors {
    const next: FieldErrors = {};
    if (!email.trim()) next.email = 'Informe o e-mail.';
    else if (!isValidEmail(email)) next.email = 'E-mail inválido.';
    if (!password) next.password = 'Informe a senha.';
    else if (password.length < MIN_PASSWORD_LENGTH) {
      next.password = `A senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
    }
    return next;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fieldErrors = validate();
    setErrors(fieldErrors);
    if (fieldErrors.email || fieldErrors.password) return;

    setStatus('loading');
    setApiError(null);
    try {
      const result = await login({ email: email.trim(), password });
      setStatus('success');
      setUserName(result.user.name);
      onSuccess?.(result);
    } catch (err) {
      setStatus('error');
      setApiError(err instanceof Error ? err.message : 'Não foi possível entrar.');
    }
  }

  if (status === 'success') {
    return <p role="status">Bem-vindo, {userName}!</p>;
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Login">
      <div>
        <label htmlFor="login-email">E-mail</label>
        <input
          id="login-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={Boolean(errors.email)}
          aria-describedby={errors.email ? 'login-email-error' : undefined}
        />
        {errors.email && (
          <span id="login-email-error" role="alert">
            {errors.email}
          </span>
        )}
      </div>
      <div>
        <label htmlFor="login-password">Senha</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={Boolean(errors.password)}
          aria-describedby={errors.password ? 'login-password-error' : undefined}
        />
        {errors.password && (
          <span id="login-password-error" role="alert">
            {errors.password}
          </span>
        )}
      </div>
      {status === 'error' && apiError && <p role="alert">{apiError}</p>}
      <Button type="submit" disabled={status === 'loading'}>
        {status === 'loading' ? 'Entrando...' : 'Entrar'}
      </Button>
    </form>
  );
}
