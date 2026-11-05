/**
 * What one split column's header carries, given where the column sits.
 *
 * There is no full-width titlebar: each column draws its own `PaneHeader`, and
 * the window-level controls go in the outermost ones — the leading cluster
 * (traffic lights, the project rail toggle, `org / project`) in the leftmost
 * header, the trailing dock in the rightmost. Nothing sits left of the split
 * columns (the project tree is the Files surface, not a side panel) and
 * nothing right of them (team chat is a surface, ADR-0024), so the first column
 * is always leftmost and the last always rightmost.
 */
export function columnChrome(
  atLeft: boolean,
  atRight: boolean,
): { leading: boolean; breadcrumb: boolean; trailing: boolean } {
  return { leading: atLeft, breadcrumb: atLeft, trailing: atRight };
}
