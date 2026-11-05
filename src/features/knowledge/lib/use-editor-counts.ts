import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";

/** Word/char counts come straight from the live editor JSON so they
 *  stay in sync with every keystroke without round-tripping markdown. */
export function useEditorCounts(editorInstance: Editor | null) {
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);

  useEffect(() => {
    if (!editorInstance) {
      setWordCount(0);
      setCharCount(0);
      return;
    }
    const update = () => {
      const text = editorInstance.state.doc.textBetween(
        0,
        editorInstance.state.doc.content.size,
        " ",
        " ",
      );
      const trimmed = text.trim();
      setWordCount(trimmed ? trimmed.split(/\s+/).length : 0);
      setCharCount(text.length);
    };
    update();
    editorInstance.on("update", update);
    return () => {
      editorInstance.off("update", update);
    };
  }, [editorInstance]);

  return { wordCount, charCount };
}
