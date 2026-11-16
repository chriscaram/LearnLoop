// Pure helpers for the shopping cart. Signed out, the cart lives in localStorage;
// signed in, the server cart (/api/me/cart) is the source of truth. At sign-in the
// courses added while signed out are merged into the server cart once.

/** Only the course summary fields the cart needs to render without refetching. */
export const snapshot = (c) => ({
  id: c.id, title: c.title, category: c.category, level: c.level,
  summary: c.summary, lessonCount: c.lessonCount, durationMin: c.durationMin,
});

/** The server cart ({ items: [{ courseId, addedAt, course }] }) as cart items. */
export function fromServerCart(cart) {
  return (cart?.items ?? []).map((i) => ({ ...snapshot(i.course), addedAt: i.addedAt }));
}

/** Local course ids that are not on the server yet, in local order, without duplicates. */
export function coursesToMerge(localItems, serverCart) {
  const onServer = new Set((serverCart?.items ?? []).map((i) => i.courseId));
  const ids = [];
  for (const item of localItems ?? []) {
    if (item?.id && !onServer.has(item.id) && !ids.includes(item.id)) ids.push(item.id);
  }
  return ids;
}

/** Errors that mean "this course cannot be in the cart" (gone, already enrolled, malformed), not "try again". */
const SKIPPABLE = new Set([400, 404, 409]);

/**
 * Reads the server cart and adds the local courses it lacks. `call(path, options)` is
 * the API client. Returns the server cart after the merge.
 */
export async function mergeIntoServer(localItems, call) {
  let cart = (await call('/api/me/cart')).cart;
  for (const courseId of coursesToMerge(localItems, cart)) {
    try {
      cart = (await call('/api/me/cart/items', { method: 'POST', body: { courseId } })).cart;
    } catch (error) {
      if (!SKIPPABLE.has(error?.status)) throw error;
    }
  }
  return cart;
}

export async function addOnServer(call, courseId) {
  return (await call('/api/me/cart/items', { method: 'POST', body: { courseId } })).cart;
}

export async function removeOnServer(call, courseId) {
  return (await call(`/api/me/cart/items/${encodeURIComponent(courseId)}`, { method: 'DELETE' })).cart;
}

export async function readServerCart(call) {
  return (await call('/api/me/cart')).cart;
}
