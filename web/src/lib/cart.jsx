import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { courseMeta } from '../data/catalog.js';

const CartContext = createContext(null);
const CART_KEY = 'learnloop.cart.v1';
const WISHLIST_KEY = 'learnloop.wishlist.v1';

function load(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Only the course summary fields the cart needs to render without refetching. */
const snapshot = (c) => ({
  id: c.id, title: c.title, category: c.category, level: c.level,
  summary: c.summary, lessonCount: c.lessonCount, durationMin: c.durationMin,
});

/** Shopping cart and wishlist, kept in localStorage (client-side only). */
export function CartProvider({ children }) {
  const [items, setItems] = useState(() => load(CART_KEY));
  const [wishlist, setWishlist] = useState(() => load(WISHLIST_KEY));

  useEffect(() => { localStorage.setItem(CART_KEY, JSON.stringify(items)); }, [items]);
  useEffect(() => { localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist)); }, [wishlist]);

  const inCart = useCallback((id) => items.some((c) => c.id === id), [items]);
  const inWishlist = useCallback((id) => wishlist.some((c) => c.id === id), [wishlist]);

  const add = useCallback((course) => {
    setItems((list) => (list.some((c) => c.id === course.id) ? list : [...list, snapshot(course)]));
  }, []);
  const remove = useCallback((id) => setItems((list) => list.filter((c) => c.id !== id)), []);
  const removeMany = useCallback((ids) => setItems((list) => list.filter((c) => !ids.includes(c.id))), []);
  const clear = useCallback(() => setItems([]), []);

  const toggleWishlist = useCallback((course) => {
    setWishlist((list) => (list.some((c) => c.id === course.id)
      ? list.filter((c) => c.id !== course.id)
      : [...list, snapshot(course)]));
  }, []);

  const moveToWishlist = useCallback((course) => {
    setItems((list) => list.filter((c) => c.id !== course.id));
    setWishlist((list) => (list.some((c) => c.id === course.id) ? list : [...list, snapshot(course)]));
  }, []);

  const totals = useMemo(() => {
    const total = items.reduce((sum, c) => sum + courseMeta(c.id).price, 0);
    const original = items.reduce((sum, c) => sum + courseMeta(c.id).listPrice, 0);
    return { total, original, discountPercent: original ? Math.round((1 - total / original) * 100) : 0 };
  }, [items]);

  const value = useMemo(() => ({
    items, wishlist, totals, inCart, inWishlist, add, remove, removeMany, clear, toggleWishlist, moveToWishlist,
  }), [items, wishlist, totals, inCart, inWishlist, add, remove, removeMany, clear, toggleWishlist, moveToWishlist]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
