/**
 * Take a Session out of Atlas.
 *
 * Two formats because there are two reasons to want one: **JSON** is the record
 * as the store holds it — every field, machine-readable, suitable for a script
 * or a bug report — and **Markdown** is the record as a person reads it, which
 * is what gets pasted into a ticket or a review.
 *
 * Neither redacts anything further. Scrubbing already happened before
 * persistence, so what is on screen is what leaves — and quietly removing more
 * on the way out would produce an export that does not match the Session it
 * claims to be.
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { agentLabel, formatDuration, prettyModel, tokenLabel } from "./board";
import type { SessionDetail, TimelineEntry } from "../types";

export type ExportFormat = "json" | "md";

/**
 * A filename someone can find again.
 *
 * The title leads because that is what the Session is *about*; the id tails it
 * so two exports of two similarly-named Sessions never collide.
 */
function filename(detail: SessionDetail, format: ExportFormat): string {
  const title = (detail.summary.title ?? "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${title || "session"}-${detail.summary.id.slice(-8)}.${format}`;
}

/**
 * Prompt for a location and write the Session there.
 *
 * Resolves `false` when the dialog is dismissed, which is not an error and must
 * not be reported as one.
 */
export async function exportSession(detail: SessionDetail, format: ExportFormat): Promise<boolean> {
  const path = await save({
    defaultPath: filename(detail, format),
    filters: [
      format === "json"
        ? { name: "JSON", extensions: ["json"] }
        : { name: "Markdown", extensions: ["md"] },
    ],
  });
  if (!path) return false;
  // `write_file_content` rather than the fs plugin: the plugin is not in the
  // capability set, and this command is already how the canvas export writes.
  await invoke("write_file_content", {
    path,
    content: format === "json" ? toJson(detail) : toMarkdown(detail),
  });
  return true;
}

function toJson(detail: SessionDetail): string {
  return JSON.stringify(detail, null, 2);
}

function toMarkdown(detail: SessionDetail): string {
  const s = detail.summary;
  const lines: string[] = [];

  lines.push(`# ${s.title ?? "Untitled session"}`, "");
  lines.push(`- **Agent** — ${s.agent ? agentLabel(s.agent) : "unknown"}`);
  if (s.model) lines.push(`- **Model** — ${prettyModel(s.model)}`);
  if (s.branches[0]) lines.push(`- **Branch** — \`${s.branches[0]}\``);
  lines.push(`- **Started** — ${new Date(s.startedAt).toLocaleString()}`);
  lines.push(`- **Duration** — ${formatDuration(s.activeSeconds)}`);
  const tokens = tokenLabel(s);
  if (tokens) lines.push(`- **Tokens** — ${tokens}`);
  lines.push(`- **Tool calls** — ${s.toolCallCount}`);
  if (s.checkpointCount > 0) lines.push(`- **Checkpoints** — ${s.checkpointCount}`);
  lines.push("");

  for (const entry of detail.entries) {
    lines.push(...entryMarkdown(entry), "");
  }
  return lines.join("\n");
}

function entryMarkdown(entry: TimelineEntry): string[] {
  const at = new Date(entry.at).toLocaleTimeString();
  switch (entry.kind) {
    case "prompt":
      return [`## Prompt · ${at}`, "", fence(entry.text ?? "")];
    case "response":
      // Responses are already markdown, so they are inlined rather than fenced —
      // fencing them would export a wall of literal backticks.
      return [`## Response · ${at}`, "", entry.text ?? ""];
    case "thinking":
      return [`## Thinking · ${at}`, "", fence(entry.text ?? "")];
    case "tool_call": {
      const head = `## ${entry.toolName ?? "Tool call"} · ${at}${
        entry.toolStatus === "failed" ? " — failed" : ""
      }`;
      const out = [head, ""];
      if (entry.paths.length) out.push(entry.paths.map((p) => `\`${p}\``).join(" "), "");
      if (entry.arguments) out.push("**Arguments**", "", fence(entry.arguments, "json"));
      if (entry.result) out.push("**Result**", "", fence(entry.result));
      return out;
    }
    case "checkpoint": {
      const sha = entry.commitSha?.slice(0, 7) ?? "unknown";
      const stat =
        entry.insertions || entry.deletions ? ` (+${entry.insertions} −${entry.deletions})` : "";
      const out = [`## Checkpoint \`${sha}\` · ${at}`, "", entry.commitSubject ?? "_no subject_"];
      if (stat) out.push("", `Changed${stat}:`);
      if (entry.files.length) out.push("", ...entry.files.map((f) => `- \`${f}\``));
      return out;
    }
  }
}

/**
 * Fence a payload without letting it break out.
 *
 * A result containing its own triple backtick would end the block early and
 * spill the rest as prose, so the fence grows past the longest run inside it.
 */
function fence(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${text}\n${ticks}`;
}
