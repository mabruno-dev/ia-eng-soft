import { useState } from 'react';
import { CartSummary } from '@/components/CartSummary';
import { LoginForm } from '@/components/LoginForm';
import { PasswordField } from '@/components/PasswordField';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UserList } from '@/components/UserList';
import { CartProvider } from '@/state/CartContext';

export function App() {
  const [password, setPassword] = useState('');
  return (
    <CartProvider
      initialState={{
        items: [
          { id: 'p1', name: 'Caneca', price: 39.9, quantity: 2 },
          { id: 'p2', name: 'Camiseta', price: 79.9, quantity: 1 },
        ],
        couponCode: null,
      }}
    >
      <header>
        <h1>ReacTest Sample App</h1>
        <ThemeToggle />
      </header>
      <main>
        <LoginForm />
        <PasswordField value={password} onChange={setPassword} />
        <UserList />
        <CartSummary />
      </main>
    </CartProvider>
  );
}
