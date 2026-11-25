import { useState, type FormEvent } from 'react';
import { useCart } from '@/state/CartContext';
import { cartDiscount, cartSubtotal, cartTotal } from '@/state/cartReducer';
import { formatCurrency } from '@/utils/format';
import { Button } from './Button';

export function CartSummary() {
  const { state, dispatch } = useCart();
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState<string | null>(null);

  function applyCoupon(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = coupon.trim().toUpperCase();
    if (code !== 'PROMO10') {
      setCouponError('Cupom inválido.');
      return;
    }
    setCouponError(null);
    dispatch({ type: 'applyCoupon', code });
    setCoupon('');
  }

  if (state.items.length === 0) {
    return <p>Seu carrinho está vazio.</p>;
  }

  return (
    <section aria-label="Resumo do carrinho">
      <ul>
        {state.items.map((item) => (
          <li key={item.id}>
            <span>
              {item.name} × {item.quantity}
            </span>{' '}
            <span>{formatCurrency(item.price * item.quantity)}</span>{' '}
            <Button variant="secondary" onClick={() => dispatch({ type: 'remove', id: item.id })}>
              Remover {item.name}
            </Button>
          </li>
        ))}
      </ul>

      {state.couponCode ? (
        <p>
          Cupom {state.couponCode} aplicado.{' '}
          <Button variant="secondary" onClick={() => dispatch({ type: 'removeCoupon' })}>
            Remover cupom
          </Button>
        </p>
      ) : (
        <form onSubmit={applyCoupon} aria-label="Cupom">
          <label htmlFor="coupon">Cupom de desconto</label>
          <input id="coupon" value={coupon} onChange={(e) => setCoupon(e.target.value)} />
          <Button type="submit">Aplicar</Button>
          {couponError && <span role="alert">{couponError}</span>}
        </form>
      )}

      <dl>
        <dt>Subtotal</dt>
        <dd data-testid="subtotal">{formatCurrency(cartSubtotal(state))}</dd>
        {state.couponCode && (
          <>
            <dt>Desconto</dt>
            <dd data-testid="discount">-{formatCurrency(cartDiscount(state))}</dd>
          </>
        )}
        <dt>Total</dt>
        <dd data-testid="total">{formatCurrency(cartTotal(state))}</dd>
      </dl>

      <Button variant="danger" onClick={() => dispatch({ type: 'clear' })}>
        Esvaziar carrinho
      </Button>
    </section>
  );
}
