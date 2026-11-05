/**
 * What the "Link a pull request" box was given: a number (`42`, `#42`) in
 * the session's repository, or a pull request URL from any repository. Pure,
 * for the test.
 *
 * A URL names its own repository, so it is never read as a number in the
 * session's checkout (that would link whatever pull request has the number
 * here). The dialog finds a checkout of the URL's repository among the
 * session's and every other project's (`findCheckoutFor`), and links it
 * there.
 */

export type LinkInput =
  | { kind: "empty" }
  /** A number, read in the session's checkout. */
  | { kind: "number"; number: number }
  /** A URL: linked in a checkout of `repository`, wherever that is. */
  | { kind: "url"; number: number; repository: string; url: string }
  | { kind: "error"; message: string };

const NUMBER = /^#?(\d+)$/;
/** `https://host/owner/name/pull/42`, with anything after the number. */
const PULL_URL = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i;

export function resolveLinkInput(reference: string): LinkInput {
  const text = reference.trim();
  if (!text) return { kind: "empty" };
  const number = NUMBER.exec(text);
  if (number) {
    const n = Number(number[1]);
    return Number.isSafeInteger(n) && n > 0
      ? { kind: "number", number: n }
      : { kind: "error", message: "Use a pull request number above 0." };
  }
  const url = PULL_URL.exec(text);
  if (!url) return { kind: "error", message: "Use a pull request URL or number, like 42 or #42." };
  const n = Number(url[4]);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { kind: "error", message: "That URL names no pull request." };
  }
  // The canonical address, without the tail (`/files`, a query): it is what
  // a checkout's repository is matched against, host included.
  return {
    kind: "url",
    number: n,
    repository: `${url[2]}/${url[3]}`,
    url: `https://${url[1]}/${url[2]}/${url[3]}/pull/${n}`,
  };
}
