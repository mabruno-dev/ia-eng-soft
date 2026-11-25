import type { User } from '@/types/user';
import { requestJson } from './http';

export function fetchUsers(): Promise<User[]> {
  return requestJson<User[]>('/users');
}
