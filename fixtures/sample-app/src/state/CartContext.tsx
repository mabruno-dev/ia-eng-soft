import { createContext, useContext, useMemo, useReducer, type Dispatch, type ReactNode } from 'react';
import type { CartAction, CartState } from '@/types/cart';
import { cartReducer, initialCartState } from './cartReducer';

interface CartContextValue {
  state: CartState;
  dispatch: Dispatch<CartAction>;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ children, initialState = initialCartState }: { children: ReactNode; initialState?: CartState }) {
  const [state, dispatch] = useReducer(cartReducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart deve ser usado dentro de <CartProvider>');
  return ctx;
}
