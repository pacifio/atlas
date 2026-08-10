import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useState } from "react";
import { Copy, Check } from "lucide-react";

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
    <NodeViewWrapper className="atlas-code">
      <div className="atlas-code-header" contentEditable={false}>
        <input
          className="atlas-code-lang"
          value={language === "plain" ? "" : language}
          placeholder="language"
          onChange={(e) => {
            const val = e.target.value.trim();
            updateAttributes({ language: val.length > 0 ? val : null });
          }}
        />
        <span style={{ flex: 1 }} />
        <button type="button" className="atlas-code-copy" onClick={handleCopy} title="Copy">
          {copied ? <Check size={11} strokeWidth={1.7} /> : <Copy size={11} strokeWidth={1.7} />}
          {copied ? " Copied" : ""}
        </button>
      </div>
      {/* NodeViewContent's `as` prop is narrowed to "div" in our Tiptap
          types — wrap in <pre> for the design's monospace block frame
          and let lowlight paint hljs token classes inside. */}
      <pre>
        <NodeViewContent className={`hljs language-${language}`} />
      </pre>
    </NodeViewWrapper>
  );
}
