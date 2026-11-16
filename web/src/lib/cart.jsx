import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { courseMeta } from '../data/catalog.js';
import { api } from './api.js';
import { addOnServer, fromServerCart, mergeIntoServer, readServerCart, removeOnServer, snapshot } from './cart-sync.js';
import { useSession } from './session.jsx';

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

/**
 * Shopping cart and wishlist. Signed out, the cart is kept in localStorage; at sign-in
 * it is merged into the account's cart once, and from then on the server holds it.
 * The wishlist stays in this browser.
 */
export function CartProvider({ children }) {
  const { user } = useSession();
  const [items, setItems] = useState(() => load(CART_KEY));
  const [wishlist, setWishlist] = useState(() => load(WISHLIST_KEY));
  const syncedFor = useRef(null); // user id whose server cart is loaded
  const signedIn = useRef(false);

  useEffect(() => { if (user === null) localStorage.setItem(CART_KEY, JSON.stringify(items)); }, [items, user]);
  useEffect(() => { localStorage.setItem(WISHLIST_KEY, JSON.stringify(wishlist)); }, [wishlist]);

  const refresh = useCallback(() => {
    if (!signedIn.current) return Promise.resolve();
    return readServerCart(api).then((cart) => setItems(fromServerCart(cart))).catch(() => {});
  }, []);

  useEffect(() => {
    if (user === undefined) return;
    if (!user) {
      signedIn.current = false;
      if (syncedFor.current) {
        syncedFor.current = null;
        setItems([]);
      }
      return;
    }
    if (syncedFor.current === user.id) return;
    syncedFor.current = user.id;
    signedIn.current = true;
    mergeIntoServer(load(CART_KEY), api)
      .then((cart) => {
        setItems(fromServerCart(cart));
        localStorage.removeItem(CART_KEY);
      })
      .catch(() => {});
  }, [user]);

  const inCart = useCallback((id) => items.some((c) => c.id === id), [items]);
  const inWishlist = useCallback((id) => wishlist.some((c) => c.id === id), [wishlist]);

  const add = useCallback((course) => {
    setItems((list) => (list.some((c) => c.id === course.id) ? list : [...list, snapshot(course)]));
    if (signedIn.current) addOnServer(api, course.id).then((cart) => setItems(fromServerCart(cart))).catch(refresh);
  }, [refresh]);
  const remove = useCallback((id) => {
    setItems((list) => list.filter((c) => c.id !== id));
    if (signedIn.current) removeOnServer(api, id).then((cart) => setItems(fromServerCart(cart))).catch(refresh);
  }, [refresh]);
  /** After a purchase: the server already took the courses out, so only the view changes. */
  const removeMany = useCallback((ids) => {
    setItems((list) => list.filter((c) => !ids.includes(c.id)));
    refresh();
  }, [refresh]);

  const toggleWishlist = useCallback((course) => {
    setWishlist((list) => (list.some((c) => c.id === course.id)
      ? list.filter((c) => c.id !== course.id)
      : [...list, snapshot(course)]));
  }, []);

  const moveToWishlist = useCallback((course) => {
    remove(course.id);
    setWishlist((list) => (list.some((c) => c.id === course.id) ? list : [...list, snapshot(course)]));
  }, [remove]);

  const totals = useMemo(() => {
    const total = items.reduce((sum, c) => sum + courseMeta(c.id).price, 0);
    const original = items.reduce((sum, c) => sum + courseMeta(c.id).listPrice, 0);
    return { total, original, discountPercent: original ? Math.round((1 - total / original) * 100) : 0 };
  }, [items]);

  const value = useMemo(() => ({
    items, wishlist, totals, inCart, inWishlist, add, remove, removeMany, toggleWishlist, moveToWishlist, refresh,
  }), [items, wishlist, totals, inCart, inWishlist, add, remove, removeMany, toggleWishlist, moveToWishlist, refresh]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => useContext(CartContext);
