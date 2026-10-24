/**
 * Pinned sessions' order, as fractional keys.
 *
 * Each pinned session carries a `pinOrder` string, and the Pinned section
 * sorts by plain string comparison. Moving one session mints a key strictly
 * between its new neighbours' keys, so a reorder writes one row instead of
 * renumbering the section. Rust only stores the key (`threads_pin`,
 * `threads_reorder_pin`); every key is minted here.
 *
 * Keys are base-26 digit strings over `a`–`z`, read as fractions in (0, 1).
 * A key never ends in `a` (the minimum digit): there would be no room to
 * place anything immediately before it. A key that breaks the rules — or a
 * pair out of order — makes `pinOrderKeyBetween` answer `null`, and the
 * caller rewrites the section with `spreadPinOrderKeys`.
 */

const DIGITS = "abcdefghijklmnopqrstuvwxyz";

export function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!DIGITS.includes(char)) return false;
  }
  return key.charAt(key.length - 1) !== DIGITS[0];
}

/** The midpoint of two digit strings read as fractions; `""` is the open bound
 *  on either side. Requires `a < b` when `b` is set. */
function midpoint(a: string, b: string): string {
  if (b !== "") {
    let n = 0;
    while ((a.charAt(n) || DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? DIGITS.length : DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) return DIGITS.charAt(Math.round((digitA + digitB) / 2));
  if (b.length > 1) return b.charAt(0);
  return DIGITS.charAt(digitA) + midpoint(a.slice(1), "");
}

/**
 * A key that sorts strictly between `before` and `after`. `null` bounds are
 * the top of the Pinned section and the bottom of its keyed run. Answers
 * `null` instead of throwing when an existing key is corrupt or the pair is
 * out of order.
 */
export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return midpoint(a, b);
}

/** `count` evenly spread keys, ascending — for rewriting a whole section. */
export function spreadPinOrderKeys(count: number): string[] {
  let width = 2;
  let space = DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    if (value % DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = DIGITS.charAt(value % DIGITS.length) + key;
      value = Math.floor(value / DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

/** The key for a session pinned now: at the top of the Pinned section, above
 *  `firstKey` (the current top's key, `null` when nothing is keyed). */
export function pinOrderKeyForNewPin(firstKey: string | null): string {
  return pinOrderKeyBetween(null, firstKey) ?? spreadPinOrderKeys(1)[0]!;
}

/**
 * What to write when the user drops `movedId` at its index in `orderedIds`
 * (the Pinned section's new order). Usually one key — the moved session's,
 * between its new neighbours. When a neighbour has no usable key, the whole
 * section is rewritten with spread keys, and only the rows whose key changes
 * are returned.
 */
export function planPinnedReorder(input: {
  orderedIds: readonly string[];
  keysById: ReadonlyMap<string, string | null | undefined>;
  movedId: string;
}): Array<{ id: string; orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const index = orderedIds.indexOf(movedId);
  if (index === -1) return [];
  const beforeId = index > 0 ? orderedIds[index - 1]! : null;
  const afterId = index < orderedIds.length - 1 ? orderedIds[index + 1]! : null;
  const beforeKey = beforeId !== null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId !== null ? (keysById.get(afterId) ?? null) : null;
  const usable =
    (beforeId === null || beforeKey !== null) && (afterId === null || afterKey !== null);
  if (usable) {
    const key = pinOrderKeyBetween(beforeKey, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  const keys = spreadPinOrderKeys(orderedIds.length);
  return orderedIds.flatMap((id, i) =>
    keysById.get(id) === keys[i] ? [] : [{ id, orderKey: keys[i]! }],
  );
}

/**
 * The Pinned section's order: keyed sessions by key, then any without a key,
 * most recently pinned first. The thread id breaks ties, so the order is total
 * and never flickers.
 */
export function sortByPinOrder<
  T extends { threadId: string; pinOrder: string | null; pinnedAt: string | null },
>(rows: readonly T[]): T[] {
  const keyed = rows.filter((row) => row.pinOrder !== null);
  const keyless = rows.filter((row) => row.pinOrder === null);
  keyed.sort((a, b) =>
    a.pinOrder! < b.pinOrder!
      ? -1
      : a.pinOrder! > b.pinOrder!
        ? 1
        : a.threadId.localeCompare(b.threadId),
  );
  keyless.sort(
    (a, b) =>
      (Date.parse(b.pinnedAt ?? "") || 0) - (Date.parse(a.pinnedAt ?? "") || 0) ||
      a.threadId.localeCompare(b.threadId),
  );
  return [...keyed, ...keyless];
}
