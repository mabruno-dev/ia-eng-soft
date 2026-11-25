import { useEffect, useMemo, useState } from 'react';
import { fetchUsers } from '../services/userApi';
import type { User } from '@/types/user';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; users: User[] };

export function UserList() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchUsers()
      .then((users) => {
        if (!cancelled) setState({ status: 'ready', users });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : 'Erro desconhecido' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (state.status !== 'ready') return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.users;
    return state.users.filter((u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [state, query]);

  if (state.status === 'loading') return <p role="status">Carregando usuários...</p>;
  if (state.status === 'error') return <p role="alert">Falha ao carregar usuários: {state.message}</p>;
  if (state.users.length === 0) return <p>Nenhum usuário cadastrado.</p>;

  return (
    <section>
      <label htmlFor="user-filter">Filtrar</label>
      <input id="user-filter" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
      {filtered.length === 0 ? (
        <p>Nenhum usuário encontrado para “{query}”.</p>
      ) : (
        <ul aria-label="Usuários">
          {filtered.map((u) => (
            <li key={u.id}>
              {u.name} <small>({u.email})</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
