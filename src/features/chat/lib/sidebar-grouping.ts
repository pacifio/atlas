// Where the chat sidebar names a thread's project.
//
// Scoped to an open project, nearly every row is that project's, so naming it
// on each card is noise: only a row from another project gets its name, on
// the card, because it resumes somewhere else. With no project open the list
// mixes projects, and each run of rows goes under a heading instead.

export interface GroupableRow {
  projectName: string;
  /** The row belongs to a project other than the open one. */
  elsewhere: boolean;
}

export interface RowPlacement {
  /** A heading to draw above the row, or `null`. */
  heading: string | null;
  /** Whether the card itself names its project. */
  showProject: boolean;
}

/**
 * Place the project name for each row of an already-filtered list. `grouped`
 * is "no project is open" — the sidebar's `threads_projects` marks nothing
 * current. Headings are stamped on the filtered rows, so a search that hides
 * a project's first row does not take its heading along.
 */
export function placeProjectNames(rows: readonly GroupableRow[], grouped: boolean): RowPlacement[] {
  return rows.map((row, index) => ({
    heading: grouped && row.projectName !== rows[index - 1]?.projectName ? row.projectName : null,
    showProject: !grouped && row.elsewhere,
  }));
}
