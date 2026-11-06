/**
 * The identity of a board row.
 *
 * A Session id alone is not unique across an Organisation: connecting a Local
 * Project to an existing Project, or moving a Project's sync to another one,
 * re-sends the same Sessions under the same ids to a second Project while the
 * first keeps its copy. Both copies are real rows on the board, so a row is
 * identified by its Project as well — the server Project id when it has one,
 * the local checkout path when it has not.
 */
export interface BoardRowRef {
  id: string;
  projectPath: string;
  remoteProjectId: string | null;
}

export function boardKey(row: BoardRowRef): string {
  return `${row.remoteProjectId ?? ""}\u0000${row.projectPath}\u0000${row.id}`;
}

/**
 * The row for a Session addressed by its id and checkout alone — opened from a
 * commit's "Produced by" card or by an agent, which know the folder but not the
 * server Project. `undefined` when the checkout has no such row, or has two (a
 * re-homed Project), because guessing would open the wrong copy.
 */
export function rowForCheckout<T extends BoardRowRef>(
  rows: readonly T[],
  id: string,
  projectPath: string,
): T | undefined {
  const matches = rows.filter((r) => r.id === id && r.projectPath === projectPath);
  return matches.length === 1 ? matches[0] : undefined;
}
