import { getStore } from '@learnloop/shared/store';

/** The user's cart items ({ course_id, added_at }), oldest first. */
export async function listCartItems(userId) {
  const entry = (await getStore().read('carts')).find((c) => c.user_id === userId);
  return entry ? [...entry.items] : [];
}

/**
 * Applies `change(items)` to the user's item list and returns its result. An entry
 * whose list ends up empty is removed, so the document only holds non-empty carts.
 */
export async function updateCartItems(userId, change) {
  return getStore().update('carts', (all) => {
    let entry = all.find((c) => c.user_id === userId);
    if (!entry) {
      entry = { user_id: userId, items: [] };
      all.push(entry);
    }
    const result = change(entry.items);
    if (entry.items.length === 0) all.splice(all.indexOf(entry), 1);
    return result;
  });
}
