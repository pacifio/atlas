// The composer's inline chip: an atom node whose view is a React component.
//
// A chip is self-contained. Its node carries the feature's whole record as
// one attribute (`data`), so undo/redo restores it from history like any
// other node, and the feature reads it straight off the document. Its text
// form is whatever the feature's `toText` says: the clipboard's plain-text
// flavour and the composer's serializer both use it, and a paste comes back
// through that text (`composer-editor.tsx`), never through a record in HTML.
//
// Performance: ProseMirror only updates a node view when it is handed a NEW
// node object, which happens when that chip itself changes — typing beside it
// reuses the node and touches nothing. The feature's view is memoized on the
// record and the selected bit on top of that, so a transaction that does reach
// it without changing either is free.

import { memo, type ComponentType, type ReactNode } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";

import { cn } from "@/lib/utils";
import { FileIcon } from "@/features/icon-theme/components/file-icon";

/** What a feature's chip view is given. */
export interface ComposerChipViewProps<T> {
  data: T;
  selected: boolean;
  /** Take this chip out of the document, as a Backspace on it would. */
  remove?: () => void;
}

export interface ComposerChipSpec<T> {
  /** The node's schema name; unique per editor. */
  name: string;
  /** The text this chip stands for. */
  toText: (data: T) => string;
  view: ComponentType<ComposerChipViewProps<T>>;
  /**
   * The record for a chip span in HTML that reaches ProseMirror's parser (a
   * drop of HTML from elsewhere; a paste never does), or null to keep the
   * span as its text. The HTML can come from anywhere, so this is the
   * feature's chance to check the shape and drop what only the feature itself
   * may set. It is handed a plain JSON object, never an array or a primitive.
   * Without it, any object is taken as is.
   */
  fromHTML?: (record: Record<string, unknown>) => T | null;
}

/** A `data-chip` attribute's payload as a plain JSON object, or null. */
export function parseChipRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A Tiptap node for one kind of chip. */
export function createChipNode<T>(spec: ComposerChipSpec<T>) {
  const View = memo(spec.view) as ComponentType<ComposerChipViewProps<T>>;
  const fromElement = (el: HTMLElement): T | null => {
    const record = parseChipRecord(el.getAttribute("data-chip"));
    if (!record) return null;
    return spec.fromHTML ? spec.fromHTML(record) : (record as T);
  };
  function ChipNodeView({ node, selected, deleteNode }: ReactNodeViewProps) {
    return <View data={node.attrs.data as T} selected={selected} remove={deleteNode} />;
  }
  ChipNodeView.displayName = `ComposerChip(${spec.name})`;

  return Node.create({
    name: spec.name,
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        data: {
          default: null,
          parseHTML: fromElement,
          renderHTML: (attrs) => ({ "data-chip": JSON.stringify(attrs.data) }),
        },
      };
    },

    parseHTML() {
      return [
        {
          tag: `span[data-composer-chip="${spec.name}"]`,
          // No usable record, no chip: let the span parse as its text.
          getAttrs: (el) => (fromElement(el) === null ? false : null),
        },
      ];
    },

    renderHTML({ node, HTMLAttributes }) {
      return [
        "span",
        mergeAttributes({ "data-composer-chip": spec.name }, HTMLAttributes),
        spec.toText(node.attrs.data as T),
      ];
    },

    renderText({ node }) {
      return spec.toText(node.attrs.data as T);
    },

    addNodeView() {
      return ReactNodeViewRenderer(ChipNodeView, { as: "span" });
    },
  });
}

/** The record a chip node carries. */
export function chipData<T>(node: PMNode): T {
  return node.attrs.data as T;
}

/**
 * The chip's look, for a feature's view to fill in: an icon, a label, and the
 * selection ring when the chip is node-selected. Must be the view's root —
 * `NodeViewWrapper` is what Tiptap mounts.
 */
export function ComposerChip({
  icon,
  label,
  selected,
  title,
  className,
  children,
  ...rest
}: {
  icon: ReactNode;
  label: ReactNode;
  selected: boolean;
  title?: string;
  className?: string;
  children?: ReactNode;
  [data: `data-${string}`]: string | undefined;
} & Pick<React.HTMLAttributes<HTMLSpanElement>, "onMouseEnter" | "onMouseLeave">) {
  return (
    <NodeViewWrapper
      as="span"
      className={cn("atlas-mention-chip", selected && "atlas-mention-chip--selected", className)}
      title={title}
      contentEditable={false}
      {...rest}
    >
      <span className="atlas-mention-chip__icon">{icon}</span>
      <span className="atlas-mention-chip__label">{label}</span>
      {children}
    </NodeViewWrapper>
  );
}

/** A file's or folder's icon under the active icon theme — the same icon the
 *  explorer row for that path shows. */
export function ComposerPathIcon({ path, folder = false }: { path: string; folder?: boolean }) {
  return <FileIcon path={path} kind={folder ? "folder" : "file"} size={12} />;
}
