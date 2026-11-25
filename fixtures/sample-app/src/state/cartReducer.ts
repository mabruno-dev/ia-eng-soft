import type { CartAction, CartItem, CartState } from '../types/cart';

export const VALID_COUPONS: Record<string, number> = { PROMO10: 0.1 };

export const initialCartState: CartState = { items: [], couponCode: null };

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'add': {
      const qty = action.quantity ?? 1;
      const existing = state.items.find((i) => i.id === action.item.id);
      const items: CartItem[] = existing
        ? state.items.map((i) => (i.id === action.item.id ? { ...i, quantity: i.quantity + qty } : i))
        : [...state.items, { ...action.item, quantity: qty }];
      return { ...state, items };
    }
    case 'remove':
      return { ...state, items: state.items.filter((i) => i.id !== action.id) };
    case 'clear':
      return initialCartState;
    case 'applyCoupon': {
      const code = action.code.trim().toUpperCase();
      return code in VALID_COUPONS ? { ...state, couponCode: code } : state;
    }
    case 'removeCoupon':
      return { ...state, couponCode: null };
    default:
      return state;
  }
}

export function cartSubtotal(state: CartState): number {
  return state.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

export function cartDiscount(state: CartState): number {
  const rate = state.couponCode ? (VALID_COUPONS[state.couponCode] ?? 0) : 0;
  return Math.round(cartSubtotal(state) * rate * 100) / 100;
}

export function cartTotal(state: CartState): number {
  return Math.round((cartSubtotal(state) - cartDiscount(state)) * 100) / 100;
}
