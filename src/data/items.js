export const ITEMS = {
  Wood: { name: 'Wood', type: 'resource', stackable: true, maxStack: 50, weight: 1 },
};

/** Returns the ITEMS entry for a key, or a fallback stub if unknown. */
export function getItem(key) {
  return ITEMS[key] ?? { name: key, type: 'resource', stackable: true, maxStack: 50, weight: 1 };
}
