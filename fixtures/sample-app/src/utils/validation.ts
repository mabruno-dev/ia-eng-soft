const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MIN_PASSWORD_LENGTH = 8;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}
