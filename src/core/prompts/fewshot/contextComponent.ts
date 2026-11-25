import type { FewShotExample } from './types';

// Exemplo 2: componente que depende de um Context (diferente dos componentes do fixture).
export const contextComponentExample: FewShotExample = {
  title: 'Componente com Context (NotificationBell)',
  componentName: 'NotificationBell',
  files: [
    {
      path: 'state/NotificationsContext.tsx',
      source: `import { createContext, useContext, useState, type ReactNode } from 'react';

export interface Notification {
  id: number;
  text: string;
  read: boolean;
}

interface NotificationsValue {
  notifications: Notification[];
  markAllRead: () => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ initial = [], children }: { initial?: Notification[]; children: ReactNode }) {
  const [notifications, setNotifications] = useState(initial);
  const markAllRead = () => setNotifications((ns) => ns.map((n) => ({ ...n, read: true })));
  return <NotificationsContext.Provider value={{ notifications, markAllRead }}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications precisa de <NotificationsProvider>');
  return ctx;
}
`,
    },
    {
      path: 'components/NotificationBell.tsx',
      source: `import { useState } from 'react';
import { useNotifications } from '../state/NotificationsContext';

export function NotificationBell() {
  const { notifications, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;
  const badge = unread > 99 ? '99+' : String(unread);

  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Notificações{unread > 0 && <span> {badge}</span>}
      </button>
      {open && (
        <div>
          {notifications.length === 0 ? (
            <p>Nenhuma notificação.</p>
          ) : (
            <ul aria-label="Lista de notificações">
              {notifications.map((n) => (
                <li key={n.id}>{n.read ? n.text : <strong>{n.text}</strong>}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={markAllRead} disabled={unread === 0}>
            Marcar todas como lidas
          </button>
        </div>
      )}
    </div>
  );
}
`,
    },
  ],
  allowedImports: [
    { name: 'NotificationBell', specifier: './NotificationBell', kind: 'named' },
    { name: 'NotificationsProvider', specifier: '../state/NotificationsContext', kind: 'named' },
    { name: 'Notification', specifier: '../state/NotificationsContext', kind: 'named' },
  ],
  mockTargets: [],
  plan: [
    { name: 'mostra a quantidade de não lidas no botão', kind: 'render' },
    { name: 'abre e fecha a lista de notificações', kind: 'interaction' },
    { name: 'marcar todas como lidas zera o contador e desabilita o botão', kind: 'interaction' },
    { name: 'mostra mensagem quando não há notificações', kind: 'edge' },
    { name: 'limita o contador a 99+', kind: 'edge' },
    { name: 'falha com mensagem clara fora do Provider', kind: 'edge' },
  ],
  test: {
    path: 'components/NotificationBell.test.tsx',
    code: `import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { NotificationBell } from './NotificationBell';
import { NotificationsProvider, type Notification } from '../state/NotificationsContext';

function renderBell(initial: Notification[] = []) {
  return render(
    <NotificationsProvider initial={initial}>
      <NotificationBell />
    </NotificationsProvider>,
  );
}

const sample: Notification[] = [
  { id: 1, text: 'Pedido enviado', read: false },
  { id: 2, text: 'Pagamento aprovado', read: false },
  { id: 3, text: 'Bem-vindo!', read: true },
];

describe('NotificationBell', () => {
  it('mostra a quantidade de não lidas no botão', () => {
    renderBell(sample);

    expect(screen.getByRole('button', { name: 'Notificações 2' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('abre e fecha a lista de notificações', async () => {
    const user = userEvent.setup();
    renderBell(sample);
    const toggle = screen.getByRole('button', { name: /notificações/i });

    await user.click(toggle);
    const list = screen.getByRole('list', { name: 'Lista de notificações' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(screen.queryByRole('list', { name: 'Lista de notificações' })).not.toBeInTheDocument();
  });

  it('marcar todas como lidas zera o contador e desabilita o botão', async () => {
    const user = userEvent.setup();
    renderBell(sample);

    await user.click(screen.getByRole('button', { name: /notificações/i }));
    await user.click(screen.getByRole('button', { name: 'Marcar todas como lidas' }));

    expect(screen.getByRole('button', { name: 'Notificações' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marcar todas como lidas' })).toBeDisabled();
  });

  it('mostra mensagem quando não há notificações', async () => {
    const user = userEvent.setup();
    renderBell([]);

    await user.click(screen.getByRole('button', { name: 'Notificações' }));

    expect(screen.getByText('Nenhuma notificação.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Marcar todas como lidas' })).toBeDisabled();
  });

  it('limita o contador a 99+', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: i, text: 'n' + i, read: false }));
    renderBell(many);

    expect(screen.getByRole('button', { name: 'Notificações 99+' })).toBeInTheDocument();
  });

  it('falha com mensagem clara fora do Provider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<NotificationBell />)).toThrow('useNotifications precisa de <NotificationsProvider>');
    spy.mockRestore();
  });
});
`,
  },
};
