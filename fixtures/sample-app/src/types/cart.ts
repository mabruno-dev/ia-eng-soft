export interface CartItem {
  id: string;
  name: string;
  price: number; // em reais
  quantity: number;
}

export interface CartState {
  items: CartItem[];
  couponCode: string | null;
}

export type CartAction =
  | { type: 'add'; item: Omit<CartItem, 'quantity'>; quantity?: number }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'applyCoupon'; code: string }
  | { type: 'removeCoupon' };
