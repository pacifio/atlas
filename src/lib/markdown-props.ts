export interface MarkdownProps {
  children: string;
  className?: string;
  /**
   * The project the document belongs to. Given one, file paths in its inline
   * code and links become chips that open the file in Atlas's viewer — inside
   * this folder only (`file-chip-hast.ts`). Unset, no chips: a surface opts
   * in, so one that must never offer a click on a path (the permission
   * prompt) needs to do nothing.
   */
  fileRoot?: string | null;
}
