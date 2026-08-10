// Heuristic "does this model accept image input?" — there's no universal
// capability endpoint, so we match on well-known multimodal model families.
// Used to gate the composer's image attachment (file picker) button.

export function modelSupportsVision(provider: string, model: string): boolean {
  const m = model.toLowerCase();
  if (!m) return false;

  switch (provider) {
    case "google":
      // All Gemini 1.5/2.x models are multimodal (exclude embedding models).
      return m.includes("gemini") && !m.includes("embedding");
    case "anthropic":
      // Claude 3 and 4 families are all vision-capable.
      return (
        m.startsWith("claude-3") ||
        m.startsWith("claude-4") ||
        /claude-(opus|sonnet|haiku)-[4-9]/.test(m)
      );
    case "openai":
      return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|chatgpt-4o|o1|o3|o4/.test(m);
    default:
      // Open-weight + gateway providers: match common vision model markers.
      return /vision|-vl\b|vl-|pixtral|llava|internvl|qwen2?-vl|llama-3\.2|maverick|scout/.test(m);
  }
}

/** MIME type from a file path's extension (image kinds only). */
export function imageMimeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return null;
  }
}
