/** A line count short enough for a header: `999`, `2.4k`, `12k`, `1.2m`. */
export function formatCompactCount(value: number): string {
  if (value < 1000) return String(value);
  // 999,950 rounds to "1000k": past that it reads in millions.
  const [scaled, unit] = value < 999_500 ? [value / 1000, "k"] : [value / 1_000_000, "m"];
  const digits = scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, "") : String(Math.round(scaled));
  return `${digits}${unit}`;
}
