import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { evictCoverUrl } from "../lib/cover-url-cache";
import { COVER_GRADIENTS } from "../lib/cover-gradients";
import { uploadKnowledgeCover } from "../lib/knowledge-api";
import { CoverPickerView } from "./views/cover-picker-view";

interface CoverPickerProps {
  value: string | null;
  projectPath: string;
  entryId: string;
  anchorRect: DOMRect | null;
  onPick: (cover: string | null) => void;
  onClose: () => void;
}

/** The cover picker's upload path; everything it draws is `CoverPickerView`. */
export function CoverPicker({
  value,
  projectPath,
  entryId,
  anchorRect,
  onPick,
  onClose,
}: CoverPickerProps) {
  const handleUpload = async () => {
    try {
      const selected = await openFileDialog({
        filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      const rel = await uploadKnowledgeCover(projectPath, entryId, selected as string);
      // The ref is entry-id-stable (`covers/<entryId>.<ext>`) — a re-upload
      // reuses it, so the cached data URL must go or the old image shows.
      evictCoverUrl(projectPath, rel);
      onPick(rel);
      onClose();
    } catch (e) {
      console.error("cover upload failed", e);
    }
  };

  return (
    <CoverPickerView
      value={value}
      anchorRect={anchorRect}
      gradients={COVER_GRADIENTS}
      onPick={onPick}
      onUpload={() => void handleUpload()}
      onClose={onClose}
    />
  );
}
