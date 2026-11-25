import type { ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps {
  children: ReactNode;
  variant?: ButtonVariant;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  onClick?: () => void;
}

export function Button({ children, variant = 'primary', disabled = false, type = 'button', onClick }: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}`}
      disabled={disabled}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </button>
  );
}

export default Button;
