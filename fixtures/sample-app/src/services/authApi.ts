import { requestJson } from './http';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: { id: number; name: string };
}

export function login(credentials: LoginCredentials): Promise<LoginResponse> {
  return requestJson<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
  });
}
