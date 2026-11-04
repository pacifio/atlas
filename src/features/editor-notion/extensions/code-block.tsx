import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";
import { CopyGlyph, Hint, buttonVariants } from "@tryatlas/design";
import "@/styles/hljs.css";

/**
 * CodeBlockLowlight wrapped in a React NodeView that adds the header
 * strip from `atlas-knowledge.jsx::CodeBlock` (lines 694–764): language
 * label on the left, Copy button on the right. Syntax highlighting +
 * markdown serialization come from the parent extension unchanged.
 *
 * (The design also has a "Run" button — that's tied to AI/sandbox work
 * and is out of scope this round.)
 */
export function buildAtlasCodeBlock(lowlight: unknown) {
  return CodeBlockLowlight.extend({
    addNodeView() {
      return ReactNodeViewRenderer(CodeBlockView);
    },
  }).configure({ lowlight: lowlight as never });
}

function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const language = (node.attrs.language as string | null) || "plain";
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore — clipboard permissions / non-secure contexts
    }
  };

  return (
    // The package `Code variant="block"` frame: a bordered surface panel.
    <NodeViewWrapper className="atlas-code my-2.5 overflow-hidden rounded-md border border-border bg-panel">
      <div
        className="flex items-center gap-2 border-b border-border-subtle px-3 py-1.5"
        contentEditable={false}
      >
        <input
          className="w-28 bg-transparent font-mono text-xs text-muted-foreground outline-none placeholder:text-muted-foreground"
          value={language === "plain" ? "" : language}
          placeholder="language"
          onChange={(e) => {
            const val = e.target.value.trim();
            updateAttributes({ language: val.length > 0 ? val : null });
          }}
        />
        <span className="flex-1" />
        <Hint label={copied ? "Copied" : "Copy"}>
          <button
            type="button"
            className={buttonVariants({ variant: "ghost", size: "xs" })}
            onClick={handleCopy}
          >
            <CopyGlyph copied={copied} size="sm" />
            {copied ? "Copied" : null}
          </button>
        </Hint>
      </div>
      {/* NodeViewContent's `as` prop is narrowed to "div" in our Tiptap
          types — wrap in <pre> for the design's monospace block frame and let
          lowlight paint `.hljs-*` token spans inside, coloured by the shared
          `styles/hljs.css`. Never the bare `hljs` class: that stylesheet's
          `.hljs` rule paints its own background and padding. */}
      <pre>
        <NodeViewContent
          className={`font-mono text-base leading-relaxed text-secondary-foreground language-${language}`}
        />
      </pre>
    </NodeViewWrapper>
  );
}
