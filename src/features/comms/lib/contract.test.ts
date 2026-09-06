import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROADCAST_SOURCE,
  CHANNEL_NAME_MAX,
  CHAT_BODY_MAX_BYTES,
  CHAT_MESSAGE_ATTACHMENT_MAX,
  CHAT_PIN_LIMIT,
  CHAT_REACTION_EMOJI,
  CHAT_TYPING_INTERVAL_MS,
  MENTION_SOURCE,
} from "../types";

/**
 * Drift guard against the server's wire contract.
 *
 * `packages/contracts/src/chat.ts` wins over every document and over this
 * repo's mirror of it, so the mirror has to be checked rather than trusted.
 * This is not ceremony: the reaction allowlist had already drifted by six
 * emoji before this test existed — six buttons the picker drew that the server
 * would have refused with a `400`.
 *
 * Reads the clone at test time and skips when it is absent, so a fresh checkout
 * without `.atlas/repos/server` does not fail CI for a reason nobody can act on.
 */

const CONTRACT = resolve(
  __dirname,
  "../../../../.atlas/repos/server/packages/contracts/src/chat.ts",
);

const available = existsSync(CONTRACT);
const source = available ? readFileSync(CONTRACT, "utf8") : "";

/** Pull a `export const NAME = [ … ]` array of string literals out of the source. */
function serverArray(name: string): string[] {
  const start = source.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`${name} not found in the contract`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("];", open);
  const body = source.slice(open + 1, close);
  // Entries are quoted literals, one per line, each followed by a `//` comment.
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    // The contract writes them as \u{…} escapes; evaluate to the real grapheme.
    m[1].replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))),
  );
}

/**
 * Pull a `export const NAME = <number>` out of the source.
 *
 * The right-hand side is not always a literal — `CHAT_BODY_MAX_BYTES` is
 * `16 * 1024` — so the arithmetic is evaluated, after checking it contains
 * nothing but digits, separators and the two operators the contract uses.
 */
function serverNumber(name: string): number {
  const re = new RegExp(`export const ${name}\\s*=\\s*([0-9_*+\\s]+);`);
  const m = re.exec(source);
  if (!m) throw new Error(`${name} not found in the contract`);
  const expr = m[1].replace(/_/g, "").trim();
  if (!/^[0-9*+\s]+$/.test(expr)) throw new Error(`${name} is not arithmetic: ${expr}`);
  return expr
    .split("+")
    .reduce((sum, term) => sum + term.split("*").reduce((p, n) => p * Number(n.trim()), 1), 0);
}

/**
 * Pull a `export const NAME = "…"` string out of the source.
 *
 * Parsed rather than sliced: the source text of `BROADCAST_SOURCE` contains
 * `\\w`, whose runtime value is `\w`. Comparing raw source against a runtime
 * constant would fail on every pattern that escapes anything.
 */
function serverString(name: string): string {
  const re = new RegExp(`export const ${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")`);
  const m = re.exec(source);
  if (!m) throw new Error(`${name} not found in the contract`);
  return JSON.parse(m[1]) as string;
}

describe.skipIf(!available)("wire contract drift", () => {
  it("mirrors CHAT_REACTION_EMOJI exactly, in order", () => {
    // Order matters as well as membership: the picker renders in array order,
    // and a stored reaction must be byte-identical to what was allowed
    // (❤️ and ⚠️ carry a variation selector).
    expect([...CHAT_REACTION_EMOJI]).toEqual(serverArray("CHAT_REACTION_EMOJI"));
  });

  it("mirrors the mention patterns", () => {
    expect(MENTION_SOURCE).toBe(serverString("MENTION_SOURCE"));
    expect(BROADCAST_SOURCE).toBe(serverString("BROADCAST_SOURCE"));
  });

  it("mirrors the numeric limits the composer enforces", () => {
    expect(CHAT_BODY_MAX_BYTES).toBe(serverNumber("CHAT_BODY_MAX_BYTES"));
    expect(CHANNEL_NAME_MAX).toBe(serverNumber("CHANNEL_NAME_MAX"));
    expect(CHAT_MESSAGE_ATTACHMENT_MAX).toBe(serverNumber("CHAT_MESSAGE_ATTACHMENT_MAX"));
    expect(CHAT_PIN_LIMIT).toBe(serverNumber("CHAT_PIN_LIMIT"));
    expect(CHAT_TYPING_INTERVAL_MS).toBe(serverNumber("CHAT_TYPING_INTERVAL_MS"));
  });
});
