import { StarterKit } from "@tiptap/starter-kit";
import { Bold } from "@tiptap/extension-bold";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import { Link } from "@tiptap/extension-link";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Typography } from "@tiptap/extension-typography";
import { Highlight } from "@tiptap/extension-highlight";
// NOTE: Tiptap v3's starter-kit already bundles Underline, so we don't
// re-import it standalone — that would register `underline` twice and
// log a "Duplicate extension names found" warning at boot.
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import { common, createLowlight } from "lowlight";
import { Slash } from "../extensions/slash-suggestion";
import { Callout } from "../extensions/callout";
import { Toggle } from "../extensions/toggle";
import { buildAtlasCodeBlock } from "../extensions/code-block";
import { AtlasMention } from "../extensions/mention";

const lowlight = createLowlight(common);

export interface BuildExtensionsOpts {
  placeholder?: string;
}

/**
 * Tiptap extension stack for the Atlas notes editor. Built as a
 * function so per-document options (placeholder text, slash trigger,
 * future per-page mention config) can be passed without forking the
 * file. Custom blocks (Callout, Toggle, code-block header chrome,
 * Mention) land in Phase D — this list is the Phase A baseline.
 */
export function buildExtensions(opts: BuildExtensionsOpts = {}) {
  return [
    // starter-kit disables codeBlock because we use lowlight below for
    // syntax highlighting; everything else (paragraph, heading, lists,
    // blockquote, history, hr, bold/italic/strike/code marks,
    // hardBreak) stays on the defaults.
    StarterKit.configure({
      codeBlock: false,
      link: false, // override with our own Link config below
      // Disable StarterKit's Bold so we can re-register it without the
      // Cmd+B / Ctrl+B keyboard shortcut — Cmd+B is reserved app-wide
      // for the left panel toggle and users were accidentally bolding
      // KB notes while toggling the sidebar.
      bold: false,
    }),
    // Re-add Bold so the mark + toolbar button still work; just no
    // keyboard shortcut. Users can still bold via the toolbar or by
    // typing the markdown `**...**` shortcut (handled by inputRules).
    Bold.extend({
      addKeyboardShortcuts() {
        return {};
      },
    }),
    // Atlas-customized code block: lowlight syntax highlighting wrapped
    // in a React NodeView that adds the design's header strip (language
    // label + Copy button).
    buildAtlasCodeBlock(lowlight),
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { rel: "noopener noreferrer" },
    }),
    Placeholder.configure({
      placeholder:
        opts.placeholder ?? "Press '/' for blocks, or just start writing…",
      emptyEditorClass: "is-editor-empty",
      emptyNodeClass: "is-empty",
    }),
    Typography,
    Highlight,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    // tiptap-markdown lets us load a markdown string via
    // `editor.commands.setContent(md)` and read it back via
    // `editor.storage.markdown.getMarkdown()`. Phase D will register
    // custom node serializers here for Callout / Toggle.
    Markdown.configure({
      html: true,
      tightLists: true,
      bulletListMarker: "-",
      linkify: true,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    // Atlas slash menu — `/` trigger fires the grouped Notion-style
    // block picker rendered by SlashMenu.
    Slash,
    // Custom block primitives — each registers a NodeView + a
    // markdown serializer via addStorage.
    Callout,
    Toggle,
    // Inline @-mention chip wired to Atlas's mention_search Rust command.
    AtlasMention,
  ];
}
