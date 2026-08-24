import { modelchat, listenModelChat, type WireMsg } from "@/lib/byok/byok-chat";

/**
 * Generate a Conventional-Commits message for a turn's edits via a single BYOK
 * model call. Resolves to `""` on error/cancel so the caller can fall back to a
 * plain default. The result is always shown to the user in an editable confirm
 * dialog before anything is committed.
 */
export function generateCommitMessage(opts: {
  turnText: string;
  files: string[];
  provider: string;
  model: string;
}): Promise<string> {
  return new Promise((resolve) => {
    const streamId = crypto.randomUUID();
    let text = "";
    let unlisten: (() => void) | null = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unlisten?.();
      resolve(text.trim());
    };

    const prompt = [
      "Write a Conventional-Commits message for the changes below.",
      "Format: a `type(scope): subject` line under 65 chars, then an optional",
      "blank line and 1-3 short body bullets. Return ONLY the commit message,",
      "no code fences, no preamble.",
      opts.files.length ? `Files: ${opts.files.join(", ")}` : "",
      "",
      "Changes:",
      opts.turnText.slice(0, 4000),
    ].join("\n");
    const messages: WireMsg[] = [{ role: "user", content: prompt }];

    (async () => {
      try {
        unlisten = await listenModelChat((e) => {
          if (e.stream_id !== streamId) return;
          if (e.kind === "text_delta") text += e.delta;
          else if (e.kind === "done" || e.kind === "error") finish();
        });
        await modelchat.stream(streamId, opts.provider, opts.model, messages);
        setTimeout(finish, 500);
      } catch {
        finish();
      }
    })();
  });
}
