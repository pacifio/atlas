/**
 * An Open VSX search hit, as Rust's `open_vsx::OpenVsxExtension` sends it.
 * Shared by the icon-theme installer and the colour-theme importer, which
 * search the same registry for different `contributes` keys.
 */
export interface OpenVsxExtension {
  /** `namespace.name`. */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  license: string;
  downloads: number;
  icon?: string;
  /** Already installed under this id. Always `false` for a colour theme,
   *  which is imported into a file of its own rather than installed. */
  installed: boolean;
}
