/**
 * Vimium-style hint-label generator. Produces `count` short, prefix-free labels
 * (no label is a prefix of another, so typing is unambiguous) drawn from a
 * home-row-biased alphabet. Uses the minimum label length needed: with a
 * 19-char alphabet that's single chars up to 19 targets, two chars up to 361,
 * etc.
 */

// Home-row + easy reaches first, so the most common targets get the easiest keys.
const HINT_ALPHABET = "fjdkslaghrueiwovncm";

export function generateLabels(count: number, alphabet = HINT_ALPHABET): string[] {
  const chars = alphabet.split("");
  const n = chars.length;
  if (count <= 0) return [];
  if (count <= n) return chars.slice(0, count);

  // Determine the smallest length L such that n^L >= count.
  let length = 1;
  let capacity = n;
  while (capacity < count) {
    length += 1;
    capacity *= n;
  }

  // Generate `count` labels of fixed length L in odometer order. Fixed length
  // guarantees prefix-freeness (every label is the same length).
  const labels: string[] = [];
  const idx: number[] = Array.from({ length }, () => 0);
  for (let k = 0; k < count; k++) {
    let label = "";
    for (let p = 0; p < length; p++) label += chars[idx[p]];
    labels.push(label);
    // Increment the odometer (last digit fastest).
    for (let p = length - 1; p >= 0; p--) {
      idx[p] += 1;
      if (idx[p] < n) break;
      idx[p] = 0;
    }
  }
  return labels;
}
