import { useId, useState } from 'react';

export type PasswordStrength = 'fraca' | 'média' | 'forte';

export function getPasswordStrength(password: string): PasswordStrength {
  const hasNumber = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  if (password.length >= 12 && hasNumber && hasSymbol) return 'forte';
  if (password.length >= 8 && (hasNumber || hasSymbol)) return 'média';
  return 'fraca';
}

export interface PasswordFieldProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
}

export function PasswordField({ label = 'Senha', value, onChange }: PasswordFieldProps) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const strength = getPasswordStrength(value);

  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} type={visible ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}>
        {visible ? 'Ocultar' : 'Mostrar'}
      </button>
      {value && (
        <p aria-live="polite" data-strength={strength}>
          Força: {strength}
        </p>
      )}
    </div>
  );
}
