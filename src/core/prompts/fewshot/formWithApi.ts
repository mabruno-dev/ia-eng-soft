import type { FewShotExample } from './types';

// Exemplo 1: formulário com chamada de API mockada (diferente dos componentes do fixture).
export const formWithApiExample: FewShotExample = {
  title: 'Formulário com API mockada (NewsletterSignup)',
  componentName: 'NewsletterSignup',
  files: [
    {
      path: 'services/newsletterApi.ts',
      source: `export async function subscribe(email: string): Promise<void> {
  const res = await fetch('/api/newsletter', { method: 'POST', body: JSON.stringify({ email }) });
  if (!res.ok) throw new Error('Falha na inscrição');
}
`,
    },
    {
      path: 'components/NewsletterSignup.tsx',
      source: `import { useState, type FormEvent } from 'react';
import { subscribe } from '../services/newsletterApi';

type Status = 'idle' | 'sending' | 'done' | 'failed';

export function NewsletterSignup({ onSubscribed }: { onSubscribed?: (email: string) => void }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!/^\\S+@\\S+\\.\\S+$/.test(email)) {
      setError('Digite um e-mail válido.');
      return;
    }
    setError(null);
    setStatus('sending');
    try {
      await subscribe(email);
      setStatus('done');
      onSubscribed?.(email);
    } catch {
      setStatus('failed');
    }
  }

  if (status === 'done') return <p role="status">Inscrição confirmada!</p>;

  return (
    <form onSubmit={handleSubmit} aria-label="Newsletter" noValidate>
      <label htmlFor="nl-email">Seu e-mail</label>
      <input id="nl-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      {error && <span role="alert">{error}</span>}
      {status === 'failed' && <p role="alert">Não foi possível concluir a inscrição.</p>}
      <button type="submit" disabled={status === 'sending'}>
        {status === 'sending' ? 'Enviando...' : 'Inscrever'}
      </button>
    </form>
  );
}
`,
    },
  ],
  allowedImports: [
    { name: 'NewsletterSignup', specifier: './NewsletterSignup', kind: 'named' },
    { name: 'subscribe', specifier: '../services/newsletterApi', kind: 'named' },
  ],
  mockTargets: ['../services/newsletterApi'],
  plan: [
    { name: 'renderiza o campo de e-mail e o botão de inscrição', kind: 'render' },
    { name: 'mostra erro de validação e não chama a API com e-mail inválido', kind: 'validation' },
    { name: 'desabilita o botão enquanto envia e confirma a inscrição', kind: 'async' },
    { name: 'mostra mensagem de erro quando a API falha', kind: 'async' },
    { name: 'envio com campo vazio também é bloqueado', kind: 'edge' },
  ],
  test: {
    path: 'components/NewsletterSignup.test.tsx',
    code: `import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { NewsletterSignup } from './NewsletterSignup';
import { subscribe } from '../services/newsletterApi';

jest.mock('../services/newsletterApi');
const mockedSubscribe = jest.mocked(subscribe);

describe('NewsletterSignup', () => {
  beforeEach(() => {
    mockedSubscribe.mockReset();
  });

  it('renderiza o campo de e-mail e o botão de inscrição', () => {
    render(<NewsletterSignup />);

    expect(screen.getByLabelText('Seu e-mail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inscrever' })).toBeEnabled();
  });

  it('mostra erro de validação e não chama a API com e-mail inválido', async () => {
    const user = userEvent.setup();
    render(<NewsletterSignup />);

    await user.type(screen.getByLabelText('Seu e-mail'), 'invalido');
    await user.click(screen.getByRole('button', { name: 'Inscrever' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Digite um e-mail válido.');
    expect(mockedSubscribe).not.toHaveBeenCalled();
  });

  it('desabilita o botão enquanto envia e confirma a inscrição', async () => {
    let finish!: () => void;
    mockedSubscribe.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const onSubscribed = jest.fn();
    const user = userEvent.setup();
    render(<NewsletterSignup onSubscribed={onSubscribed} />);

    await user.type(screen.getByLabelText('Seu e-mail'), 'ana@exemplo.com');
    await user.click(screen.getByRole('button', { name: 'Inscrever' }));

    expect(screen.getByRole('button', { name: 'Enviando...' })).toBeDisabled();
    await act(async () => finish());
    expect(await screen.findByRole('status')).toHaveTextContent('Inscrição confirmada!');
    expect(mockedSubscribe).toHaveBeenCalledWith('ana@exemplo.com');
    expect(onSubscribed).toHaveBeenCalledWith('ana@exemplo.com');
  });

  it('mostra mensagem de erro quando a API falha', async () => {
    mockedSubscribe.mockRejectedValue(new Error('500'));
    const user = userEvent.setup();
    render(<NewsletterSignup />);

    await user.type(screen.getByLabelText('Seu e-mail'), 'ana@exemplo.com');
    await user.click(screen.getByRole('button', { name: 'Inscrever' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível concluir a inscrição.');
    expect(screen.getByRole('button', { name: 'Inscrever' })).toBeEnabled();
  });

  it('envio com campo vazio também é bloqueado', async () => {
    const user = userEvent.setup();
    render(<NewsletterSignup />);

    await user.click(screen.getByRole('button', { name: 'Inscrever' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Digite um e-mail válido.');
    expect(mockedSubscribe).not.toHaveBeenCalled();
  });
});
`,
  },
};
