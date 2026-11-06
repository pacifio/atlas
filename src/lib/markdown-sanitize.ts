// The allowlist raw HTML in a rendered document is cut down to: the markdown
// file preview and the README view both parse raw HTML (`rehype-raw`), and
// both run it through this.

import { defaultSchema } from "rehype-sanitize";

/**
 * What a trusted document's raw HTML may keep: GitHub's own allowlist, plus
 * the sizing attributes README images carry. A cloned repo is not trusted
 * *code* — `<meta http-equiv="refresh">` would be hoisted into the app's
 * `<head>` by React and navigate the whole window, `<style>` restyles the app
 * globally, and `<iframe srcdoc>` runs whatever it holds. The tags below are
 * dropped (the default schema already omits them; naming them keeps a later
 * widening of `tagNames` from letting one back in), and no element may carry
 * a `style` attribute, so nothing can pin a full-window overlay either.
 */
const BLOCKED_TAGS = new Set([
  "meta",
  "style",
  "script",
  "iframe",
  "frame",
  "frameset",
  "link",
  "base",
  "form",
  "object",
  "embed",
  "applet",
  "dialog",
  "template",
  "svg",
  "math",
]);
export const PREVIEW_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "picture", "source"].filter(
    (t) => !BLOCKED_TAGS.has(t),
  ),
  attributes: Object.fromEntries(
    Object.entries({
      ...defaultSchema.attributes,
      img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "align"],
      source: ["srcSet", "media"],
    }).map(([tag, attrs]) => [
      tag,
      (attrs ?? []).filter((a) => (Array.isArray(a) ? a[0] : a) !== "style"),
    ]),
  ),
};
