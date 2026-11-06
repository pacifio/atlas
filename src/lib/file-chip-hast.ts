// File paths in rendered markdown as chips: one hast pass, shared by every
// renderer that draws markdown, each with its own policy.
//
//   - the session transcript (`markdown-render.ts`, an HTML string, in the
//     worker): the session's root, the text as written for a label, folders
//     too, and the root stamped on the chip for `open-path-link.ts`;
//   - pull request text, plans, notes, the markdown preview, the README view
//     and team chat (react-markdown, `rehypeFileChips`): one root, the file's
//     base name for a label, and no folders. A click there goes through
//     `openUntrustedPathLink`, which opens Atlas's own viewer or nothing.
//
// Which inline code and link destinations name a file is `file-links.ts`.
// Whether a path is allowed is one rule for every surface: it must resolve
// inside the root. A path outside it (absolute elsewhere, `../` above it) is
// left as the code or link it was, with no chip and no target.
//
// Pure and dependency-free, so it runs in the markdown worker as well.

import {
  bareFileNameCandidate,
  baseNameOf,
  fileChipTitle,
  inlineCodeFileTarget,
  isAbsolutePath,
  isBundleName,
  linkFileTarget,
  linkHrefPathCandidate,
  normalisePath,
  resolveInProject,
  type FileLinkTarget,
} from "./file-links";
import { buildFileLinkParentSuffixByPath, matchChangedFile } from "./workspace-path-match";

export type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};

/** How one surface turns paths into chips. */
export interface FileChipPolicy {
  /** The one folder a chip may point into: relative paths resolve against it,
   *  and anything that lands outside it gets no chip. */
  root: string;
  /** Where a relative link destination resolves, when not the root: a
   *  document's own folder (`[x](../y.md)`). It must still land in `root`.
   *  Inline code always resolves against the root. */
  linkBase?: string;
  /** What a chip reads: the path as written (the transcript), or its base
   *  name, with the parent folders after it when two chips would read alike. */
  label?: "written" | "basename";
  /** A link to a folder (`docs/`) or a bundle (`Foo.app`) becomes a chip.
   *  Off for text other people write: a folder has no tab to open in. */
  folders?: boolean;
  /** Stamp `data-file-root` on the chip (the transcript's opener reads it). */
  stampRoot?: boolean;
  /**
   * A pull request's changed files, relative to `root`. A path that names one
   * — exactly, by its tail, or (only here) by a bare file name that one
   * changed file has — carries it as `data-pr-file`, for the Code tab.
   */
  changedFiles?: readonly string[];
}

/**
 * A chip for a file or folder: the icon theme's icon for the path, its label,
 * and the full path in the tooltip. Clickable when it has a target.
 *
 * The icon is drawn on the main thread, not here: this may run in the worker,
 * and the theme's icons live in the icon-theme store. The slot is a box of
 * fixed size showing the lucide glyph the composer's own fallback draws, so
 * painting the theme's icon in (`paintFileIcons`) swaps one box's contents and
 * moves nothing.
 */
export function fileChipNode(opts: {
  /** Where a click goes; none for a mention that cannot be resolved. */
  target: FileLinkTarget | null;
  /** The path the icon is chosen by. */
  iconPath: string;
  folder: boolean;
  label: string;
  title: string;
  /** The root `target` was resolved under: the session's working directory,
   *  which for a worktree session is not the open project. A click opens a
   *  file under it in Atlas (`open-path-link.ts`). */
  root?: string;
  /** A path outside every root that the composer attached itself
   *  (`ParseOptions.trustedPaths`): the only kind a click may hand to an
   *  editor or the system's app. */
  trusted?: boolean;
  /** The changed file of a pull request this names, relative to its root. */
  prFile?: string;
  /** The text the chip stands for, when its label is shorter (a copy of a
   *  table puts it back). */
  written?: string;
  /** Parent folders shown after the label, to tell two chips apart. */
  suffix?: string;
}): Hast {
  const kind = opts.folder ? "folder" : "file";
  const properties: Record<string, unknown> = {
    className: ["atlas-mention-chip", "atlas-mention-chip--msg", "atlas-file-chip"],
    dataMentionKind: kind,
    title: opts.title,
  };
  if (opts.target) {
    properties.dataFilePath = opts.target.path;
    if (opts.target.line !== undefined) properties.dataFileLine = String(opts.target.line);
    if (opts.target.column !== undefined) properties.dataFileColumn = String(opts.target.column);
    if (opts.root) properties.dataFileRoot = opts.root;
    if (opts.trusted) properties.dataFileTrusted = "true";
    if (opts.prFile) properties.dataPrFile = opts.prFile;
    properties.role = "link";
    properties.tabIndex = 0;
  }
  if (opts.written !== undefined) properties.dataFileText = opts.written;
  // Empty: the fallback glyph is drawn by CSS (`.atlas-file-chip__icon:empty`),
  // so a chip costs four elements, not a dozen of inline SVG per chip.
  const icon: Hast = {
    type: "element",
    tagName: "span",
    properties: {
      className: ["atlas-mention-chip__icon", "atlas-file-chip__icon"],
      dataFileIcon: kind,
      dataFilePath: opts.iconPath,
    },
    children: [],
  };
  const children: Hast[] = [
    icon,
    {
      type: "element",
      tagName: "span",
      properties: { className: ["atlas-mention-chip__label"] },
      children: [{ type: "text", value: opts.label }],
    },
  ];
  if (opts.suffix) {
    children.push({
      type: "element",
      tagName: "span",
      properties: { className: ["atlas-file-chip__suffix"] },
      children: [{ type: "text", value: opts.suffix }],
    });
  }
  return { type: "element", tagName: "span", properties, children };
}

/** The text of an element whose children are all text (or inline code), or
 *  null when it holds anything else. */
export function plainText(node: Hast): string | null {
  let text = "";
  for (const child of node.children ?? []) {
    if (child.type === "text" && typeof child.value === "string") text += child.value;
    else if (child.type === "element" && child.tagName === "code") {
      const inner = plainText(child);
      if (inner === null) return null;
      text += inner;
    } else return null;
  }
  return text;
}

/** Whether a link's text just restates where it goes (`[src/a.ts](src/a.ts)`,
 *  `[a.ts](src/a.ts)`), so the chip can stand in for the whole link. */
function labelRestatesTarget(label: string, href: string): boolean {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/^\.\//, "")
      .replace(/(?::\d+){1,2}$|#L\d+(?:C\d+)?$/i, "")
      .replace(/\/+$/, "");
  const l = clean(label);
  const h = clean(href);
  return l.length > 0 && (h === l || h.endsWith(`/${l}`));
}

/** A link destination as a person would read it: `file://` dropped and
 *  percent-escapes decoded. */
function writtenHref(href: string): string {
  const bare = href.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/** `path` relative to `root`, `/`-separated, or null outside it. */
function relativeTo(path: string, root: string): string | null {
  const p = normalisePath(path);
  const r = normalisePath(root);
  if (!p || !r) return null;
  const base = r.endsWith("/") ? r : `${r}/`;
  return p.startsWith(base) ? p.slice(base.length) : null;
}

/**
 * The file a link destination names. A relative destination resolves against
 * `linkBase` when the policy has one (a document's own folder), and wherever
 * it lands it must be inside the root.
 */
function linkTarget(href: string, policy: FileChipPolicy): FileLinkTarget | null {
  const base = policy.linkBase;
  if (!base) return linkFileTarget(href, policy.root);
  const candidate = linkHrefPathCandidate(href);
  if (!candidate) return null;
  const relative = !isAbsolutePath(candidate.path) && !candidate.path.startsWith("~/");
  const absolute = relative ? normalisePath(`${base}/${candidate.path}`) : candidate.path;
  const path = absolute ? resolveInProject(absolute, policy.root) : null;
  return path ? { ...candidate, path } : null;
}

/** A chip the walk found, before its label is known. */
interface Found {
  node: Hast;
  target: FileLinkTarget;
  written: string;
  prFile?: string;
}

/**
 * Where a path a policy allows points: the file in the root, and the changed
 * file it names, if any. Null outside the root, or for a folder the policy
 * does not draw.
 */
function resolveTarget(
  target: FileLinkTarget | null,
  written: string,
  policy: FileChipPolicy,
): { target: FileLinkTarget; prFile?: string } | null {
  const changed = policy.changedFiles;
  if (!target) {
    // A bare name (`settings.json`) is a file only if the pull request
    // changed exactly one file of that name.
    if (!changed?.length) return null;
    const bare = bareFileNameCandidate(written);
    if (!bare) return null;
    const prFile = matchChangedFile(bare.path, changed, policy.root);
    if (!prFile) return null;
    const path = resolveInProject(prFile, policy.root);
    return path ? { target: { ...bare, path, folder: false }, prFile } : null;
  }
  const folder = target.folder || isBundleName(baseNameOf(target.path));
  if (folder && policy.folders === false) return null;
  if (!changed?.length || folder) return { target };
  const rel = relativeTo(target.path, policy.root);
  const prFile = rel === null ? null : matchChangedFile(rel, changed, policy.root);
  if (!prFile) return { target };
  const path = resolveInProject(prFile, policy.root);
  return path ? { target: { ...target, path }, prFile } : { target };
}

/**
 * Turn the file paths in `tree` into chips, by `policy`. Inline code and link
 * destinations only; fenced code is never touched, nor an existing chip.
 */
export function applyFileChips(tree: Hast, policy: FileChipPolicy): void {
  const { root } = policy;
  if (!root) return;
  const found: Found[] = [];
  const chip = (target: FileLinkTarget, written: string, prFile?: string): Hast => {
    const node: Hast = { type: "element", tagName: "span", properties: {}, children: [] };
    found.push({ node, target, written: written.trim(), prFile });
    return node;
  };
  const walk = (node: Hast) => {
    if (!node.children) return;
    const next: Hast[] = [];
    for (const child of node.children) {
      if (child.type !== "element" || child.tagName === "pre") {
        next.push(child);
        continue;
      }
      if (child.tagName === "code") {
        const text = plainText(child);
        const resolved =
          text === null ? null : resolveTarget(inlineCodeFileTarget(text, root), text, policy);
        next.push(resolved && text !== null ? chip(resolved.target, text, resolved.prFile) : child);
        continue;
      }
      const href = child.tagName === "a" ? child.properties?.href : undefined;
      const resolved =
        typeof href === "string"
          ? (() => {
              const target = linkTarget(href, policy);
              return target ? resolveTarget(target, href, policy) : null;
            })()
          : null;
      if (resolved && typeof href === "string") {
        const label = plainText(child);
        if (label !== null && labelRestatesTarget(label, href)) {
          next.push(chip(resolved.target, label, resolved.prFile));
        } else {
          // The link's own words stay, as text: an anchor with a relative
          // href would navigate the webview away. The chip follows them.
          walk(child);
          next.push(
            ...(child.children ?? []),
            { type: "text", value: " " },
            chip(resolved.target, writtenHref(href), resolved.prFile),
          );
        }
        continue;
      }
      // A mention chip is already a chip.
      const cls = child.properties?.className;
      if (!(Array.isArray(cls) && cls.includes("atlas-mention-chip"))) walk(child);
      next.push(child);
    }
    node.children = next;
  };
  walk(tree);
  if (found.length === 0) return;

  // Labels last: a base name needs every other chip's path to know whether
  // it must say which folder it is in.
  const basename = policy.label === "basename";
  const suffixes = basename
    ? buildFileLinkParentSuffixByPath(found.map((f) => relativeTo(f.target.path, root) ?? ""))
    : null;
  for (const f of found) {
    const rel = relativeTo(f.target.path, root) ?? "";
    const label = basename ? baseNameOf(f.target.path) : f.written;
    Object.assign(
      f.node,
      fileChipNode({
        target: f.target,
        iconPath: f.target.path,
        folder: f.target.folder,
        label,
        title: fileChipTitle(f.target),
        root: policy.stampRoot ? root : undefined,
        prFile: f.prFile,
        written: basename ? f.written : undefined,
        suffix: suffixes?.get(rel),
      }),
    );
  }
}

/**
 * The same pass as a unified plugin, for react-markdown: `[rehypeFileChips,
 * policy]`. A null policy draws no chips (no root, or a surface that must not
 * have them).
 */
export function rehypeFileChips(policy: FileChipPolicy | null | undefined) {
  return (tree: Hast) => {
    if (policy?.root) applyFileChips(tree, policy);
  };
}
