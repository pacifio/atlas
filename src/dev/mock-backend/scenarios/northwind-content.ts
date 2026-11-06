// The words of the `northwind` scenario: every Session, commit, comment, chat
// message, prompt draft and scripted agent run the Atlas Learn videos show.
// The shape is `northwind-content-types.ts`; the wiring is `northwind-world.ts`.
//
// The code itself lives in `fixtures/northwind-repo.ts`, with the commit that
// wrote each line. Every Session's Edit and Write calls take their diffs from
// there (`edits`), and every commit its file list (`filesOf`), so a tool call
// on the Timeline, the commit in Source Control and blame in the editor always
// show the same lines. Reads (`read`) show the file as it stood at the time.
// Only `s-discount` (video 1's run, which the git panel applies on camera) and
// the live Session's uncommitted steps are written out by hand.
//
// Times are relative to page load — see `When`. The cast is two people:
// Uzayer (signed in on the desktop) and Zuhayer. Uzayer runs Claude Code and
// Atlas Agent; Codex is Zuhayer's until Uzayer installs it in video 9.

import {
  northwindCommitFiles,
  northwindHunks,
  northwindTextBefore,
} from "../fixtures/northwind-repo";
import type {
  CommitContent,
  NorthwindContent,
  SessionContent,
  ToolStep,
} from "./northwind-content-types";

// ── Commits on main, oldest first ─────────────────────────────────────────
//
// `c-validate` was made on `server-discounts` and rebased onto `c-qty` before
// it was merged, so its hash moved (`rebasedFrom`) and its checkpoints
// followed. Video 10 searches for its short SHA: 7d3e0a1.

type CommitHead = Omit<CommitContent, "files">;

const COMMIT_HEADS: CommitHead[] = [
  {
    key: "c-init",
    sha: "0f4c2a91d8be6e3375a0c19f2d47b8e5a6c31d02",
    subject: "Initial commit: product list, cart and checkout",
    author: "uzayer",
    when: { daysAgo: 7, at: "17:12" },
    sessions: [],
  },
  {
    key: "c-404",
    sha: "a3b81c7e0d52f94461c2e8a7b09d3f15c64e2a70",
    subject: "Add a 404 page",
    author: "uzayer",
    when: { daysAgo: 6, at: "18:09" },
    sessions: ["s-404"],
  },
  {
    key: "c-check",
    sha: "5e2d07f1b9a46c83d0e7f2a1c5b94d6e8a0f3c17",
    subject: "Add a check script",
    author: "uzayer",
    when: { daysAgo: 6, at: "18:23" },
    sessions: ["s-check"],
  },
  {
    key: "c-sort",
    sha: "c91f4e20a7d35b8e6f01c2d9a4b7e3f58d6c0a19",
    subject: "Add a sort control to the product list",
    author: "uzayer",
    when: { daysAgo: 5, at: "10:12" },
    sessions: ["s-sort"],
  },
  {
    key: "c-stock",
    sha: "2b7a9d4c1e8f053a6d2c7b9e4f1a08d3c5e6b742",
    subject: "Track stock and refuse to oversell",
    author: "zuhayer",
    when: { daysAgo: 5, at: "11:49" },
    sessions: ["s-stock"],
  },
  {
    key: "c-search",
    sha: "8d6e1f3a5b0c42d97e8a1b3c6d0f4e2a9b7c5d31",
    subject: "Filter products as you type",
    author: "uzayer",
    when: { daysAgo: 4, at: "09:46" },
    sessions: ["s-search"],
  },
  {
    key: "c-errors",
    sha: "f4a2c86b1d9e037a5c8b2e6d4f1a7c9e0b3d5f82",
    subject: "Show every checkout error at once",
    author: "zuhayer",
    when: { daysAgo: 4, at: "14:23" },
    sessions: ["s-errors"],
  },
  {
    key: "c-soldout",
    sha: "6c0e8a2f4b1d93e7a5c0f2b8d6e4a1c3f9b7d025",
    subject: "Mark sold-out products",
    author: "zuhayer",
    when: { daysAgo: 3, at: "10:27" },
    sessions: ["s-soldout"],
  },
  {
    key: "c-catalog",
    sha: "1e9b3d7f0a2c84e6b1d5f9a3c7e0b2d4f6a8c913",
    subject: "Load the catalog from data/products.json",
    author: "uzayer",
    when: { daysAgo: 3, at: "13:53" },
    sessions: ["s-catalog"],
  },
  {
    key: "c-order-page",
    sha: "d27f5b9c3e1a06d84f2b7c9e5a3d1f08b6c4e2a7",
    subject: "Add an order details page",
    author: "zuhayer",
    when: { daysAgo: 2, at: "11:12" },
    sessions: ["s-order-page"],
  },
  {
    key: "c-lengths",
    sha: "9a4c6e8b2d0f17a3c5e9b1d7f4a2c8e6b0d3f5a1",
    subject: "Limit checkout field lengths",
    author: "uzayer",
    when: { daysAgo: 2, at: "16:16" },
    sessions: ["s-lengths"],
  },
  {
    key: "c-discount",
    sha: "4e8a0c2f6b9d13e5a7c1f3b5d9e0a2c4f8b6d074",
    subject: "Add a discount code field to checkout",
    author: "uzayer",
    when: { daysAgo: 1, at: "10:42" },
    sessions: ["s-discount"],
  },
  {
    key: "c-qty",
    sha: "b5d1f7a3c9e2048b6d0f2a4c8e1b3d5f7a9c0e26",
    subject: "Cap cart quantities at 10 per product",
    author: "zuhayer",
    when: { daysAgo: 1, at: "15:12" },
    sessions: ["s-qty"],
  },
  {
    key: "c-validate",
    sha: "7d3e0a1b5c9f24e8a6d2b0c4f7e1a3d9b5c8f062",
    subject: "Validate discount codes on the server",
    body: "Codes are checked in src/server/discounts.ts and applied when POST /api/orders\nrecomputes the total. An unknown code is a 422 on the discountCode field.",
    author: "uzayer",
    when: { daysAgo: 1, at: "16:48" },
    sessions: ["s-server-discounts", "s-discount-tests"],
    rebasedFrom: "e01c9f3a7b5d28c4e6a0f2b8d4c1e7a3f5b9d0c6",
  },
  {
    key: "c-normalize",
    sha: "3f6b8d0a2c4e19f7b5d3a1c9e8f0b2d4a6c7e851",
    subject: "Make discount codes case-insensitive",
    author: "uzayer",
    when: { daysAgo: 0, at: "now-154" },
    sessions: ["s-normalize"],
  },
];

const ORDER = COMMIT_HEADS.map((c) => c.key);

/** A commit's files and line counts, straight from the fixture's history. */
const filesOf = (key: string) => northwindCommitFiles(ORDER, key);

// ── Building blocks for Session steps ─────────────────────────────────────

/**
 * The Edit (or Write) calls that produced `commit`'s change to `path`, one per
 * hunk. `ids` names them in order; a hunk past the end gets `<last id>-<n>`.
 * Comments anchor to these ids, so keep them stable.
 */
function edits(
  ids: string | string[],
  min: number,
  commit: string,
  path: string,
  context?: number,
): ToolStep[] {
  const names = Array.isArray(ids) ? ids : [ids];
  return northwindHunks(ORDER, commit, path, context).map((diff, i) => {
    const isNew = diff.before === undefined;
    return {
      kind: "tool",
      id: names[i] ?? `${names[names.length - 1]}-${i + 1}`,
      min,
      tool: isNew ? "write" : "edit",
      title: `${isNew ? "Write" : "Edit"} ${path}`,
      path,
      diff,
    };
  });
}

/** A Read of `path` as it stood just before `commit`: lines `from`..`from + count - 1`. */
function read(id: string, min: number, commit: string, path: string, from = 1, count = 14) {
  const lines = northwindTextBefore(ORDER, commit, path).split("\n");
  const step: ToolStep = {
    kind: "tool",
    id,
    min,
    tool: "read",
    title: `Read ${path}`,
    path,
    result: lines.slice(from - 1, from - 1 + count).join("\n"),
  };
  return step;
}

function bash(id: string, min: number, command: string, result: string, failed = false) {
  const step: ToolStep = {
    kind: "tool",
    id,
    min,
    tool: "bash",
    title: command,
    command,
    result,
    ...(failed ? { status: "failed" as const } : {}),
  };
  return step;
}

/** `bun test` output for `pass` tests across `files` files. */
const bunTest = (pass: number, files: number, ms: number, header = ""): string =>
  `bun test v1.2.21\n${header}\n ${pass} pass\n 0 fail\n ${pass * 2 + 3} expect() calls\nRan ${pass} tests across ${files} file${files === 1 ? "" : "s"}. [${ms}.00ms]`;

// ── The hand-written Session ──────────────────────────────────────────────

/**
 * Video 1 runs this on camera; videos 4 and 10 come back to it. The tool call
 * `e-checkout-ts` is the one Zuhayer comments on ("Should this validate the
 * code server-side?"): the code check lives in the browser, which is exactly
 * the gap, because the server recomputes every total from the catalog.
 *
 * Written out by hand (it matches `c-discount` in the fixture line for line)
 * because the git panel applies these exact diffs on camera.
 */
const DISCOUNT_SESSION: SessionContent = {
  id: "s-discount",
  title: "Add a discount code field to checkout",
  author: "uzayer",
  agent: "claude-code",
  model: "claude-opus-5-5",
  started: { daysAgo: 1, at: "10:32" },
  durationMin: 9,
  branch: "main",
  tokens: { input: 41_200, output: 6_850, cacheRead: 212_400, cacheWrite: 18_900 },
  costUsd: 1.94,
  createdOnCamera: "video1",
  steps: [
    { kind: "prompt", id: "p1", min: 0, text: "add a discount code field to checkout" },
    {
      kind: "thinking",
      id: "th1",
      min: 0,
      text: "Checkout is a plain form posted by src/client/checkout.ts, and the order summary is rendered from totalsHtml in summary.ts. I need the form, the summary, and a small table of valid codes. Look at how the server places the order first so the field goes where the rest of the details go.",
    },
    {
      kind: "tool",
      id: "r-checkout-html",
      min: 1,
      tool: "read",
      title: "Read src/client/checkout.html",
      path: "src/client/checkout.html",
      result:
        '<form id="checkout-form" novalidate>\n  <label>Full name <input name="name" autocomplete="name" required /></label>\n  <label>Email <input name="email" type="email" autocomplete="email" required /></label>\n  <label>Shipping address <textarea name="address" rows="3" …></textarea></label>\n  <p id="form-error" class="error" role="alert" hidden></p>\n  <button type="submit">Place order</button>\n</form>',
    },
    {
      kind: "tool",
      id: "r-checkout-ts",
      min: 1,
      tool: "read",
      title: "Read src/client/checkout.ts",
      path: "src/client/checkout.ts",
      result:
        'const summary = await api.cart();\nshowCartCount(summary);\n…\nform.addEventListener("submit", async (event) => {\n  const details = Object.fromEntries(new FormData(form)) as Record<string, string>;\n  …\n  const order = await api.placeOrder(details);',
    },
    {
      kind: "tool",
      id: "r-summary",
      min: 2,
      tool: "read",
      title: "Read src/client/summary.ts",
      path: "src/client/summary.ts",
      result:
        'export function totalsHtml(summary: CartSummary): string {\n  return `\n    <dl class="totals">\n      <dt>Subtotal</dt><dd>${formatCents(summary.subtotal)}</dd>\n      <dt>Shipping</dt>…',
    },
    {
      kind: "tool",
      id: "g-place-order",
      min: 2,
      tool: "grep",
      title: 'grep "placeOrder"',
      command: "placeOrder",
      result:
        "src/client/api.ts:37:  placeOrder: (details: Record<string, string>) =>\nsrc/client/checkout.ts:35:    const order = await api.placeOrder(details);",
    },
    {
      kind: "tool",
      id: "e-checkout-html",
      min: 3,
      tool: "edit",
      title: "Edit src/client/checkout.html",
      path: "src/client/checkout.html",
      diff: {
        before:
          '          <label>Shipping address <textarea name="address" rows="3" autocomplete="street-address" required></textarea></label>\n          <p id="form-error" class="error" role="alert" hidden></p>',
        after:
          '          <label>Shipping address <textarea name="address" rows="3" autocomplete="street-address" required></textarea></label>\n          <label>Discount code <input name="discountCode" autocomplete="off" spellcheck="false" placeholder="e.g. NORTHWIND10" /></label>\n          <p id="discount-note" class="note" hidden></p>\n          <p id="form-error" class="error" role="alert" hidden></p>',
      },
      result: "Applied 1 edit to src/client/checkout.html.",
    },
    {
      kind: "tool",
      id: "e-checkout-ts",
      min: 4,
      tool: "edit",
      title: "Edit src/client/checkout.ts",
      path: "src/client/checkout.ts",
      diff: {
        before:
          'const form = document.getElementById("checkout-form") as HTMLFormElement;\nconst summaryEl = document.getElementById("summary")!;',
        after:
          'const form = document.getElementById("checkout-form") as HTMLFormElement;\nconst summaryEl = document.getElementById("summary")!;\nconst discountNote = document.getElementById("discount-note")!;\n\n/** Percent off, by code. Codes are matched exactly as typed. */\nconst DISCOUNT_CODES: Record<string, number> = { NORTHWIND10: 10, WELCOME5: 5 };\n\nfunction applyDiscount(code: string, subtotal: number): number {\n  const percent = DISCOUNT_CODES[code.trim()];\n  if (!percent) return 0;\n  return Math.round((subtotal * percent) / 100);\n}\n\nform.discountCode.addEventListener("change", () => {\n  const off = applyDiscount(form.discountCode.value, summary.subtotal);\n  discountNote.hidden = !form.discountCode.value;\n  discountNote.textContent = off\n    ? `Code applied: −${formatCents(off)}`\n    : "That code isn\'t valid.";\n  summaryEl.querySelector(".totals")!.outerHTML = totalsHtml(summary, off);\n});',
      },
      result: "Applied 1 edit to src/client/checkout.ts.",
    },
    {
      kind: "tool",
      id: "e-summary",
      min: 5,
      tool: "edit",
      title: "Edit src/client/summary.ts",
      path: "src/client/summary.ts",
      diff: {
        before:
          'export function totalsHtml(summary: CartSummary): string {\n  return `\n    <dl class="totals">\n      <dt>Subtotal</dt><dd>${formatCents(summary.subtotal)}</dd>',
        after:
          'export function totalsHtml(summary: CartSummary, discount = 0): string {\n  return `\n    <dl class="totals">\n      <dt>Subtotal</dt><dd>${formatCents(summary.subtotal)}</dd>\n      ${discount ? `<dt>Discount</dt><dd>−${formatCents(discount)}</dd>` : ""}',
      },
      result: "Applied 1 edit to src/client/summary.ts.",
    },
    bash(
      "b-test",
      6,
      "bun test",
      bunTest(
        27,
        4,
        148,
        "\ntests/api.test.ts:\n✓ shop API > lists products\n✓ shop API > sold-out products are still listed\n…\n",
      ),
    ),
    bash("b-typecheck", 7, "bun run typecheck", "$ tsc --noEmit"),
    {
      kind: "response",
      id: "resp1",
      min: 8,
      text: "Added a **Discount code** field to checkout.\n\n- `checkout.html`: the field sits under the shipping address, with a note line that says whether the code worked.\n- `checkout.ts`: `NORTHWIND10` takes 10% off and `WELCOME5` takes 5%. The summary updates as soon as you leave the field.\n- `summary.ts`: `totalsHtml` takes an optional discount and shows it as its own line.\n\nTests and typecheck pass. Try it with two Canvas Totes and `NORTHWIND10`: the summary shows a $5.00 discount line.",
    },
    { kind: "checkpoint", id: "cp1", min: 9, commit: "c-discount" },
  ],
};

export const CONTENT: NorthwindContent = {
  // ── Sessions, oldest first ──────────────────────────────────────────────
  sessions: [
    {
      id: "s-404",
      title: "Add a friendly 404 page",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 6, at: "18:05" },
      durationMin: 4,
      branch: "main",
      tokens: { input: 18_200, output: 2_900, cacheRead: 88_000, cacheWrite: 9_100 },
      costUsd: 0.71,
      imported: true,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Add a friendly 404 page for unknown paths outside /api, styled like the other pages, with a link back to the products page.",
        },
        read("r-server", 1, "c-404", "server.ts", 1, 20),
        ...edits("w-404", 2, "c-404", "src/client/404.html"),
        ...edits("e-server", 2, "c-404", "server.ts"),
        ...edits("e-css", 3, "c-404", "src/client/styles.css"),
        {
          kind: "response",
          id: "resp1",
          min: 3,
          text: "Added `src/client/404.html` with the same header and styles as the other pages and a **Back to products** button. `server.ts` now serves it for any path that isn't a page; unknown `/api` paths still get the JSON 404.",
        },
        { kind: "checkpoint", id: "cp1", min: 4, commit: "c-404" },
      ],
    },
    {
      id: "s-check",
      title: "Add a check script",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 6, at: "18:20" },
      durationMin: 3,
      branch: "main",
      tokens: { input: 9_400, output: 1_100, cacheRead: 52_000, cacheWrite: 4_200 },
      costUsd: 0.38,
      imported: true,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Add a `bun run check` script that runs the typecheck and the tests, and mention it in the README.",
        },
        ...edits("e-package", 1, "c-check", "package.json"),
        ...edits("e-readme", 1, "c-check", "README.md"),
        bash("b-check", 2, "bun run check", `$ tsc --noEmit && bun test\n${bunTest(21, 4, 131)}`),
        {
          kind: "response",
          id: "resp1",
          min: 2,
          text: "`bun run check` runs `tsc --noEmit` and then `bun test`, and the README's **Check your work** section says to run it before every commit. It passes: 21 tests.",
        },
        { kind: "checkpoint", id: "cp1", min: 3, commit: "c-check" },
      ],
    },
    {
      id: "s-sort",
      title: "Add a sort control to the product list",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 5, at: "10:05" },
      durationMin: 7,
      branch: "main",
      tokens: { input: 32_800, output: 5_200, cacheRead: 164_000, cacheWrite: 14_300 },
      costUsd: 1.52,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: 'Add a "Sort by" dropdown above the product list with three options: Featured (the current order), Price: low to high, and Price: high to low. Sort on the client; don\'t change the API. Keep the styling consistent with the existing page.',
        },
        read("r-products", 1, "c-sort", "src/client/products.ts", 1, 30),
        read("r-index", 1, "c-sort", "src/client/index.html", 13, 10),
        ...edits("e-html", 2, "c-sort", "src/client/index.html"),
        ...edits(
          ["e-products-type", "e-products-sort", "e-products-render"],
          3,
          "c-sort",
          "src/client/products.ts",
        ),
        ...edits("e-css", 5, "c-sort", "src/client/styles.css"),
        bash("b-typecheck", 6, "bun run typecheck", "$ tsc --noEmit"),
        {
          kind: "response",
          id: "resp1",
          min: 6,
          text: "Added a **Sort by** dropdown in a toolbar above the grid.\n\n- `sortProducts` sorts a copy, so **Featured** is always the catalog's own order.\n- The list re-renders on change; the API is untouched.\n- The toolbar uses the same borders and radius as the rest of the page.",
        },
        { kind: "checkpoint", id: "cp1", min: 7, commit: "c-sort" },
      ],
    },
    {
      id: "s-stock",
      title: "Track stock and refuse to oversell",
      author: "zuhayer",
      agent: "codex",
      model: "gpt-5",
      started: { daysAgo: 5, at: "11:40" },
      durationMin: 9,
      branch: "main",
      tokens: { input: 58_100, output: 9_400, cacheRead: 241_000, cacheWrite: 0 },
      costUsd: 0.92,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: 'Give every product a stock count in src/server/catalog.ts (set the Harbor Hoodie to 2 and the Enamel Pin Set to 0; everything else 25). Include stock in the /api/products response. On the server, refuse to put more of a product in the cart than is in stock, with a clear error message. On the product list, show "Only N left" when stock is 3 or fewer. Add tests for the server check.',
        },
        read("r-cart", 1, "c-stock", "src/server/cart.ts", 12, 22),
        ...edits("e-types", 2, "c-stock", "src/shared/types.ts"),
        ...edits("e-catalog", 2, "c-stock", "src/server/catalog.ts", 4),
        ...edits(["e-cart-doc", "e-cart"], 3, "c-stock", "src/server/cart.ts"),
        ...edits("e-products", 5, "c-stock", "src/client/products.ts"),
        ...edits("e-css", 5, "c-stock", "src/client/styles.css"),
        ...edits("e-cart-tests", 6, "c-stock", "tests/cart.test.ts"),
        ...edits("e-api-test", 8, "c-stock", "tests/api.test.ts"),
        bash("b-test", 8, "bun test", bunTest(23, 4, 139)),
        {
          kind: "response",
          id: "resp1",
          min: 9,
          text: 'Stock is in.\n\n- Every product has a `stock` count, and `/api/products` returns it.\n- `setQuantity` refuses more than is in stock: "Only 2 Harbor Hoodie left in stock", or "Enamel Pin Set is sold out".\n- The product list shows **Only N left** at 3 or fewer.\n- Two new cart tests. One API test put the Enamel Pin Set in the cart; it\'s sold out now, so that test uses the mug instead.',
        },
        { kind: "checkpoint", id: "cp1", min: 9, commit: "c-stock" },
      ],
    },
    {
      id: "s-search",
      title: "Filter products as you type",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 4, at: "09:40" },
      durationMin: 6,
      branch: "main",
      tokens: { input: 29_600, output: 4_400, cacheRead: 150_000, cacheWrite: 11_800 },
      costUsd: 1.31,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: 'Add a search box above the product list that filters products by name and description as you type, case-insensitive, on the client. Show "No products match" when nothing matches. It should work together with the Sort by dropdown.',
        },
        read("r-products", 1, "c-search", "src/client/products.ts", 40, 20),
        ...edits("e-html", 2, "c-search", "src/client/index.html"),
        ...edits(
          ["e-products-els", "e-products-match", "e-products-render", "e-products-listen"],
          3,
          "c-search",
          "src/client/products.ts",
        ),
        ...edits("e-css", 4, "c-search", "src/client/styles.css"),
        bash("b-typecheck", 5, "bun run typecheck", "$ tsc --noEmit"),
        {
          kind: "response",
          id: "resp1",
          min: 5,
          text: "Added a search box to the toolbar. It matches the name and the description, ignores case, and filters the sorted list, so the two work together. When nothing matches you see **No products match.** Try `navy`: only the Harbor Hoodie is left.",
        },
        { kind: "checkpoint", id: "cp1", min: 6, commit: "c-search" },
      ],
    },
    {
      id: "s-errors",
      title: "Show every checkout error at once",
      author: "zuhayer",
      agent: "atlas-agent",
      model: "claude-sonnet-5-5",
      started: { daysAgo: 4, at: "14:15" },
      durationMin: 8,
      branch: "main",
      tokens: { input: 46_300, output: 7_900, cacheRead: 198_000, cacheWrite: 21_400 },
      costUsd: 0.84,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "At checkout the server stops at the first invalid field, so a shopper fixes one error, submits, and finds the next. Change validateDetails in src/server/orders.ts to collect every field error and return them together (keep the 422 status; return { error, fields: { name?, email?, address? } }). Update the checkout page to show each message under its own field and mark every bad field. Update the tests.",
        },
        read("r-orders", 1, "c-errors", "src/server/orders.ts", 4, 26),
        ...edits(
          ["e-orders-type", "e-orders-ctor", "e-orders"],
          2,
          "c-errors",
          "src/server/orders.ts",
        ),
        ...edits("e-api", 3, "c-errors", "src/server/api.ts"),
        ...edits("e-client-api", 4, "c-errors", "src/client/api.ts", 3),
        ...edits(
          ["e-checkout-clear", "e-checkout-submit", "e-checkout"],
          5,
          "c-errors",
          "src/client/checkout.ts",
        ),
        ...edits("e-css", 6, "c-errors", "src/client/styles.css"),
        ...edits("e-orders-test", 6, "c-errors", "tests/orders.test.ts"),
        ...edits("e-api-test", 6, "c-errors", "tests/api.test.ts"),
        bash("b-test", 7, "bun test", bunTest(23, 4, 144)),
        {
          kind: "response",
          id: "resp1",
          min: 7,
          text: "Checkout now reports every bad field at once.\n\n- `validateDetails` collects a message per field and throws one `CheckoutError` with `fields`; the API returns `422 { error, fields }`.\n- The checkout page clears the last attempt, then marks each bad field and puts its message right under it.\n- The tests check the `fields` shape. All 23 pass.",
        },
        { kind: "checkpoint", id: "cp1", min: 8, commit: "c-errors" },
      ],
    },
    {
      id: "s-review",
      title: "Review Zuhayer's checkout errors session",
      author: "uzayer",
      agent: "atlas-agent",
      model: "claude-sonnet-5-5",
      started: { daysAgo: 4, at: "15:30" },
      durationMin: 3,
      branch: "main",
      tokens: { input: 22_400, output: 2_300, cacheRead: 61_000, cacheWrite: 8_800 },
      costUsd: 0.31,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Review Zuhayer's latest session on northwind-shop like a pull request: what changed, anything risky, and anything the tests don't cover. Keep it short.",
        },
        {
          kind: "tool",
          id: "o-session",
          min: 1,
          tool: "org",
          title: "Read session: Show every checkout error at once",
          command: "org_session",
          args: { session: "Show every checkout error at once" },
          result:
            "Show every checkout error at once · Zuhayer Masud · Atlas Agent · 1 hour ago · 8 min\nFiles: src/server/orders.ts, src/server/api.ts, src/client/api.ts, src/client/checkout.ts, src/client/styles.css, tests/orders.test.ts, tests/api.test.ts\nCheckpoint: Show every checkout error at once (f4a2c86)",
        },
        {
          kind: "response",
          id: "resp1",
          min: 2,
          text: "**What changed:** `validateDetails` now collects every field error and the API returns `422 { error, fields }` instead of `{ error, field }`. The checkout page shows each message under its field.\n\n**Risky:** the response shape changed. Anything else reading `field` breaks; in this repo only `src/client/api.ts` did, and it was updated.\n\n**Not covered:** every test sends one bad field. Nothing checks two or three at once, which is the case this change is for.",
        },
      ],
    },
    {
      id: "s-soldout",
      title: "Mark sold-out products",
      author: "zuhayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 3, at: "10:20" },
      durationMin: 7,
      branch: "main",
      tokens: { input: 27_900, output: 4_100, cacheRead: 133_000, cacheWrite: 10_900 },
      costUsd: 1.18,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: 'Products with a stock of 0 should show a "Sold out" badge on the product list, and their Add to cart button should be disabled with the label "Sold out". Don\'t hide them. Add a test that the API still lists sold-out products.\nPut sold-out products at the end of the Featured order.',
        },
        read("r-products", 1, "c-soldout", "src/client/products.ts", 15, 40),
        ...edits(
          ["e-products-sort", "e-products-badge", "e-products-card", "e-products-button"],
          2,
          "c-soldout",
          "src/client/products.ts",
        ),
        ...edits("e-css", 4, "c-soldout", "src/client/styles.css"),
        ...edits("e-test", 5, "c-soldout", "tests/api.test.ts"),
        bash("b-test", 5, "bun test tests/api.test.ts", bunTest(6, 1, 61)),
        {
          kind: "response",
          id: "resp1",
          min: 6,
          text: "Sold-out products stay on the list, faded, with a **Sold out** badge, and their button is disabled and reads **Sold out**. In Featured they sink to the end; the price sorts leave them where they fall. New API test: the Enamel Pin Set is still listed, with stock 0.",
        },
        { kind: "checkpoint", id: "cp1", min: 7, commit: "c-soldout" },
      ],
    },
    {
      id: "s-catalog",
      title: "Load the catalog from data/products.json",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 3, at: "13:45" },
      durationMin: 8,
      branch: "main",
      tokens: { input: 36_700, output: 5_800, cacheRead: 171_000, cacheWrite: 13_600 },
      costUsd: 1.63,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Move the product catalog out of src/server/catalog.ts into data/products.json and load it once at startup. Keep the PRODUCTS export and findProduct working exactly as they do now, and make sure bun test and bun run typecheck still pass.",
        },
        read("r-catalog", 1, "c-catalog", "src/server/catalog.ts", 1, 20),
        ...edits("w-json", 2, "c-catalog", "data/products.json"),
        ...edits("e-catalog", 3, "c-catalog", "src/server/catalog.ts"),
        bash("b-check", 5, "bun run check", `$ tsc --noEmit && bun test\n${bunTest(24, 4, 152)}`),
        {
          kind: "response",
          id: "resp1",
          min: 6,
          text: "The six products now live in `data/products.json`. `catalog.ts` imports the file once at startup and exports it as `PRODUCTS`, so `findProduct` and every caller are unchanged. Typecheck and all 24 tests pass.",
        },
        { kind: "checkpoint", id: "cp1", min: 8, commit: "c-catalog" },
      ],
    },
    {
      id: "s-order-page",
      title: "Add an order details page",
      author: "zuhayer",
      agent: "codex",
      model: "gpt-5",
      started: { daysAgo: 2, at: "11:05" },
      durationMin: 7,
      branch: "main",
      tokens: { input: 44_900, output: 7_200, cacheRead: 188_000, cacheWrite: 0 },
      costUsd: 0.71,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: 'Add an order details page at /orders/:id that shows a placed order\'s number, date, lines and totals, using the existing GET /api/orders/:id endpoint. Link to it from the thank-you message on the checkout page. Show "Order not found" for an unknown id.',
        },
        read("r-server", 1, "c-order-page", "server.ts", 1, 25),
        ...edits("w-order-html", 2, "c-order-page", "src/client/order.html"),
        ...edits("w-order", 3, "c-order-page", "src/client/order.ts"),
        ...edits("e-api", 4, "c-order-page", "src/client/api.ts"),
        ...edits("e-server", 4, "c-order-page", "server.ts"),
        ...edits("e-checkout-link", 5, "c-order-page", "src/client/checkout.ts"),
        bash("b-typecheck", 6, "bun run typecheck", "$ tsc --noEmit"),
        {
          kind: "response",
          id: "resp1",
          min: 6,
          text: "Added `/orders/:id`. It loads the order from `GET /api/orders/:id` and shows the number, when and by whom it was placed, the lines and the totals. An unknown id shows **Order not found**. The thank-you message on checkout now links the order number to it.",
        },
        { kind: "checkpoint", id: "cp1", min: 7, commit: "c-order-page" },
      ],
    },
    {
      id: "s-lengths",
      title: "Limit checkout field lengths",
      author: "uzayer",
      agent: "atlas-agent",
      model: "claude-sonnet-5-5",
      started: { daysAgo: 2, at: "16:10" },
      durationMin: 6,
      branch: "main",
      tokens: { input: 30_100, output: 4_600, cacheRead: 120_000, cacheWrite: 12_200 },
      costUsd: 0.52,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "On the server, cap checkout fields at sensible lengths: name 100 characters, email 254, address 300. Return the same 422 field errors as the other checks, and add tests.",
        },
        read("r-orders", 1, "c-lengths", "src/server/orders.ts", 16, 22),
        ...edits(["e-orders-max", "e-orders"], 2, "c-lengths", "src/server/orders.ts"),
        ...edits("e-tests", 3, "c-lengths", "tests/orders.test.ts"),
        bash("b-test", 4, "bun test tests/orders.test.ts", bunTest(10, 1, 38)),
        {
          kind: "response",
          id: "resp1",
          min: 5,
          text: 'Name, email and address are capped at 100, 254 and 300 characters. An over-long field gets its own message ("Keep this to 100 characters or fewer") in the same `fields` object as the other checks, so the checkout page shows it under the field with no client change. Three new tests; all 10 in `orders.test.ts` pass.',
        },
        { kind: "checkpoint", id: "cp1", min: 6, commit: "c-lengths" },
      ],
    },
    DISCOUNT_SESSION,
    {
      id: "s-total-walk",
      afterVideo1: true,
      title: "Walk me through how an order's total is computed",
      author: "zuhayer",
      agent: "codex",
      model: "gpt-5",
      started: { daysAgo: 1, at: "14:05" },
      durationMin: 4,
      branch: "main",
      tokens: { input: 38_400, output: 3_900, cacheRead: 142_000, cacheWrite: 0 },
      costUsd: 0.49,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Walk me through how an order's total is computed now, from the cart page to the order confirmation. Read the code; don't change anything.",
        },
        read("r-cart", 1, "c-qty", "src/server/cart.ts", 39, 23),
        read("r-checkout", 1, "c-qty", "src/client/checkout.ts", 7, 15),
        read("r-orders", 2, "c-qty", "src/server/orders.ts", 44, 30),
        {
          kind: "response",
          id: "resp1",
          min: 3,
          text: "1. **Cart:** `summarize` in `src/server/cart.ts` prices each line from the catalog, adds them up, and adds shipping from `shippingFor` (free from $50, otherwise $5.99).\n2. **Checkout page:** shows that summary. If you type a discount code, `applyDiscount` in `checkout.ts` works out the discount from a table of codes **in the browser** and adds a Discount line.\n3. **Placing the order:** `OrderBook.place` recomputes the summary from the cart on the server and charges `summary.total`. It never sees the discount code.\n\nSo today the discount is display-only: the shopper sees it, but the order is charged the full total.",
        },
      ],
    },
    {
      id: "s-qty",
      title: "Cap cart quantities at 10 per product",
      author: "zuhayer",
      agent: "codex",
      model: "gpt-5",
      started: { daysAgo: 1, at: "15:05" },
      durationMin: 7,
      branch: "main",
      tokens: { input: 21_700, output: 3_300, cacheRead: 96_000, cacheWrite: 0 },
      costUsd: 0.38,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Cap a cart line at 10 of one product. The server should refuse more with a clear message instead of quietly capping it, and the quantity input on the cart page should only take whole numbers up to 10. Add a test.",
        },
        read("r-cart", 1, "c-qty", "src/server/cart.ts", 17, 22),
        ...edits(["e-cart", "e-cart-set"], 2, "c-qty", "src/server/cart.ts"),
        ...edits("e-client", 3, "c-qty", "src/client/cart.ts"),
        ...edits(["e-test-cap", "e-test-line"], 4, "c-qty", "tests/cart.test.ts"),
        bash("b-test", 5, "bun test tests/cart.test.ts", bunTest(11, 1, 24)),
        {
          kind: "response",
          id: "resp1",
          min: 6,
          text: '`setQuantity` now refuses more than 10 of one product with "You can add at most 10 of one product", instead of silently capping it, and checks stock against the real quantity. The cart page\'s quantity input only steps in whole numbers. The old "quantity is capped" test now expects the error, plus one new test; all 11 pass.',
        },
        { kind: "checkpoint", id: "cp1", min: 7, commit: "c-qty" },
      ],
    },
    {
      id: "s-server-discounts",
      afterVideo1: true,
      title: "Move discount code validation to the server",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 1, at: "16:02" },
      durationMin: 9,
      branch: "server-discounts",
      tokens: { input: 48_600, output: 8_100, cacheRead: 221_000, cacheWrite: 19_700 },
      costUsd: 2.07,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Move discount code validation to the server: create src/server/discounts.ts with the valid codes and a function that checks a code and returns the discount, and make POST /api/orders reject an invalid code and apply a valid one when it recomputes the total. Don't write tests; someone else is doing that.",
        },
        read("r-orders", 1, "c-validate", "src/server/orders.ts", 50, 25),
        ...edits("w-discounts", 2, "c-validate", "src/server/discounts.ts"),
        ...edits(
          ["e-orders-import", "e-orders-type", "e-orders"],
          3,
          "c-validate",
          "src/server/orders.ts",
        ),
        bash(
          "b-typecheck-fail",
          5,
          "bun run typecheck",
          "$ tsc --noEmit\nsrc/server/orders.ts(69,7): error TS2353: Object literal may only specify known properties, and 'discount' does not exist in type 'Order'.\nerror: script \"typecheck\" exited with code 2",
          true,
        ),
        ...edits("e-types", 6, "c-validate", "src/shared/types.ts"),
        bash("b-typecheck", 7, "bun run typecheck", "$ tsc --noEmit"),
        {
          kind: "response",
          id: "resp1",
          min: 8,
          text: "Discount codes are now checked on the server.\n\n- `src/server/discounts.ts` holds the codes (stored uppercase) and `checkDiscount`, which returns the discount in cents or `null` for a code the shop doesn't accept.\n- `OrderBook.place` applies a valid code to the total it recomputes and records it on the order as `discount`. An unknown code is a 422 on the `discountCode` field.\n- `Order` has a `discount` field now; typecheck passes.\n\nNo tests, as asked.",
        },
        { kind: "checkpoint", id: "cp1", min: 9, commit: "c-validate" },
      ],
    },
    {
      id: "s-discount-tests",
      afterVideo1: true,
      title: "Write tests for discount validation",
      author: "zuhayer",
      agent: "codex",
      model: "gpt-5",
      started: { daysAgo: 1, at: "16:38" },
      durationMin: 6,
      branch: "server-discounts",
      tokens: { input: 26_300, output: 5_400, cacheRead: 97_000, cacheWrite: 0 },
      costUsd: 0.44,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Write tests in tests/discounts.test.ts for src/server/discounts.ts and for POST /api/orders with a valid code, an invalid code, and no code.",
        },
        {
          kind: "tool",
          id: "r-discounts",
          min: 1,
          tool: "read",
          title: "Read src/server/discounts.ts",
          path: "src/server/discounts.ts",
          result: northwindHunks(ORDER, "c-validate", "src/server/discounts.ts")[0]?.after ?? "",
        },
        read("r-api-test", 1, "c-validate", "tests/api.test.ts", 1, 22),
        ...edits("w-tests", 3, "c-validate", "tests/discounts.test.ts"),
        bash(
          "b-test",
          4,
          "bun test tests/discounts.test.ts",
          bunTest(
            6,
            1,
            47,
            "\ntests/discounts.test.ts:\n✓ checkDiscount > a known code takes its percent off the subtotal\n✓ checkDiscount > an unknown code is null\n✓ checkDiscount > codes are stored uppercase\n✓ POST /api/orders with a discount code > a valid code comes off the total\n✓ POST /api/orders with a discount code > an unknown code is a 422 on the discountCode field\n✓ POST /api/orders with a discount code > no code, no discount\n",
          ),
        ),
        {
          kind: "response",
          id: "resp1",
          min: 5,
          text: 'Added `tests/discounts.test.ts`: three unit tests for `checkDiscount` and three API tests that check out one Canvas Tote with `NORTHWIND10`, `FREESTUFF` and no code. All 6 pass. Worth knowing: `checkDiscount("northwind10")` is `null`, because codes are matched exactly as stored.',
        },
        { kind: "checkpoint", id: "cp1", min: 6, commit: "c-validate" },
      ],
    },
    {
      id: "s-normalize",
      afterVideo1: true,
      title: "Make discount codes case-insensitive",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 0, at: "now-160" },
      durationMin: 6,
      branch: "main",
      tokens: { input: 24_100, output: 3_700, cacheRead: 119_000, cacheWrite: 9_800 },
      costUsd: 1.07,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Discount codes should be case-insensitive. Normalize them to uppercase at the API boundary, in one place, and add a test.",
        },
        read("r-api", 1, "c-normalize", "src/server/api.ts", 74, 9),
        ...edits("e-api", 2, "c-normalize", "src/server/api.ts"),
        ...edits("e-tests", 3, "c-normalize", "tests/discounts.test.ts"),
        bash("b-test", 4, "bun test", bunTest(35, 5, 171)),
        {
          kind: "response",
          id: "resp1",
          min: 5,
          text: "The orders route trims and uppercases `discountCode` once, before `OrderBook.place` sees it, so `northwind10` and ` Northwind10 ` both work and `checkDiscount` keeps matching exact uppercase codes. New API test for a lowercase code with spaces; all 35 tests pass.",
        },
        { kind: "checkpoint", id: "cp1", min: 6, commit: "c-normalize" },
      ],
    },
    // Video 9's two small prompts. They exist only once their runs play,
    // so the Timeline shows the take's own Claude Code and Codex Sessions.
    {
      id: "s-readme-tests",
      createdOnCamera: "onRun",
      title: "add a README section on running the tests",
      author: "uzayer",
      agent: "claude-code",
      model: "claude-opus-5-5",
      started: { daysAgo: 0, at: "now-1" },
      durationMin: 1,
      branch: "main",
      tokens: { input: 9_400, output: 620, cacheRead: 41_000, cacheWrite: 3_100 },
      costUsd: 0.21,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "add a README section on running the tests",
        },
        {
          kind: "tool",
          id: "r-readme",
          min: 0,
          tool: "read",
          title: "Read README.md",
          path: "README.md",
          result:
            "## Check your work\n\n```bash\nbun test            # unit and API tests\nbun run typecheck   # tsc, no emit\nbun run check       # both of the above, in that order\n```\n\nRun `bun run check` before every commit.",
        },
        {
          kind: "tool",
          id: "e-readme",
          min: 1,
          tool: "edit",
          title: "Edit README.md",
          path: "README.md",
          diff: {
            before: "bun run check       # both of the above, in that order\n```",
            after:
              "bun run check       # both of the above, in that order\nbun test tests/cart.test.ts   # one file\nbun test --watch              # rerun on every save\n```",
          },
        },
        {
          kind: "response",
          id: "resp1",
          min: 1,
          text: "The README already has a **Check your work** section with the test commands, so I added to it rather than starting a second one: how to run a single test file, and how to rerun the tests on every save.",
        },
      ],
    },
    {
      id: "s-checkout-exports",
      createdOnCamera: "onRun",
      title: "what does the checkout module export?",
      author: "uzayer",
      agent: "codex",
      model: "gpt-5",
      started: { daysAgo: 0, at: "now-1" },
      durationMin: 1,
      branch: "main",
      tokens: { input: 7_900, output: 310, cacheRead: 22_000, cacheWrite: 0 },
      costUsd: 0.08,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "what does the checkout module export?",
        },
        {
          kind: "tool",
          id: "r-checkout",
          min: 0,
          tool: "read",
          title: "Read src/client/checkout.ts",
          path: "src/client/checkout.ts",
        },
        {
          kind: "response",
          id: "resp1",
          min: 1,
          text: "Nothing. `src/client/checkout.ts` is a page script: when it loads it renders the order summary, applies discount codes and submits the form. It imports `api`, `ApiError` and `showCartCount` from `api.ts` and `totalsHtml` from `summary.ts`, but nothing imports it.",
        },
      ],
    },
    {
      id: "s-live-tests",
      title: "Add tests for the cart and order helpers",
      author: "zuhayer",
      agent: "codex",
      model: "gpt-5",
      started: { daysAgo: 0, at: "now-4" },
      durationMin: 4,
      branch: "main",
      tokens: { input: 31_200, output: 4_100, cacheRead: 88_000, cacheWrite: 0 },
      costUsd: 0.41,
      steps: [
        {
          kind: "prompt",
          id: "p1",
          min: 0,
          text: "Add tests for every exported function in src/server/cart.ts and src/server/orders.ts that isn't already covered.",
        },
        {
          kind: "thinking",
          id: "th1",
          min: 1,
          text: "List the exports in both files, then check which ones the existing tests already call.",
        },
        {
          kind: "tool",
          id: "g-exports",
          min: 1,
          tool: "grep",
          title: 'grep "^export" src/server/cart.ts src/server/orders.ts',
          command: "^export",
          result:
            'src/server/cart.ts:5:export const MAX_QUANTITY = 10;\nsrc/server/cart.ts:8:export type Cart = Map<string, number>;\nsrc/server/cart.ts:10:export class CartError extends Error {}\nsrc/server/cart.ts:12:export function addItem(cart: Cart, productId: string, quantity = 1): void {\nsrc/server/cart.ts:18:export function setQuantity(cart: Cart, productId: string, quantity: number): void {\nsrc/server/cart.ts:39:export function summarize(cart: Cart): CartSummary {\nsrc/server/cart.ts:65:export class CartStore {\nsrc/server/orders.ts:6:export type FieldErrors = Partial<Record<keyof CheckoutDetails | "discountCode", string>>;\nsrc/server/orders.ts:8:export class CheckoutError extends Error {\nsrc/server/orders.ts:22:export function validateDetails(input: unknown): CheckoutDetails {\nsrc/server/orders.ts:42:export class OrderBook {',
        },
        {
          kind: "tool",
          id: "g-usage",
          min: 2,
          tool: "grep",
          title: 'grep "CartStore|OrderBook" tests',
          command: "CartStore|OrderBook",
          result:
            'tests/orders.test.ts:2:import { CheckoutError, OrderBook, validateDetails } from "../src/server/orders.ts";\ntests/orders.test.ts:41:    const book = new OrderBook();\ntests/orders.test.ts:49:    const book = new OrderBook();\ntests/orders.test.ts:56:    expect(() => new OrderBook().place(new Map(), details)).toThrow("Your cart is empty");',
        },
        {
          kind: "response",
          id: "resp1",
          min: 3,
          text: "Two gaps. `CartStore` has no tests at all, and `OrderBook.get` is only ever called with an id that exists. Everything else is covered. Starting with `CartStore` in `tests/cart.test.ts`.",
        },
      ],
      live: {
        liveSteps: [
          {
            kind: "tool",
            id: "e-cart-import",
            min: 4,
            tool: "edit",
            title: "Edit tests/cart.test.ts",
            path: "tests/cart.test.ts",
            diff: {
              before:
                'import { type Cart, CartError, MAX_QUANTITY, addItem, setQuantity, summarize } from "../src/server/cart.ts";',
              after:
                'import { type Cart, CartError, CartStore, MAX_QUANTITY, addItem, setQuantity, summarize } from "../src/server/cart.ts";',
            },
          },
          {
            kind: "tool",
            id: "e-cart-tests",
            min: 4,
            tool: "edit",
            title: "Edit tests/cart.test.ts",
            path: "tests/cart.test.ts",
            diff: {
              before:
                '  test("an empty cart costs nothing", () => {\n    expect(summarize(new Map())).toMatchObject({ subtotal: 0, shipping: 0, total: 0 });\n  });\n});',
              after:
                '  test("an empty cart costs nothing", () => {\n    expect(summarize(new Map())).toMatchObject({ subtotal: 0, shipping: 0, total: 0 });\n  });\n\n  test("each cart id gets its own cart", () => {\n    const store = new CartStore();\n    store.get("a").set("mug", 1);\n    expect(store.get("a").get("mug")).toBe(1);\n    expect(store.get("b").size).toBe(0);\n  });\n\n  test("a cleared cart starts empty", () => {\n    const store = new CartStore();\n    store.get("a").set("mug", 1);\n    store.clear("a");\n    expect(store.get("a").size).toBe(0);\n  });\n});',
            },
          },
          bash("b-test-cart", 5, "bun test tests/cart.test.ts", bunTest(13, 1, 26)),
          {
            kind: "tool",
            id: "e-orders-tests",
            min: 5,
            tool: "edit",
            title: "Edit tests/orders.test.ts",
            path: "tests/orders.test.ts",
            diff: {
              before:
                '  test("an empty cart cannot be ordered", () => {\n    expect(() => new OrderBook().place(new Map(), details)).toThrow("Your cart is empty");\n  });\n});',
              after:
                '  test("an empty cart cannot be ordered", () => {\n    expect(() => new OrderBook().place(new Map(), details)).toThrow("Your cart is empty");\n  });\n\n  test("an unknown order id finds nothing", () => {\n    expect(new OrderBook().get("NW-9999")).toBeUndefined();\n  });\n});',
            },
          },
          bash("b-test-orders", 6, "bun test tests/orders.test.ts", bunTest(11, 1, 35)),
          bash("b-test", 6, "bun test", bunTest(38, 5, 176)),
          {
            kind: "response",
            id: "resp2",
            min: 7,
            text: "Done. Two `CartStore` tests (each cart id gets its own cart, and a cleared cart starts empty) and one for `OrderBook.get` with an unknown id. Every export in `cart.ts` and `orders.ts` is now covered, and all 38 tests pass.",
          },
        ],
      },
    },
  ],

  commits: COMMIT_HEADS.map((head) => ({ ...head, files: filesOf(head.key) })),

  // ── Comments on Sessions ────────────────────────────────────────────────
  comments: [
    // A resolved thread on the edit to `validateDetails` in Zuhayer's session
    // (videos 3/4 "Show resolved").
    {
      id: "cm-email-1",
      session: "s-errors",
      anchor: { kind: "tool_call", step: "e-orders" },
      author: "uzayer",
      body: "Nice. Should we lower-case the email before we store it?",
      when: { daysAgo: 4, at: "15:02" },
      resolved: { by: "uzayer", when: { daysAgo: 4, at: "15:24" } },
    },
    {
      id: "cm-email-2",
      session: "s-errors",
      anchor: { kind: "tool_call", step: "e-orders" },
      author: "zuhayer",
      body: "Trim, yes. Lower-case, no: the part before the @ can be case-sensitive.",
      when: { daysAgo: 4, at: "15:19" },
      parent: "cm-email-1",
    },
    {
      id: "cm-expired",
      session: "s-normalize",
      anchor: { kind: "tool_call", step: "e-api" },
      author: "zuhayer",
      body: "Did you check what happens with an expired code?",
      when: { daysAgo: 0, at: "now-40" },
    },
  ],

  // ── Team chat ───────────────────────────────────────────────────────────
  chat: [
    {
      id: "m-gen-01",
      channel: "general",
      author: "uzayer",
      body: "Welcome to Northwind. The shop is `northwind-shop`: `bun install`, `bun run dev`, and it's on localhost:3000.",
      when: { daysAgo: 6, at: "17:40" },
    },
    {
      id: "m-gen-02",
      channel: "general",
      author: "zuhayer",
      body: "Running. Two Canvas Totes come to exactly $50.00 and it still charges $5.99 shipping. Isn't $50 meant to ship free?",
      when: { daysAgo: 6, at: "17:52" },
      reactions: [["eyes", ["uzayer"]]],
    },
    {
      id: "m-gen-03",
      channel: "general",
      author: "uzayer",
      body: "It is. I'll look after the 404 page.",
      when: { daysAgo: 6, at: "17:58" },
      replyTo: "m-gen-02",
    },

    // Zuhayer drops the stock Session into #shop as a card, and the
    // conversation that follows.
    {
      id: "m-shop-01",
      channel: "shop",
      author: "zuhayer",
      body: "Stock counts are in. The Hoodie is set to 2 so we can see the low-stock label.",
      when: { daysAgo: 5, at: "11:58" },
      sessionRef: { session: "s-stock", checkpoint: "c-stock" },
      reactions: [["rocket", ["uzayer"]]],
    },
    {
      id: "m-shop-02",
      channel: "shop",
      author: "uzayer",
      body: "Nice. Does the server check stock again at checkout, or only when it goes in the cart?",
      when: { daysAgo: 5, at: "12:06" },
      replyTo: "m-shop-01",
    },
    {
      id: "m-shop-03",
      channel: "shop",
      author: "zuhayer",
      body: "Only at add-to-cart for now. Two people buying the last hoodie at once would both get it. Writing that down for later.",
      when: { daysAgo: 5, at: "12:09" },
      replyTo: "m-shop-02",
    },
    {
      id: "m-shop-04",
      channel: "shop",
      author: "uzayer",
      body: "Fine for now. Sold-out items should probably still show, just grayed out?",
      when: { daysAgo: 5, at: "12:11" },
    },
    {
      id: "m-shop-05",
      channel: "shop",
      author: "zuhayer",
      body: "Agreed. I'll start a draft for it here so we can both write the prompt.",
      when: { daysAgo: 5, at: "12:13" },
      reactions: [["thumbsUp", ["uzayer"]]],
    },
    {
      id: "m-shop-06",
      channel: "shop",
      author: "zuhayer",
      body: "Sent **Sold out products** to Claude Code.",
      when: { daysAgo: 3, at: "10:19" },
      draft: "d-soldout",
      reactions: [["thumbsUp", ["uzayer"]]],
    },
    {
      id: "m-shop-07",
      channel: "shop",
      author: "zuhayer",
      body: "Order details page is up: /orders/:id shows the number, date, lines and totals, and the thank-you message links to it.",
      when: { daysAgo: 2, at: "11:20" },
      sessionRef: { session: "s-order-page", checkpoint: "c-order-page" },
    },
    {
      id: "m-shop-08",
      channel: "shop",
      author: "uzayer",
      body: "Nice. I'll add a discount code field to checkout next.",
      when: { daysAgo: 2, at: "11:34" },
      replyTo: "m-shop-07",
    },
  ],

  // ── Prompt drafts ───────────────────────────────────────────────────────
  drafts: [
    // Written by two people, then sent by Zuhayer to Claude Code (session
    // `s-soldout`). Sent drafts are locked.
    {
      id: "d-soldout",
      channel: "shop",
      title: "Sold out products",
      createdBy: "zuhayer",
      created: { daysAgo: 5, at: "12:15" },
      updated: { daysAgo: 3, at: "10:18" },
      text: 'Products with a stock of 0 should show a "Sold out" badge on the product list, and their Add to cart button should be disabled with the label "Sold out". Don\'t hide them. Add a test that the API still lists sold-out products.\nPut sold-out products at the end of the Featured order.',
      sent: { by: "zuhayer", when: { daysAgo: 3, at: "10:19" }, message: "m-shop-06" },
    },
    {
      id: "d-receipt",
      channel: "shop",
      title: "Order confirmation email",
      createdBy: "uzayer",
      created: { daysAgo: 2, at: "17:05" },
      updated: { daysAgo: 2, at: "17:07" },
      text: "Send the shopper a receipt email when an order is placed. The thank-you message already says we did.\nOpen questions: which email service? What goes in it: the order number, the lines, the totals, a link to /orders/:id?",
    },
  ],

  // ── Scripted agent runs ─────────────────────────────────────────────────
  runs: [
    // Video 1, beat 2. Claude Code adds the field live; the edits are left
    // uncommitted so the git panel can commit them on camera.
    {
      id: "run-discount-field",
      match: ["discount code field"],
      agent: "claude-code",
      // The run IS the `s-discount` Session, so Zuhayer's comment on its
      // checkout.ts edit lands on the same tool call in this chat.
      replay: "s-discount",
      beats: [],
      afterwards: "discountSession",
    },
    // Video 1 beat 4 and video 7 beat 2. "What is @Zuhayer Masud working on?"
    // matches typed or picked from the @ picker. The org tool's result is
    // built from the Timeline (no `result`), so it lists what exists in this
    // take, `?video=1` or not; the answer only names Sessions both have.
    {
      id: "run-what-is-zuhayer",
      agent: "atlas-agent",
      match: ["zuhayer", "working on"],
      beats: [
        {
          kind: "tool",
          tool: "org",
          title: "List sessions by Zuhayer Masud",
          command: "org_sessions",
          args: { author: "Zuhayer Masud" },
          ms: 1_100,
        },
        {
          kind: "text",
          text: "Zuhayer has one session **running right now**: *Add tests for the cart and order helpers* (Codex). It's adding tests for the parts of `cart.ts` and `orders.ts` nothing covers yet.\n\nEarlier this week he capped cart quantities at 10, built the order details page at `/orders/:id`, and marked sold-out products on the product list.",
        },
      ],
    },
    // Video 7 beat 2. "Open the live one (or @Add tests for the cart and
    // order helpers) and tell me what it's stuck on". True whether or not
    // the live cue has streamed a step yet.
    {
      id: "run-open-live",
      agent: "atlas-agent",
      match: ["stuck on"],
      beats: [
        {
          kind: "tool",
          tool: "org",
          title: "Read session: Add tests for the cart and order helpers",
          command: "org_session",
          args: { session: "Add tests for the cart and order helpers" },
          result:
            'Add tests for the cart and order helpers · Zuhayer Masud · Codex · live\nLast: "Two gaps. CartStore has no tests at all, and OrderBook.get is only ever called with an id that exists. Starting with CartStore in tests/cart.test.ts."',
          ms: 1_000,
        },
        {
          kind: "text",
          text: "Nothing is blocking it. Zuhayer's Codex session is a few minutes in and moving:\n\n1. It listed every export in `cart.ts` and `orders.ts` and checked which ones the tests already call.\n2. It found two gaps: `CartStore` has no tests at all, and nothing calls `OrderBook.get` with an id that doesn't exist.\n3. It's writing the `CartStore` tests in `tests/cart.test.ts` now. The `OrderBook.get` test comes after.\n\nNo need to interrupt Zuhayer.",
        },
      ],
    },
    // Video 7 beat 3. Atlas Agent finds the open comment, then asks before
    // replying under your name (`replyToComment`).
    {
      id: "run-answer-comments",
      agent: "atlas-agent",
      match: ["open comments"],
      beats: [
        {
          kind: "tool",
          tool: "org",
          title: "List open comments on: Make discount codes case-insensitive",
          command: "org_comments",
          args: { session: "Make discount codes case-insensitive", unresolved_only: true },
          result:
            "1 open · Zuhayer Masud on Edit src/server/api.ts: “Did you check what happens with an expired code?”",
          ms: 900,
        },
        {
          kind: "tool",
          tool: "read",
          title: "Read src/server/discounts.ts",
          path: "src/server/discounts.ts",
          result: read("x", 0, "c-validate", "src/server/discounts.ts", 1, 25).result,
          ms: 600,
        },
        {
          kind: "text",
          text: "Zuhayer asked on your `src/server/api.ts` edit: *“Did you check what happens with an expired code?”*\n\nCodes can't expire yet. `CODES` in `src/server/discounts.ts` has a percent and a label for each code, and no date, so `checkDiscount` only knows valid or unknown. Here's a reply. I'll post it under your name if you allow it.",
        },
        {
          kind: "approval",
          title: "Reply to Zuhayer Masud's comment",
          args: {
            to: "Zuhayer Masud",
            on: "Make discount codes case-insensitive · Edit src/server/api.ts",
            reply:
              "Codes don't expire yet: checkDiscount only knows valid or unknown. I'll add an expiry date per code and a test for an expired one.",
          },
          effect: "replyToComment",
          allowed: "Replied to Zuhayer's comment on *Make discount codes case-insensitive*.",
          declined: "Okay, I won't reply.",
        },
      ],
    },
    // Video 7 beat 4. "Write a short report on @Make discount codes
    // case-insensitive and post it to @shop".
    {
      id: "run-report-shop",
      agent: "atlas-agent",
      match: ["report", "shop"],
      beats: [
        {
          kind: "tool",
          tool: "org",
          title: "Read session: Make discount codes case-insensitive",
          command: "org_session",
          args: { session: "Make discount codes case-insensitive" },
          result:
            "Make discount codes case-insensitive · Uzayer Masud · Claude Code · today · 6 min\nFiles: src/server/api.ts, tests/discounts.test.ts\nCheckpoint: Make discount codes case-insensitive (3f6b8d0)\nComments: 1, from Zuhayer Masud",
          ms: 900,
        },
        {
          kind: "text",
          text: "Here's a short report for #shop, with the session attached so anyone can open it on the Timeline.",
        },
        {
          kind: "approval",
          title: "Post a message to #shop",
          args: {
            to: "#shop",
            message:
              "Discount codes are now case-insensitive: the orders route uppercases them once, at the API boundary, so `northwind10` works. Zuhayer asked about expired codes. They don't expire yet; that's next, with a test.",
            session: "Make discount codes case-insensitive",
          },
          effect: "postShopReport",
          allowed: "Posted to #shop with the session attached.",
          declined: "Okay, nothing was posted.",
        },
      ],
    },
    // Video 1 beat 5. "Post @Add a discount code field to checkout to @shop
    // and ask @Zuhayer Masud to check the validation".
    {
      id: "run-post-discount",
      agent: "atlas-agent",
      match: ["post", "discount code", "shop"],
      beats: [
        {
          kind: "text",
          text: "Here's the post for #shop. *Add a discount code field to checkout* goes with it as a card, so Zuhayer can open the exact run from the message.",
        },
        {
          kind: "approval",
          title: "Post a message to #shop",
          args: {
            to: "#shop",
            message:
              "Added a discount code field to checkout. Zuhayer, can you check the validation?",
            session: "Add a discount code field to checkout",
          },
          effect: "postDiscountSession",
          allowed:
            "Posted to #shop, asking Zuhayer to check the validation, with *Add a discount code field to checkout* attached.",
          declined: "Okay, nothing was posted.",
        },
      ],
    },
    // Video 4 beat 3. The referenced comment plus "do this": the agent makes
    // the server check the code too, the same change `s-server-discounts`
    // committed (the card Zuhayer posts in beat 5).
    {
      id: "run-fix-from-comment",
      match: ["do this"],
      beats: [
        {
          kind: "thinking",
          text: "Zuhayer is right: the code is only checked in the browser, and OrderBook.place recomputes the total without it. The server needs its own table of codes and has to apply the discount itself.",
        },
        {
          kind: "tool",
          tool: "read",
          title: "Read src/server/orders.ts",
          path: "src/server/orders.ts",
          result: read("x", 0, "c-validate", "src/server/orders.ts", 50, 25).result,
          ms: 500,
        },
        {
          kind: "tool",
          tool: "write",
          title: "Write src/server/discounts.ts",
          path: "src/server/discounts.ts",
          diff: northwindHunks(ORDER, "c-validate", "src/server/discounts.ts")[0],
          ms: 1_200,
        },
        {
          kind: "tool",
          tool: "edit",
          title: "Edit src/server/orders.ts",
          path: "src/server/orders.ts",
          diff: northwindHunks(ORDER, "c-validate", "src/server/orders.ts")[2],
          ms: 1_000,
        },
        {
          kind: "text",
          text: "The server checks the code now. `src/server/discounts.ts` holds the codes, and `OrderBook.place` applies a valid one to the total it recomputes and refuses an unknown one with a 422 on the `discountCode` field. A code typed into the browser can no longer change what the order costs on its own.",
        },
      ],
    },
    // Video 5 beat 4. "Move discount pricing to the server", sent from the
    // draft. The take only needs it to start.
    {
      id: "run-pricing-to-server",
      match: ["discount pricing"],
      beats: [
        {
          kind: "thinking",
          text: "The draft wants pricing on the server only, with the old endpoint kept working until the mobile app ships. Start with where the browser still computes the discount.",
        },
        {
          kind: "tool",
          tool: "grep",
          title: 'grep "DISCOUNT_CODES"',
          command: "DISCOUNT_CODES",
          result:
            "src/client/checkout.ts:10:const DISCOUNT_CODES: Record<string, number> = { NORTHWIND10: 10, WELCOME5: 5 };\nsrc/client/checkout.ts:13:  const percent = DISCOUNT_CODES[code.trim()];",
          ms: 600,
        },
        {
          kind: "tool",
          tool: "read",
          title: "Read src/server/discounts.ts",
          path: "src/server/discounts.ts",
          ms: 500,
        },
        {
          kind: "text",
          text: "Plan:\n\n1. Add `GET /api/discounts/:code`, which prices a code against the shopper's cart with `checkDiscount`.\n2. Have `checkout.ts` ask it for the discount line and delete `DISCOUNT_CODES` from the browser.\n3. Leave `POST /api/orders` accepting `discountCode` exactly as it does today, so the old endpoint keeps working until the mobile app ships.\n4. Tests for a valid code, an invalid code and no code.\n\nStarting with the endpoint.",
        },
      ],
    },
    // Video 9 beat 1. "add a README section on running the tests". The run
    // IS `s-readme-tests`, recorded on the Timeline when it finishes.
    {
      id: "run-readme-tests",
      match: ["readme section"],
      agent: "claude-code",
      replay: "s-readme-tests",
      beats: [],
      afterwards: "recordSession",
    },
    // Video 9 beat 3. "what does the checkout module export?", in Codex.
    {
      id: "run-checkout-exports",
      match: ["checkout module export"],
      agent: "codex",
      replay: "s-checkout-exports",
      beats: [],
      afterwards: "recordSession",
    },
    // Video 11 beat 1. "/remember the discount code rule".
    {
      id: "run-remember",
      match: ["remember", "discount"],
      beats: [
        {
          kind: "tool",
          tool: "memory",
          title: "remember",
          command: "memory_remember",
          args: {
            kind: "decision",
            content:
              "Discount codes are case-insensitive: normalize them to uppercase once, at the API boundary (src/server/api.ts), not in the UI.",
          },
          result: "Stored as a decision.",
          ms: 800,
        },
        {
          kind: "text",
          text: "Remembered: discount codes are case-insensitive, normalized to uppercase once at the API boundary, not in the UI.",
        },
      ],
      afterwards: "rememberDecision",
    },
    // Video 11 beat 3. "Where should discount codes get normalized?" (either
    // spelling).
    {
      id: "run-where-normalize",
      match: ["normali"],
      beats: [
        {
          kind: "tool",
          tool: "memory",
          title: "search memory",
          command: "memory_search",
          args: { query: "discount code normalize" },
          result:
            "decision · Claude Code · 0.92\nDiscount codes are case-insensitive: normalize them to uppercase once, at the API boundary (src/server/api.ts), not in the UI.",
          ms: 900,
        },
        {
          kind: "text",
          text: "At the API boundary: the orders route in `src/server/api.ts` uppercases the code once. That's a recorded decision from a Claude Code session, so the UI shouldn't normalize it again.",
        },
      ],
    },
  ],

  // ── Memory (video 11) ───────────────────────────────────────────────────
  //
  // Memory is per machine and per repo, so everything here came from
  // Uzayer's own Sessions and agents.
  memory: [
    {
      id: "mem-404-route",
      kind: "file",
      text: 'src/client/404.html is served for every path that isn\'t a page by the "/*" route in server.ts; unknown /api paths get a JSON 404 instead.',
      agent: "claude-code",
      session: "s-404",
      confidence: 0.82,
      when: { daysAgo: 6, at: "18:08" },
      files: ["server.ts", "src/client/404.html"],
    },
    {
      id: "mem-catalog-json",
      kind: "file",
      text: "The catalog lives in data/products.json and is loaded once at startup by src/server/catalog.ts, which exports it as PRODUCTS.",
      agent: "claude-code",
      session: "s-catalog",
      confidence: 0.88,
      when: { daysAgo: 3, at: "13:52" },
      files: ["data/products.json", "src/server/catalog.ts"],
    },
    {
      id: "mem-server-totals",
      kind: "architecture",
      text: "The server recomputes every order total from the catalog in OrderBook.place (src/server/orders.ts); nothing the browser sends is trusted for prices.",
      agent: "atlas-agent",
      session: "s-lengths",
      confidence: 0.9,
      when: { daysAgo: 2, at: "16:12" },
      files: ["src/server/orders.ts"],
    },
    {
      id: "mem-field-errors",
      kind: "fact",
      text: "Checkout errors come back as 422 { error, fields } with one message per field. A new check adds to fields instead of throwing early, and the checkout page shows it under the field.",
      agent: "atlas-agent",
      session: "s-lengths",
      confidence: 0.86,
      when: { daysAgo: 2, at: "16:14" },
      files: ["src/server/orders.ts", "src/client/checkout.ts"],
    },
    {
      id: "mem-order-discount-type",
      kind: "failure",
      text: "Typecheck failed when OrderBook.place set discount on the order: Order had no discount field. Fixed by adding it to src/shared/types.ts.",
      agent: "claude-code",
      session: "s-server-discounts",
      confidence: 0.8,
      when: { daysAgo: 1, at: "16:07" },
      files: ["src/shared/types.ts", "src/server/orders.ts"],
    },
    {
      id: "mem-discount-plan",
      kind: "plan",
      text: "Discount codes: the server (src/server/discounts.ts) is the source of truth; the browser's DISCOUNT_CODES table in checkout.ts is only for the summary line and should go.",
      agent: "claude-code",
      session: "s-server-discounts",
      confidence: 0.84,
      when: { daysAgo: 1, at: "16:10" },
      files: ["src/server/discounts.ts", "src/client/checkout.ts"],
    },
  ],
  memoryOnRemember: {
    id: "mem-discount-case",
    kind: "decision",
    text: "Discount codes are case-insensitive: normalize them to uppercase once, at the API boundary (src/server/api.ts), not in the UI.",
    agent: "claude-code",
    session: "s-normalize",
    confidence: 0.92,
    when: { daysAgo: 0, at: "now-0" },
    files: ["src/server/api.ts"],
  },
  policies: [
    {
      policy: "Package manager",
      value: "Always use bun, never npm.",
      source: "CLAUDE.md",
      match: "exact",
    },
    {
      policy: "Branching",
      value: "Never commit directly to main.",
      source: "CLAUDE.md",
      match: "exact",
    },
    {
      policy: "Testing",
      value: "Run the tests before every commit.",
      source: "CLAUDE.md",
      match: "exact",
    },
  ],

  // ── Live cues ───────────────────────────────────────────────────────────
  cues: {
    zuhayerComment: {
      session: "s-discount",
      step: "e-checkout-ts",
      body: "<@usr_uzayer> Should this validate the code server-side?",
    },
    zuhayerMessage: {
      body: "Server-side check is in, tests included.",
      sessionRef: { session: "s-server-discounts", checkpoint: "c-validate" },
    },
    zuhayerShare: {
      body: "<@usr_uzayer> looking at the validation now.",
      sessionRef: { session: "s-discount" },
    },
    zuhayerDraftEdit: {
      draftTitle: "Move discount pricing to the server",
      text: "\nKeep the old endpoint working until the mobile app ships.\nAdd tests for a valid code, an invalid code and no code.",
    },
  },
};
