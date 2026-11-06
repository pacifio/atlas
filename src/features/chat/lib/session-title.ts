import { stripInjectedContext } from "./atlas-context";
import { UNTITLED_SESSION } from "../stores/chat-store";

/**
 * The name a session shows under, in the title bar. Its own title when it
 * has one; else the first thing the user asked (what the history list
 * shows), so a session that has not been titled yet still reads as itself
 * rather than "New session".
 */
export function sessionDisplayTitle(
  title: string | undefined | null,
  firstUserContent: string | undefined | null,
): string {
  const t = stripInjectedContext(title ?? "").trim();
  if (t && t !== UNTITLED_SESSION) return t;
  const first = stripInjectedContext(firstUserContent ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return first.slice(0, 60) || UNTITLED_SESSION;
}
