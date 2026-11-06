// The `northwind` scenario's sample repository, `northwind-shop`, as it stands
// at HEAD — every file's real text, and which commit wrote each line.
//
// It lives in `fixtures/` rather than beside `scenarios/northwind-git.ts`
// because it is CONTENT: `styles.css` carries the shop's own hex colours, and
// this directory is exempt from the design-system ratchet for exactly that.
//
// ## How a file is written down
//
// Each file is its text with the commit history folded in, one marker per line
// at the very end of it:
//
//   - no marker ............ written by the file's `base` commit (`c-init` for
//                            the original files, the creating commit for new ones)
//   - `«c-sort»` ........... written by `c-sort` and unchanged since
//   - `«c-init>c-stock»` ... written by `c-init`, DELETED by `c-stock` — kept so
//                            a commit's diff shows real removed lines
//
// The keys are the `commits` keys in `scenarios/northwind-content.ts`. A file's
// text at any point in the history is the lines whose writer has happened and
// whose deleter has not (`northwindFilesAt`), which is also what makes
// `?video=1` work: without `c-discount`, checkout.ts and friends read as they
// did before the on-camera run, so the run's edits apply to them cleanly.
//
// The bug in `src/shared/pricing.ts` (`>` where it should be `>=`) is planted
// on purpose. Leave it.

/** One file's text and blame: runs of `[commitKey, lineCount]` covering every line. */
export interface NorthwindFile {
  text: string;
  blame: [string, number][];
}

/** One line of a file's folded history. */
export interface NorthwindLine {
  text: string;
  added: string;
  removed: string | null;
}

/** The graph's lane colour for `main`, matching the default fixture's first lane. */
export const NORTHWIND_LANE_COLOR = "#6e9cff";

const MARK = /«([\w-]+)(?:>([\w-]+))?»$/;

interface Source {
  /** The commit that created the file; unmarked lines are its. */
  base: string;
  text: string;
}

function parse(source: Source): NorthwindLine[] {
  return source.text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      const mark = line.match(MARK);
      if (!mark) return { text: line, added: source.base, removed: null };
      return { text: line.slice(0, mark.index), added: mark[1], removed: mark[2] ?? null };
    });
}

/** Every file's line history, keyed by repo-relative path. */
export const NORTHWIND_HISTORY: Record<string, { base: string; lines: NorthwindLine[] }> = {};

/** Collapse per-line commit keys into `[key, count]` runs. */
export function blameRuns(keys: string[]): [string, number][] {
  const runs: [string, number][] = [];
  for (const key of keys) {
    const last = runs[runs.length - 1];
    if (last && last[0] === key) last[1] += 1;
    else runs.push([key, 1]);
  }
  return runs;
}

/**
 * The tree once exactly the commits `has` accepts have happened. A file whose
 * creating commit has not happened is absent.
 */
export function northwindFilesAt(has: (key: string) => boolean): Record<string, NorthwindFile> {
  const out: Record<string, NorthwindFile> = {};
  for (const [path, { base, lines }] of Object.entries(NORTHWIND_HISTORY)) {
    if (!has(base)) continue;
    const visible = lines.filter(
      (line) => has(line.added) && !(line.removed !== null && has(line.removed)),
    );
    out[path] = {
      text: `${visible.map((line) => line.text).join("\n")}\n`,
      blame: blameRuns(visible.map((line) => line.added)),
    };
  }
  return out;
}

/** One contiguous change a commit made to a file: an agent's single Edit (or, without `before`, a Write). */
export interface NorthwindHunk {
  before?: string;
  after: string;
}

const visibleWith = (line: NorthwindLine, has: Set<string>): boolean =>
  has.has(line.added) && !(line.removed !== null && has.has(line.removed));

/**
 * What `commit` did to `path`, as the hunks an agent's Edit calls would show:
 * each changed run of lines with `context` unchanged lines either side. A file
 * the commit created is one hunk with no `before`. `order` is every commit key,
 * oldest first, so "before" means the file as the commits ahead of it left it.
 *
 * Session transcripts take their diffs from here, so the tool call a viewer
 * opens on the Timeline shows the same lines the commit and blame do.
 */
export function northwindHunks(
  order: readonly string[],
  commit: string,
  path: string,
  context = 1,
): NorthwindHunk[] {
  const file = NORTHWIND_HISTORY[path];
  const at = order.indexOf(commit);
  if (!file || at < 0) return [];
  const prior = new Set(order.slice(0, at));
  const upTo = new Set([...prior, commit]);
  const textOf = (lines: NorthwindLine[], has: Set<string>) =>
    lines
      .filter((line) => visibleWith(line, has))
      .map((line) => line.text)
      .join("\n");
  if (file.base === commit) return [{ after: textOf(file.lines, upTo) }];
  if (!prior.has(file.base)) return [];

  const rows = file.lines.filter((line) => visibleWith(line, prior) || visibleWith(line, upTo));
  const changed = rows.map((line) => line.added === commit || line.removed === commit);
  const ranges: [number, number][] = [];
  changed.forEach((isChanged, i) => {
    if (!isChanged) return;
    const start = Math.max(0, i - context);
    const end = Math.min(rows.length, i + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  });
  return ranges.map(([start, end]) => {
    const slice = rows.slice(start, end);
    return { before: textOf(slice, prior), after: textOf(slice, upTo) };
  });
}

/** `path` as it read just before `commit` landed (what an agent working toward it would Read). */
export function northwindTextBefore(
  order: readonly string[],
  commit: string,
  path: string,
): string {
  const file = NORTHWIND_HISTORY[path];
  const prior = new Set(order.slice(0, Math.max(0, order.indexOf(commit))));
  if (!file || !prior.has(file.base)) return "";
  return file.lines
    .filter((line) => visibleWith(line, prior))
    .map((line) => line.text)
    .join("\n");
}

/** A commit's files with their line counts, from the same history git and blame read. */
export function northwindCommitFiles(
  order: readonly string[],
  commit: string,
): { path: string; status: "A" | "M" | "D"; insertions: number; deletions: number }[] {
  const out: { path: string; status: "A" | "M" | "D"; insertions: number; deletions: number }[] =
    [];
  const upTo = new Set(order.slice(0, order.indexOf(commit) + 1));
  for (const [path, { base, lines }] of Object.entries(NORTHWIND_HISTORY)) {
    if (!upTo.has(base)) continue;
    const insertions = lines.filter((l) => l.added === commit && visibleWith(l, upTo)).length;
    const deletions = lines.filter((l) => l.removed === commit).length;
    if (insertions + deletions === 0) continue;
    out.push({ path, status: base === commit ? "A" : "M", insertions, deletions });
  }
  return out;
}

const SOURCES: Record<string, Source> = {
  ".agents/skills/api-routes/SKILL.md": {
    base: "c-init",
    text: `---
name: api-routes
description: How northwind-shop's API routes are laid out, and the rules a new one follows.
---

# api-routes

Every route lives in \`src/server/api.ts\`. Prices are integer cents, and the
server recomputes every total from the catalog: never trust a price the browser
sends. Add a test in \`tests/\` for each new route.
`,
  },
  ".agents/skills/release-notes/SKILL.md": {
    base: "c-init",
    text: `---
name: release-notes
description: Write release notes for northwind-shop from the commits since the last tag.
---

# release-notes

Write the release notes for northwind-shop from the commits since the last tag.

## Steps

1. List the commits since the last tag:

   \`\`\`bash
   git log --no-merges --pretty='%h %s' $(git describe --tags --abbrev=0)..HEAD
   \`\`\`

2. Group them under three headings, in this order:
   - **New**: things a shopper can do that they couldn't before.
   - **Fixed**: things that were broken and now work.
   - **Changed**: things that work differently.
3. Write every line for shoppers, not developers: say what changed in the
   store, not which file moved. "Discount codes work in any case", not
   "normalize codes in api.ts".
4. Skip commits that only touch tests, and refactors that change nothing a
   shopper can see.
5. End with the version and today's date.
`,
  },
  ".gitignore": {
    base: "c-init",
    text: `node_modules/
dist/
.DS_Store
*.log
`,
  },
  "CLAUDE.md": {
    base: "c-init",
    text: `# northwind-shop

- Always use bun, never npm.
- Never commit directly to main.
- Run the tests before every commit.
`,
  },
  "data/products.json": {
    base: "c-catalog",
    text: `[
  {
    "id": "mug",
    "name": "Northwind Mug",
    "description": "12 oz stoneware mug with the compass logo.",
    "price": 1200,
    "emoji": "☕",
    "stock": 25
  },
  {
    "id": "tote",
    "name": "Canvas Tote",
    "description": "Heavy cotton tote with an inside pocket.",
    "price": 2500,
    "emoji": "👜",
    "stock": 25
  },
  {
    "id": "notebook",
    "name": "Field Notebook",
    "description": "A5 dot-grid notebook, 96 pages.",
    "price": 850,
    "emoji": "📓",
    "stock": 25
  },
  {
    "id": "pins",
    "name": "Enamel Pin Set",
    "description": "Three pins: compass, wave and lighthouse.",
    "price": 900,
    "emoji": "📌",
    "stock": 0
  },
  {
    "id": "hoodie",
    "name": "Harbor Hoodie",
    "description": "Midweight fleece hoodie in navy.",
    "price": 4800,
    "emoji": "🧥",
    "stock": 2
  },
  {
    "id": "stickers",
    "name": "Sticker Pack",
    "description": "Eight weatherproof vinyl stickers.",
    "price": 400,
    "emoji": "🏷️",
    "stock": 25
  }
]
`,
  },
  LICENSE: {
    base: "c-init",
    text: `MIT License

Copyright (c) 2026 Northwind

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  },
  "package.json": {
    base: "c-init",
    text: `{
  "name": "northwind-shop",
  "version": "0.1.0",
  "private": true,
  "description": "A tiny web shop: product list, cart and checkout, served by Bun.",
  "license": "MIT",
  "type": "module",
  "scripts": {
    "dev": "bun --hot server.ts",
    "start": "NODE_ENV=production bun server.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit"«c-init>c-check»
    "typecheck": "tsc --noEmit",«c-check»
    "check": "tsc --noEmit && bun test"«c-check»
  },
  "devDependencies": {
    "@types/bun": "^1.2.0",
    "typescript": "^5.6.0"
  }
}
`,
  },
  "README.md": {
    base: "c-init",
    text: `# Northwind Shop

A tiny online shop for Northwind's merch: browse products, add them to a cart, and
check out. It is small on purpose, so the whole thing fits in your head in ten
minutes.

## Run it

You need [Bun](https://bun.sh) 1.2 or newer.

\`\`\`bash
bun install
bun run dev
\`\`\`

Then open http://localhost:3000. Set \`PORT\` to use a different port.

## What's in it

| Page          | What it does                                               |
| ------------- | ---------------------------------------------------------- |
| \`/\`           | Product list with **Add to cart**                          |
| \`/cart\`       | Change quantities, remove items, see the totals            |
| \`/checkout\`   | Name, email and shipping address, then **Place order**     |

Orders of $50 or more ship free; anything smaller pays a flat $5.99.

There is no database. Carts and orders live in the server's memory and are gone
when it restarts. A shopper's cart is found by the \`nw_cart\` cookie.

## Layout

\`\`\`
server.ts            Bun.serve: the pages plus the JSON API
src/server/          catalog, cart, orders and the API routes
src/shared/          money formatting, shipping rules and types used on both sides
src/client/          the three pages, their scripts and styles.css
tests/               bun test suites
\`\`\`

All prices are integer cents. The server recomputes every total from the catalog
when an order is placed, so the browser can't change what a customer pays.

## API

| Method   | Path                          | Body                              |
| -------- | ----------------------------- | --------------------------------- |
| \`GET\`    | \`/api/products\`               |                                   |
| \`GET\`    | \`/api/cart\`                   |                                   |
| \`POST\`   | \`/api/cart/items\`             | \`{ "productId", "quantity"? }\`    |
| \`PATCH\`  | \`/api/cart/items/:productId\`  | \`{ "quantity" }\` (0 removes it)   |
| \`DELETE\` | \`/api/cart/items/:productId\`  |                                   |
| \`POST\`   | \`/api/orders\`                 | \`{ "name", "email", "address" }\`  |
| \`GET\`    | \`/api/orders/:id\`             |                                   |

Cart responses carry \`lines\`, \`itemCount\`, \`subtotal\`, \`shipping\` and \`total\`.
Checkout errors come back as \`422\` with \`{ "error", "field" }\`.

## Check your work

\`\`\`bash
bun test            # unit and API tests
bun run typecheck   # tsc, no emit
bun run check       # both of the above, in that order«c-check»
\`\`\`
«c-check»
Run \`bun run check\` before every commit.«c-check»

## License

MIT. See [LICENSE](LICENSE).
`,
  },
  "server.ts": {
    base: "c-init",
    text: `import notFound from "./src/client/404.html";«c-404»
import cart from "./src/client/cart.html";
import checkout from "./src/client/checkout.html";
import home from "./src/client/index.html";
import order from "./src/client/order.html";«c-order-page»
import { apiRoutes } from "./src/server/api.ts";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  development: process.env.NODE_ENV !== "production",
  routes: {
    "/": home,
    "/cart": cart,
    "/checkout": checkout,
    "/orders/:id": order,«c-order-page»
    ...apiRoutes(),
    "/api/*": Response.json({ error: "Not found" }, { status: 404 }),
    // Every other path is a page we don't have: show the friendly 404.«c-404»
    "/*": notFound,«c-404»
  },
});

console.log(\`Northwind Shop running at \${server.url}\`);
`,
  },
  "src/client/404.html": {
    base: "c-404",
    text: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page not found · Northwind Shop</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">🧭 Northwind Shop</a>
      <a class="cart-link" href="/cart">Cart</a>
    </header>
    <main class="not-found">
      <h1>We couldn't find that page</h1>
      <p>It may have moved, or the link may have a typo in it.</p>
      <a class="button" href="/">Back to products</a>
    </main>
  </body>
</html>
`,
  },
  "src/client/api.ts": {
    base: "c-init",
    text: `import type { CartSummary, Order, Product } from "../shared/types.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly field?: string,«c-init>c-errors»
    readonly fields: Record<string, string> = {},«c-errors»
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json();
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, body.field);«c-init>c-errors»
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, body.fields);«c-errors»
  return body as T;
}

export const api = {
  products: () => request<Product[]>("/api/products"),
  cart: () => request<CartSummary>("/api/cart"),
  addToCart: (productId: string) =>
    request<CartSummary>("/api/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId, quantity: 1 }),
    }),
  setQuantity: (productId: string, quantity: number) =>
    request<CartSummary>(\`/api/cart/items/\${productId}\`, {
      method: "PATCH",
      body: JSON.stringify({ quantity }),
    }),
  remove: (productId: string) =>
    request<CartSummary>(\`/api/cart/items/\${productId}\`, { method: "DELETE" }),
  placeOrder: (details: Record<string, string>) =>
    request<Order>("/api/orders", { method: "POST", body: JSON.stringify(details) }),
  order: (id: string) => request<Order>(\`/api/orders/\${encodeURIComponent(id)}\`),«c-order-page»
};

export function showCartCount(summary: CartSummary): void {
  const badge = document.getElementById("cart-count");
  if (badge) badge.textContent = String(summary.itemCount);
}
`,
  },
  "src/client/cart.html": {
    base: "c-init",
    text: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cart · Northwind Shop</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">🧭 Northwind Shop</a>
      <a class="cart-link" href="/cart">Cart (<span id="cart-count">0</span>)</a>
    </header>
    <p class="banner">Free shipping on orders of $50 or more.</p>
    <main>
      <h1>Your cart</h1>
      <div id="cart"></div>
    </main>
    <script type="module" src="./cart.ts"></script>
  </body>
</html>
`,
  },
  "src/client/cart.ts": {
    base: "c-init",
    text: `import { formatCents } from "../shared/money.ts";
import type { CartSummary } from "../shared/types.ts";
import { api, showCartCount } from "./api.ts";
import { escapeHtml, totalsHtml } from "./summary.ts";

const root = document.getElementById("cart")!;

function render(summary: CartSummary): void {
  showCartCount(summary);
  if (summary.lines.length === 0) {
    root.innerHTML = \`<p>Your cart is empty. <a href="/">Browse products</a></p>\`;
    return;
  }
  root.innerHTML = \`
    <table class="cart-table">
      <thead><tr><th>Item</th><th>Price</th><th>Qty</th><th>Total</th><th></th></tr></thead>
      <tbody>
        \${summary.lines
          .map(
            (line) => \`
          <tr>
            <td>\${escapeHtml(line.name)}</td>
            <td>\${formatCents(line.unitPrice)}</td>
            <td><input type="number" min="0" max="10" value="\${line.quantity}" data-qty="\${line.productId}" aria-label="Quantity of \${escapeHtml(line.name)}" /></td>«c-init>c-qty»
            <td><input type="number" min="0" max="10" step="1" inputmode="numeric" value="\${line.quantity}" data-qty="\${line.productId}" aria-label="Quantity of \${escapeHtml(line.name)}" /></td>«c-qty»
            <td>\${formatCents(line.lineTotal)}</td>
            <td><button class="link" data-remove="\${line.productId}">Remove</button></td>
          </tr>\`,
          )
          .join("")}
      </tbody>
    </table>
    \${totalsHtml(summary)}
    <a class="button" href="/checkout">Go to checkout</a>\`;
}

root.addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.qty) render(await api.setQuantity(input.dataset.qty, Number(input.value)));
});

root.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-remove]");
  if (button) render(await api.remove(button.dataset.remove!));
});

render(await api.cart());
`,
  },
  "src/client/checkout.html": {
    base: "c-init",
    text: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Checkout · Northwind Shop</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">🧭 Northwind Shop</a>
      <a class="cart-link" href="/cart">Cart (<span id="cart-count">0</span>)</a>
    </header>
    <p class="banner">Free shipping on orders of $50 or more.</p>
    <main class="checkout">
      <h1>Checkout</h1>
      <div class="checkout-columns">
        <form id="checkout-form" novalidate>
          <label>Full name <input name="name" autocomplete="name" required /></label>
          <label>Email <input name="email" type="email" autocomplete="email" required /></label>
          <label>Shipping address <textarea name="address" rows="3" autocomplete="street-address" required></textarea></label>
          <label>Discount code <input name="discountCode" autocomplete="off" spellcheck="false" placeholder="e.g. NORTHWIND10" /></label>«c-discount»
          <p id="discount-note" class="note" hidden></p>«c-discount»
          <p id="form-error" class="error" role="alert" hidden></p>
          <button type="submit">Place order</button>
        </form>
        <aside id="summary" class="summary"></aside>
      </div>
      <section id="confirmation" hidden></section>
    </main>
    <script type="module" src="./checkout.ts"></script>
  </body>
</html>
`,
  },
  "src/client/checkout.ts": {
    base: "c-init",
    text: `import { formatCents } from "../shared/money.ts";
import { ApiError, api, showCartCount } from "./api.ts";
import { escapeHtml, totalsHtml } from "./summary.ts";

const form = document.getElementById("checkout-form") as HTMLFormElement;
const summaryEl = document.getElementById("summary")!;
const discountNote = document.getElementById("discount-note")!;«c-discount»
«c-discount»
/** Percent off, by code. Codes are matched exactly as typed. */«c-discount»
const DISCOUNT_CODES: Record<string, number> = { NORTHWIND10: 10, WELCOME5: 5 };«c-discount»
«c-discount»
function applyDiscount(code: string, subtotal: number): number {«c-discount»
  const percent = DISCOUNT_CODES[code.trim()];«c-discount»
  if (!percent) return 0;«c-discount»
  return Math.round((subtotal * percent) / 100);«c-discount»
}«c-discount»
«c-discount»
form.discountCode.addEventListener("change", () => {«c-discount»
  const off = applyDiscount(form.discountCode.value, summary.subtotal);«c-discount»
  discountNote.hidden = !form.discountCode.value;«c-discount»
  discountNote.textContent = off«c-discount»
    ? \`Code applied: −\${formatCents(off)}\`«c-discount»
    : "That code isn't valid.";«c-discount»
  summaryEl.querySelector(".totals")!.outerHTML = totalsHtml(summary, off);«c-discount»
});«c-discount»
const errorEl = document.getElementById("form-error")!;
const confirmation = document.getElementById("confirmation")!;

const summary = await api.cart();
showCartCount(summary);

if (summary.lines.length === 0) {
  form.closest(".checkout-columns")!.innerHTML = \`<p>Your cart is empty. <a href="/">Browse products</a></p>\`;
} else {
  summaryEl.innerHTML = \`
    <h2>Order summary</h2>
    <ul class="summary-lines">
      \${summary.lines
        .map((l) => \`<li><span>\${l.quantity} × \${escapeHtml(l.name)}</span><span>\${formatCents(l.lineTotal)}</span></li>\`)
        .join("")}
    </ul>
    \${totalsHtml(summary)}\`;
}
«c-errors»
/** Clear the last attempt's messages and red borders before trying again. */«c-errors»
function clearErrors(): void {«c-errors»
  errorEl.hidden = true;«c-errors»
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));«c-errors»
  form.querySelectorAll(".field-error").forEach((el) => el.remove());«c-errors»
}«c-errors»

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.hidden = true;«c-init>c-errors»
  form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));«c-init>c-errors»
  clearErrors();«c-errors»

  const details = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const button = form.querySelector("button")!;
  button.disabled = true;
  try {
    const order = await api.placeOrder(details);
    showCartCount({ ...summary, itemCount: 0 });
    form.closest(".checkout-columns")!.remove();
    confirmation.hidden = false;
    confirmation.innerHTML = \`
      <h2>Thanks, \${escapeHtml(order.customer.name)}!</h2>
      <p>Order <strong>\${order.id}</strong> is confirmed. We charged \${formatCents(order.total)}«c-init>c-order-page»
      <p>Order <a href="/orders/\${order.id}"><strong>\${order.id}</strong></a> is confirmed. We charged \${formatCents(order.total)}«c-order-page»
      and sent a receipt to \${escapeHtml(order.customer.email)}.</p>
      <a class="button" href="/">Keep shopping</a>\`;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    if (error.field) form.querySelector(\`[name="\${error.field}"]\`)?.setAttribute("aria-invalid", "true");«c-init>c-errors»
    // Every bad field gets its own message, right under it.«c-errors»
    for (const [field, message] of Object.entries(error.fields)) {«c-errors»
      const input = form.querySelector(\`[name="\${field}"]\`);«c-errors»
      if (!input) continue;«c-errors»
      input.setAttribute("aria-invalid", "true");«c-errors»
      const note = document.createElement("span");«c-errors»
      note.className = "field-error";«c-errors»
      note.textContent = message;«c-errors»
      input.after(note);«c-errors»
    }«c-errors»
    button.disabled = false;
  }
});
`,
  },
  "src/client/index.html": {
    base: "c-init",
    text: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Products · Northwind Shop</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">🧭 Northwind Shop</a>
      <a class="cart-link" href="/cart">Cart (<span id="cart-count">0</span>)</a>
    </header>
    <p class="banner">Free shipping on orders of $50 or more.</p>
    <main>
      <h1>Products</h1>
      <div class="toolbar">«c-sort»
        <input id="search" type="search" placeholder="Search products" aria-label="Search products" />«c-search»
        <label class="sort">«c-sort»
          Sort by«c-sort»
          <select id="sort">«c-sort»
            <option value="featured">Featured</option>«c-sort»
            <option value="price-asc">Price: low to high</option>«c-sort»
            <option value="price-desc">Price: high to low</option>«c-sort»
          </select>«c-sort»
        </label>«c-sort»
      </div>«c-sort»
      <ul id="products" class="product-grid"></ul>
      <p id="no-results" class="muted" hidden>No products match.</p>«c-search»
    </main>
    <script type="module" src="./products.ts"></script>
  </body>
</html>
`,
  },
  "src/client/order.html": {
    base: "c-order-page",
    text: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your order · Northwind Shop</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">🧭 Northwind Shop</a>
      <a class="cart-link" href="/cart">Cart (<span id="cart-count">0</span>)</a>
    </header>
    <p class="banner">Free shipping on orders of $50 or more.</p>
    <main>
      <h1 id="order-title">Your order</h1>
      <p id="order-placed" class="muted"></p>
      <section id="order" class="summary"></section>
      <p><a href="/">Keep shopping</a></p>
    </main>
    <script type="module" src="./order.ts"></script>
  </body>
</html>
`,
  },
  "src/client/order.ts": {
    base: "c-order-page",
    text: `import { formatCents } from "../shared/money.ts";
import type { Order } from "../shared/types.ts";
import { api, showCartCount } from "./api.ts";
import { escapeHtml, totalsHtml } from "./summary.ts";

const title = document.getElementById("order-title")!;
const placed = document.getElementById("order-placed")!;
const root = document.getElementById("order")!;

/** \`/orders/NW-1001\` → \`NW-1001\`. */
const orderId = decodeURIComponent(location.pathname.split("/").pop() ?? "");

function render(order: Order): void {
  title.textContent = \`Order \${order.id}\`;
  placed.textContent = \`Placed \${new Date(order.placedAt).toLocaleString()} by \${order.customer.name}\`;
  root.innerHTML = \`
    <h2>What you ordered</h2>
    <ul class="summary-lines">
      \${order.lines
        .map((l) => \`<li><span>\${l.quantity} × \${escapeHtml(l.name)}</span><span>\${formatCents(l.lineTotal)}</span></li>\`)
        .join("")}
    </ul>
    \${totalsHtml({ ...order, itemCount: order.lines.length })}\`;
}

try {
  render(await api.order(orderId));
} catch {
  // Unknown ids come back as a 404 from GET /api/orders/:id.
  title.textContent = "Order not found";
  placed.textContent = \`We couldn't find an order called \${orderId}.\`;
  root.remove();
}

showCartCount(await api.cart());
`,
  },
  "src/client/products.ts": {
    base: "c-init",
    text: `import { formatCents } from "../shared/money.ts";
import type { Product } from "../shared/types.ts";«c-sort»
import { api, showCartCount } from "./api.ts";
import { escapeHtml } from "./summary.ts";

const list = document.getElementById("products")!;
const sortSelect = document.getElementById("sort") as HTMLSelectElement;«c-sort»
const searchInput = document.getElementById("search") as HTMLInputElement;«c-search»
const noResults = document.getElementById("no-results")!;«c-search»
«c-stock»
/** At or below this many in stock, a product says "Only N left". */«c-stock»
const LOW_STOCK = 3;«c-stock»
«c-sort»
type SortKey = "featured" | "price-asc" | "price-desc";«c-sort»
«c-sort»
/** Featured is the catalog's own order; the price sorts copy it, never reorder it. */«c-sort»
function sortProducts(items: readonly Product[], key: SortKey): Product[] {«c-sort»
  const sorted = [...items];«c-sort»
  if (key === "price-asc") sorted.sort((a, b) => a.price - b.price);«c-sort»
  if (key === "price-desc") sorted.sort((a, b) => b.price - a.price);«c-sort»
  // Sold-out products sink to the end of Featured; the price sorts leave them be.«c-soldout»
  if (key === "featured") sorted.sort((a, b) => Number(a.stock === 0) - Number(b.stock === 0));«c-soldout»
  return sorted;«c-sort»
}«c-sort»
«c-search»
/** Case-insensitive match on the name and the description. */«c-search»
function matches(product: Product, query: string): boolean {«c-search»
  const needle = query.trim().toLowerCase();«c-search»
  if (!needle) return true;«c-search»
  return \`\${product.name} \${product.description}\`.toLowerCase().includes(needle);«c-search»
}«c-search»
«c-stock»
function stockNote(product: Product): string {«c-stock»
  if (product.stock === 0) return \`<span class="badge sold-out">Sold out</span>\`;«c-soldout»
  if (product.stock > LOW_STOCK) return "";«c-stock»
  return \`<span class="stock-low">Only \${product.stock} left</span>\`;«c-stock»
}«c-stock»
«c-sort»
function productHtml(p: Product): string {«c-sort»
  const soldOut = p.stock === 0;«c-soldout»
  return \`«c-sort»
«c-init>c-sort»
const products = await api.products();«c-init>c-sort»
list.innerHTML = products«c-init>c-sort»
  .map(«c-init>c-sort»
    (p) => \`«c-init>c-sort»
    <li class="product">«c-init>c-soldout»
    <li class="product\${soldOut ? " is-sold-out" : ""}">«c-soldout»
      <div class="product-art" aria-hidden="true">\${p.emoji}</div>
      <h2>\${escapeHtml(p.name)}</h2>
      <p>\${escapeHtml(p.description)}</p>
      \${stockNote(p)}«c-stock»
      <div class="product-foot">
        <strong>\${formatCents(p.price)}</strong>
        <button data-add="\${p.id}">Add to cart</button>«c-init>c-soldout»
        <button data-add="\${p.id}"\${soldOut ? " disabled" : ""}>\${soldOut ? "Sold out" : "Add to cart"}</button>«c-soldout»
      </div>
    </li>\`,«c-init>c-sort»
  )«c-init>c-sort»
  .join("");«c-init>c-sort»
    </li>\`;«c-sort»
}«c-sort»
«c-sort»
const products = await api.products();«c-sort»
«c-sort»
function render(): void {«c-sort»
  list.innerHTML = sortProducts(products, sortSelect.value as SortKey).map(productHtml).join("");«c-sort>c-search»
  const visible = sortProducts(products, sortSelect.value as SortKey).filter((p) =>«c-search»
    matches(p, searchInput.value),«c-search»
  );«c-search»
  list.innerHTML = visible.map(productHtml).join("");«c-search»
  noResults.hidden = visible.length > 0;«c-search»
}«c-sort»
«c-sort»
sortSelect.addEventListener("change", render);«c-sort»
searchInput.addEventListener("input", render);«c-search»
render();«c-sort»

list.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-add]");
  if (!button) return;
  button.disabled = true;
  showCartCount(await api.addToCart(button.dataset.add!));
  button.textContent = "Added ✓";
  setTimeout(() => {
    button.textContent = "Add to cart";
    button.disabled = false;
  }, 900);
});

showCartCount(await api.cart());
`,
  },
  "src/client/styles.css": {
    base: "c-init",
    text: `:root {
  --ink: #1d2433;
  --muted: #5b6475;
  --line: #e3e6ec;
  --paper: #ffffff;
  --wash: #f5f7fa;
  --accent: #1f5fbf;
  --accent-ink: #ffffff;
  --danger: #b42318;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--wash);
}

* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.75rem; margin: 0 0 20px; }
a { color: var(--accent); }

.site-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 24px; background: var(--paper); border-bottom: 1px solid var(--line);
}
.brand { font-weight: 700; text-decoration: none; color: var(--ink); font-size: 1.1rem; }
.cart-link { text-decoration: none; font-weight: 600; }
.banner { margin: 0; padding: 8px; text-align: center; background: var(--ink); color: var(--paper); font-size: 0.9rem; }

.product-grid {
  list-style: none; padding: 0; margin: 0;
  display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
}
.product { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; }
.product-art { font-size: 2.5rem; background: var(--wash); border-radius: 8px; text-align: center; padding: 18px 0; }
.product h2 { font-size: 1.05rem; margin: 12px 0 4px; }
.product p { color: var(--muted); margin: 0 0 12px; flex: 1; }
.product-foot { display: flex; justify-content: space-between; align-items: center; }
.stock-low { color: var(--danger); font-weight: 600; font-size: 0.9rem; margin: 0 0 12px; }«c-stock»
.badge { align-self: flex-start; font-size: 0.8rem; font-weight: 600; padding: 2px 10px; border-radius: 999px; margin: 0 0 12px; }«c-soldout»
.sold-out { background: var(--wash); color: var(--muted); border: 1px solid var(--line); }«c-soldout»
.is-sold-out .product-art { opacity: 0.45; }«c-soldout»
.is-sold-out h2, .is-sold-out strong { color: var(--muted); }«c-soldout»
«c-sort»
.toolbar { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin: 0 0 16px; }«c-sort»
.toolbar input[type="search"] { flex: 1; max-width: 360px; }«c-search»
.sort { display: flex; flex-direction: row; align-items: center; gap: 8px; font-weight: 600; }«c-sort»
.sort select { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); }«c-sort»
.muted { color: var(--muted); }«c-search»

button, .button {
  font: inherit; font-weight: 600; cursor: pointer; border: 0; border-radius: 8px;
  padding: 9px 16px; background: var(--accent); color: var(--accent-ink); text-decoration: none; display: inline-block;
}
button:disabled { opacity: 0.6; cursor: default; }
button.link { background: none; color: var(--accent); padding: 0; }

.cart-table { width: 100%; border-collapse: collapse; background: var(--paper); border-radius: 12px; overflow: hidden; }
.cart-table th, .cart-table td { text-align: left; padding: 12px; border-bottom: 1px solid var(--line); }
.cart-table input { width: 64px; font: inherit; padding: 4px; }

.totals { display: grid; grid-template-columns: 1fr auto; gap: 6px 24px; max-width: 320px; margin: 20px 0 20px auto; }
.totals dd { margin: 0; text-align: right; }
.totals .grand { font-weight: 700; font-size: 1.1rem; }
#cart .button { float: right; }

.checkout-columns { display: grid; gap: 24px; grid-template-columns: 1fr 320px; align-items: start; }
@media (max-width: 720px) { .checkout-columns { grid-template-columns: 1fr; } }
form { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 20px; display: grid; gap: 14px; }
label { display: grid; gap: 6px; font-weight: 600; }
input, textarea { font: inherit; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; }
[aria-invalid="true"] { border-color: var(--danger); }
.error { color: var(--danger); margin: 0; }
.field-error { color: var(--danger); font-weight: 400; font-size: 0.9rem; }«c-errors»
.note { color: var(--muted); margin: 0; }«c-errors»
.summary { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
.summary h2 { font-size: 1.05rem; margin: 0 0 12px; }
.summary-lines { list-style: none; padding: 0; margin: 0; }
.summary-lines li { display: flex; justify-content: space-between; padding: 4px 0; }
.summary .totals { margin: 12px 0 0; max-width: none; }
.not-found { text-align: center; padding-top: 64px; }«c-404»
#confirmation { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
`,
  },
  "src/client/summary.ts": {
    base: "c-init",
    text: `import { formatCents } from "../shared/money.ts";
import type { CartSummary } from "../shared/types.ts";

/** The subtotal / shipping / total block shared by the cart and checkout pages. */
export function totalsHtml(summary: CartSummary): string {«c-init>c-discount»
export function totalsHtml(summary: CartSummary, discount = 0): string {«c-discount»
  return \`
    <dl class="totals">
      <dt>Subtotal</dt><dd>\${formatCents(summary.subtotal)}</dd>
      \${discount ? \`<dt>Discount</dt><dd>−\${formatCents(discount)}</dd>\` : ""}«c-discount»
      <dt>Shipping</dt><dd>\${summary.shipping === 0 ? "Free" : formatCents(summary.shipping)}</dd>
      <dt class="grand">Total</dt><dd class="grand">\${formatCents(summary.total)}</dd>
    </dl>\`;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => \`&#\${ch.charCodeAt(0)};\`);
}
`,
  },
  "src/server/api.ts": {
    base: "c-init",
    text: `import { CartError, CartStore, addItem, setQuantity, summarize } from "./cart.ts";
import { PRODUCTS } from "./catalog.ts";
import { CheckoutError, OrderBook } from "./orders.ts";

const CART_COOKIE = "nw_cart";

function cartIdOf(req: Request): string | undefined {
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.match(new RegExp(\`(?:^|;\\\\s*)\${CART_COOKIE}=([\\\\w-]+)\`))?.[1];
}

/** JSON response that also hands a new shopper their cart cookie. */
function reply(body: unknown, cartId: string, isNew: boolean, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (isNew) headers.set("set-cookie", \`\${CART_COOKIE}=\${cartId}; Path=/; HttpOnly; SameSite=Lax\`);
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(error: unknown, cartId: string, isNew: boolean): Response {
  if (error instanceof CheckoutError) {
    return reply({ error: error.message, field: error.field }, cartId, isNew, 422);«c-init>c-errors»
    return reply({ error: error.message, fields: error.fields }, cartId, isNew, 422);«c-errors»
  }
  if (error instanceof CartError) return reply({ error: error.message }, cartId, isNew, 400);
  if (error instanceof SyntaxError) return reply({ error: "Invalid JSON" }, cartId, isNew, 400);
  throw error;
}

/** The shop's JSON API, as Bun.serve routes. State lives in memory. */
export function apiRoutes(carts = new CartStore(), orders = new OrderBook()) {
  /** Run a handler with the shopper's cart, creating one on first visit. */
  const withCart =
    <R extends Request>(handler: (req: R, cartId: string) => Promise<unknown> | unknown) =>
    async (req: R) => {
      const existing = cartIdOf(req);
      const cartId = existing ?? crypto.randomUUID();
      try {
        return reply(await handler(req, cartId), cartId, !existing);
      } catch (error) {
        return failure(error, cartId, !existing);
      }
    };

  return {
    "/api/products": {
      GET: () => Response.json(PRODUCTS),
    },

    "/api/cart": {
      GET: withCart((_req, cartId) => summarize(carts.get(cartId))),
    },

    "/api/cart/items": {
      POST: withCart(async (req, cartId) => {
        const { productId, quantity = 1 } = await req.json();
        const cart = carts.get(cartId);
        addItem(cart, String(productId), Number(quantity));
        return summarize(cart);
      }),
    },

    "/api/cart/items/:productId": {
      PATCH: withCart(async (req: Bun.BunRequest<"/api/cart/items/:productId">, cartId) => {
        const { quantity } = await req.json();
        const cart = carts.get(cartId);
        setQuantity(cart, req.params.productId, Number(quantity));
        return summarize(cart);
      }),
      DELETE: withCart((req: Bun.BunRequest<"/api/cart/items/:productId">, cartId) => {
        const cart = carts.get(cartId);
        setQuantity(cart, req.params.productId, 0);
        return summarize(cart);
      }),
    },

    "/api/orders": {
      POST: withCart(async (req, cartId) => {
        const order = orders.place(carts.get(cartId), await req.json());«c-init>c-normalize»
        const body = await req.json();«c-normalize»
        // Codes are case-insensitive: normalize once, here, at the boundary.«c-normalize»
        if (typeof body.discountCode === "string") body.discountCode = body.discountCode.trim().toUpperCase();«c-normalize»
        const order = orders.place(carts.get(cartId), body);«c-normalize»
        carts.clear(cartId);
        return order;
      }),
    },

    "/api/orders/:id": {
      GET: (req: Bun.BunRequest<"/api/orders/:id">) => {
        const order = orders.get(req.params.id);
        return order ? Response.json(order) : Response.json({ error: "Order not found" }, { status: 404 });
      },
    },
  };
}
`,
  },
  "src/server/cart.ts": {
    base: "c-init",
    text: `import { shippingFor } from "../shared/pricing.ts";
import type { CartSummary } from "../shared/types.ts";
import { findProduct } from "./catalog.ts";

export const MAX_QUANTITY = 10;

/** One shopper's cart: product id -> quantity. */
export type Cart = Map<string, number>;

export class CartError extends Error {}

export function addItem(cart: Cart, productId: string, quantity = 1): void {
  if (!findProduct(productId)) throw new CartError(\`Unknown product: \${productId}\`);
  setQuantity(cart, productId, (cart.get(productId) ?? 0) + quantity);
}

/** Set a line's quantity. Zero removes the line. */«c-init>c-stock»
/** Set a line's quantity. Zero removes the line; more than is in stock is refused. */«c-stock»
export function setQuantity(cart: Cart, productId: string, quantity: number): void {
  if (!findProduct(productId)) throw new CartError(\`Unknown product: \${productId}\`);«c-init>c-stock»
  const product = findProduct(productId);«c-stock»
  if (!product) throw new CartError(\`Unknown product: \${productId}\`);«c-stock»
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new CartError("Quantity must be a whole number of 0 or more");
  }
  if (quantity === 0) {
    cart.delete(productId);
    return;
  }
  if (quantity > MAX_QUANTITY) {«c-qty»
    throw new CartError(\`You can add at most \${MAX_QUANTITY} of one product\`);«c-qty»
  }«c-qty»
  if (Math.min(quantity, MAX_QUANTITY) > product.stock) {«c-stock>c-qty»
  if (quantity > product.stock) {«c-qty»
    throw new CartError(«c-stock»
      product.stock === 0 ? \`\${product.name} is sold out\` : \`Only \${product.stock} \${product.name} left in stock\`,«c-stock»
    );«c-stock»
  }«c-stock»
  cart.set(productId, Math.min(quantity, MAX_QUANTITY));«c-init>c-qty»
  cart.set(productId, quantity);«c-qty»
}

export function summarize(cart: Cart): CartSummary {
  const lines = [...cart].flatMap(([productId, quantity]) => {
    const product = findProduct(productId);
    if (!product) return [];
    return [
      {
        productId,
        name: product.name,
        unitPrice: product.price,
        quantity,
        lineTotal: product.price * quantity,
      },
    ];
  });
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const shipping = shippingFor(subtotal);
  return {
    lines,
    itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotal,
    shipping,
    total: subtotal + shipping,
  };
}

/** In-memory carts, keyed by the cart id in the shopper's cookie. */
export class CartStore {
  #carts = new Map<string, Cart>();

  get(cartId: string): Cart {
    let cart = this.#carts.get(cartId);
    if (!cart) {
      cart = new Map();
      this.#carts.set(cartId, cart);
    }
    return cart;
  }

  clear(cartId: string): void {
    this.#carts.delete(cartId);
  }
}
`,
  },
  "src/server/catalog.ts": {
    base: "c-init",
    text: `import type { Product } from "../shared/types.ts";
import catalog from "../../data/products.json";«c-catalog»

export const PRODUCTS: readonly Product[] = [«c-init>c-catalog»
  {«c-init>c-catalog»
    id: "mug",«c-init>c-catalog»
    name: "Northwind Mug",«c-init>c-catalog»
    description: "12 oz stoneware mug with the compass logo.",«c-init>c-catalog»
    price: 1200,«c-init>c-catalog»
    emoji: "☕",«c-init>c-catalog»
    stock: 25,«c-stock>c-catalog»
  },«c-init>c-catalog»
  {«c-init>c-catalog»
    id: "tote",«c-init>c-catalog»
    name: "Canvas Tote",«c-init>c-catalog»
    description: "Heavy cotton tote with an inside pocket.",«c-init>c-catalog»
    price: 2500,«c-init>c-catalog»
    emoji: "👜",«c-init>c-catalog»
    stock: 25,«c-stock>c-catalog»
  },«c-init>c-catalog»
  {«c-init>c-catalog»
    id: "notebook",«c-init>c-catalog»
    name: "Field Notebook",«c-init>c-catalog»
    description: "A5 dot-grid notebook, 96 pages.",«c-init>c-catalog»
    price: 850,«c-init>c-catalog»
    emoji: "📓",«c-init>c-catalog»
    stock: 25,«c-stock>c-catalog»
  },«c-init>c-catalog»
  {«c-init>c-catalog»
    id: "pins",«c-init>c-catalog»
    name: "Enamel Pin Set",«c-init>c-catalog»
    description: "Three pins: compass, wave and lighthouse.",«c-init>c-catalog»
    price: 900,«c-init>c-catalog»
    emoji: "📌",«c-init>c-catalog»
    stock: 0,«c-stock>c-catalog»
  },«c-init>c-catalog»
  {«c-init>c-catalog»
    id: "hoodie",«c-init>c-catalog»
    name: "Harbor Hoodie",«c-init>c-catalog»
    description: "Midweight fleece hoodie in navy.",«c-init>c-catalog»
    price: 4800,«c-init>c-catalog»
    emoji: "🧥",«c-init>c-catalog»
    stock: 2,«c-stock>c-catalog»
  },«c-init>c-catalog»
  {«c-init>c-catalog»
    id: "stickers",«c-init>c-catalog»
    name: "Sticker Pack",«c-init>c-catalog»
    description: "Eight weatherproof vinyl stickers.",«c-init>c-catalog»
    price: 400,«c-init>c-catalog»
    emoji: "🏷️",«c-init>c-catalog»
    stock: 25,«c-stock>c-catalog»
  },«c-init>c-catalog»
];«c-init>c-catalog»
/** The catalog, read once at startup from data/products.json. */«c-catalog»
export const PRODUCTS: readonly Product[] = catalog;«c-catalog»

export function findProduct(id: string): Product | undefined {
  return PRODUCTS.find((product) => product.id === id);
}
`,
  },
  "src/server/discounts.ts": {
    base: "c-validate",
    text: `import type { Cents } from "../shared/money.ts";

/** What a discount code takes off an order. */
export interface Discount {
  /** Percent off the subtotal, 1 to 100. */
  percent: number;
  /** How the code reads to a shopper once it is applied. */
  label: string;
}

/** Every code the shop accepts, stored uppercase. */
export const CODES: Readonly<Record<string, Discount>> = {
  NORTHWIND10: { percent: 10, label: "10% off your order" },
  WELCOME5: { percent: 5, label: "5% off your first order" },
};

/**
 * The discount, in cents, that \`code\` takes off \`subtotal\`, or \`null\` when the
 * shop doesn't accept the code. Rounded to the nearest cent, and never more
 * than the subtotal itself.
 */
export function checkDiscount(code: string, subtotal: Cents): Cents | null {
  const discount = CODES[code];
  if (!discount) return null;
  return Math.min(subtotal, Math.round((subtotal * discount.percent) / 100));
}
`,
  },
  "src/server/orders.ts": {
    base: "c-init",
    text: `import type { CheckoutDetails, Order } from "../shared/types.ts";
import { type Cart, summarize } from "./cart.ts";
import { checkDiscount } from "./discounts.ts";«c-validate»

/** One message per invalid field, keyed by the form field's name. */«c-errors»
export type FieldErrors = Partial<Record<keyof CheckoutDetails, string>>;«c-errors>c-validate»
export type FieldErrors = Partial<Record<keyof CheckoutDetails | "discountCode", string>>;«c-validate»
«c-errors»
export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly field?: keyof CheckoutDetails,«c-init>c-errors»
    readonly fields: FieldErrors = {},«c-errors»
  ) {
    super(message);
  }
}

const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
«c-lengths»
/** The longest value each field accepts, in characters. */«c-lengths»
const MAX_LENGTH = { name: 100, email: 254, address: 300 } as const;«c-lengths»

export function validateDetails(input: unknown): CheckoutDetails {
  const body = (input ?? {}) as Record<string, unknown>;
  const read = (field: keyof CheckoutDetails) =>
    typeof body[field] === "string" ? (body[field] as string).trim() : "";

  const details = { name: read("name"), email: read("email"), address: read("address") };
  if (!details.name) throw new CheckoutError("Enter your name", "name");«c-init>c-errors»
  if (!EMAIL.test(details.email)) throw new CheckoutError("Enter a valid email address", "email");«c-init>c-errors»
  if (details.address.length < 10) throw new CheckoutError("Enter your full shipping address", "address");«c-init>c-errors»
  const fields: FieldErrors = {};«c-errors»
  if (!details.name) fields.name = "Enter your name";«c-errors»
  if (!EMAIL.test(details.email)) fields.email = "Enter a valid email address";«c-errors»
  if (details.address.length < 10) fields.address = "Enter your full shipping address";«c-errors»
  for (const field of ["name", "email", "address"] as const) {«c-lengths»
    if (details[field].length > MAX_LENGTH[field]) {«c-lengths»
      fields[field] = \`Keep this to \${MAX_LENGTH[field]} characters or fewer\`;«c-lengths»
    }«c-lengths»
  }«c-lengths»
  if (Object.keys(fields).length > 0) throw new CheckoutError("Check the highlighted fields", fields);«c-errors»
  return details;
}

/** Placed orders, kept in memory for the life of the server. */
export class OrderBook {
  #orders = new Map<string, Order>();
  #next = 1001;

  /**
   * Turn a cart into an order. Prices and totals are recomputed here from the
   * catalog, never taken from the browser.
   */
  place(cart: Cart, input: unknown): Order {
    const customer = validateDetails(input);
    const summary = summarize(cart);
    if (summary.lines.length === 0) throw new CheckoutError("Your cart is empty");
«c-validate»
    const code = (input as { discountCode?: unknown } | null)?.discountCode;«c-validate»
    const discount = typeof code === "string" && code ? checkDiscount(code, summary.subtotal) : 0;«c-validate»
    if (discount === null) {«c-validate»
      throw new CheckoutError("That discount code isn't valid", {«c-validate»
        discountCode: "That discount code isn't valid",«c-validate»
      });«c-validate»
    }«c-validate»

    const order: Order = {
      id: \`NW-\${this.#next++}\`,
      placedAt: new Date().toISOString(),
      customer,
      lines: summary.lines,
      subtotal: summary.subtotal,
      discount,«c-validate»
      shipping: summary.shipping,
      total: summary.total,«c-init>c-validate»
      total: summary.total - discount,«c-validate»
    };
    this.#orders.set(order.id, order);
    return order;
  }

  get(id: string): Order | undefined {
    return this.#orders.get(id);
  }
}
`,
  },
  "src/shared/money.ts": {
    base: "c-init",
    text: `/** All prices are integer cents, so totals never pick up floating-point drift. */
export type Cents = number;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCents(cents: Cents): string {
  return usd.format(cents / 100);
}
`,
  },
  "src/shared/pricing.ts": {
    base: "c-init",
    text: `import type { Cents } from "./money.ts";

/** Orders of $50.00 or more ship free. */
export const FREE_SHIPPING_THRESHOLD: Cents = 5000;

/** Flat shipping rate below the threshold. */
export const FLAT_SHIPPING: Cents = 599;

export function shippingFor(subtotal: Cents): Cents {
  if (subtotal === 0) return 0;
  return subtotal > FREE_SHIPPING_THRESHOLD ? 0 : FLAT_SHIPPING;
}
`,
  },
  "src/shared/types.ts": {
    base: "c-init",
    text: `import type { Cents } from "./money.ts";

export interface Product {
  id: string;
  name: string;
  description: string;
  price: Cents;
  emoji: string;
  /** Units left to sell. 0 means sold out. */«c-stock»
  stock: number;«c-stock»
}

export interface CartLine {
  productId: string;
  name: string;
  unitPrice: Cents;
  quantity: number;
  lineTotal: Cents;
}

export interface CartSummary {
  lines: CartLine[];
  itemCount: number;
  subtotal: Cents;
  shipping: Cents;
  total: Cents;
}

export interface CheckoutDetails {
  name: string;
  email: string;
  address: string;
}

export interface Order {
  id: string;
  placedAt: string;
  customer: CheckoutDetails;
  lines: CartLine[];
  subtotal: Cents;
  /** Taken off the subtotal by a discount code; 0 when none was used. */«c-validate»
  discount: Cents;«c-validate»
  shipping: Cents;
  total: Cents;
}
`,
  },
  "tests/api.test.ts": {
    base: "c-init",
    text: `import { afterAll, describe, expect, test } from "bun:test";
import { apiRoutes } from "../src/server/api.ts";

const server = Bun.serve({ port: 0, routes: apiRoutes() });
afterAll(() => server.stop(true));

/** A shopper with their own cookie jar of one. */
function shopper() {
  let cookie = "";
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(new URL(path, server.url), {
      ...init,
      headers: { "content-type": "application/json", cookie },
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return { status: res.status, body: await res.json() };
  };
}

describe("shop API", () => {
  test("lists products", async () => {
    const { status, body } = await shopper()("/api/products");
    expect(status).toBe(200);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("price");
  });
«c-soldout»
  test("sold-out products are still listed", async () => {«c-soldout»
    const { body } = await shopper()("/api/products");«c-soldout»
    const pins = body.find((p: { id: string }) => p.id === "pins");«c-soldout»
    expect(pins).toBeDefined();«c-soldout»
    expect(pins.stock).toBe(0);«c-soldout»
  });«c-soldout»

  test("a cart follows its cookie through to an order", async () => {
    const call = shopper();
    await call("/api/cart/items", { method: "POST", body: JSON.stringify({ productId: "mug" }) });
    await call("/api/cart/items", { method: "POST", body: JSON.stringify({ productId: "notebook", quantity: 2 }) });
    await call("/api/cart/items/notebook", { method: "PATCH", body: JSON.stringify({ quantity: 1 }) });

    const cart = await call("/api/cart");
    expect(cart.body.itemCount).toBe(2);
    expect(cart.body.subtotal).toBe(1200 + 850);

    const order = await call("/api/orders", {
      method: "POST",
      body: JSON.stringify({ name: "Sam", email: "sam@example.com", address: "12 Harbor Lane, Portland" }),
    });
    expect(order.status).toBe(200);
    expect(order.body.id).toMatch(/^NW-\\d+$/);
    expect(order.body.total).toBe(1200 + 850 + 599);

    expect((await call("/api/cart")).body.itemCount).toBe(0);
    expect((await call(\`/api/orders/\${order.body.id}\`)).body.id).toBe(order.body.id);
  });

  test("two shoppers do not share a cart", async () => {
    const a = shopper();
    const b = shopper();
    await a("/api/cart/items", { method: "POST", body: JSON.stringify({ productId: "hoodie" }) });
    expect((await b("/api/cart")).body.itemCount).toBe(0);
  });

  test("checkout errors name the field", async () => {
    const call = shopper();
    await call("/api/cart/items", { method: "POST", body: JSON.stringify({ productId: "pins" }) });«c-init>c-stock»
    await call("/api/cart/items", { method: "POST", body: JSON.stringify({ productId: "mug" }) });«c-stock»
    const { status, body } = await call("/api/orders", {
      method: "POST",
      body: JSON.stringify({ name: "Sam", email: "nope", address: "12 Harbor Lane, Portland" }),
    });
    expect(status).toBe(422);
    expect(body.field).toBe("email");«c-init>c-errors»
    expect(body.fields).toEqual({ email: "Enter a valid email address" });«c-errors»
  });

  test("unknown products are a 400", async () => {
    const { status } = await shopper()("/api/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId: "spaceship" }),
    });
    expect(status).toBe(400);
  });
});
`,
  },
  "tests/cart.test.ts": {
    base: "c-init",
    text: `import { describe, expect, test } from "bun:test";
import { type Cart, CartError, MAX_QUANTITY, addItem, setQuantity, summarize } from "../src/server/cart.ts";

describe("cart", () => {
  test("adding the same product twice increases its quantity", () => {
    const cart: Cart = new Map();
    addItem(cart, "mug");
    addItem(cart, "mug", 2);
    expect(cart.get("mug")).toBe(3);
  });

  test("unknown products are rejected", () => {
    expect(() => addItem(new Map(), "spaceship")).toThrow(CartError);
  });

  test("quantity zero removes the line", () => {
    const cart: Cart = new Map([["mug", 2]]);
    setQuantity(cart, "mug", 0);
    expect(cart.size).toBe(0);
  });

  test("negative and fractional quantities are rejected", () => {
    const cart: Cart = new Map();
    expect(() => setQuantity(cart, "mug", -1)).toThrow(CartError);
    expect(() => setQuantity(cart, "mug", 1.5)).toThrow(CartError);
  });

  test("quantity is capped", () => {«c-init>c-qty»
  test("more than the cap is refused", () => {«c-qty»
    const cart: Cart = new Map();
    setQuantity(cart, "mug", 99);«c-init>c-qty»
    expect(() => setQuantity(cart, "mug", MAX_QUANTITY + 1)).toThrow(CartError);«c-qty»
    setQuantity(cart, "mug", MAX_QUANTITY);«c-qty»
    expect(cart.get("mug")).toBe(MAX_QUANTITY);
  });
«c-stock»
  test("you cannot put more in the cart than is in stock", () => {«c-stock»
    const cart: Cart = new Map();«c-stock»
    setQuantity(cart, "hoodie", 2);«c-stock»
    expect(() => setQuantity(cart, "hoodie", 3)).toThrow("Only 2 Harbor Hoodie left in stock");«c-stock»
    expect(cart.get("hoodie")).toBe(2);«c-stock»
  });«c-stock»
«c-stock»
  test("sold-out products cannot be added", () => {«c-stock»
    expect(() => addItem(new Map(), "pins")).toThrow("Enamel Pin Set is sold out");«c-stock»
  });«c-stock»
«c-qty»
  test("a line holds at most ten of one product", () => {«c-qty»
    const cart: Cart = new Map([["mug", 9]]);«c-qty»
    expect(() => addItem(cart, "mug", 2)).toThrow("You can add at most 10 of one product");«c-qty»
    expect(cart.get("mug")).toBe(9);«c-qty»
  });«c-qty»

  test("summary totals a small order with flat shipping", () => {
    const summary = summarize(new Map([["mug", 1], ["stickers", 2]]));
    expect(summary.subtotal).toBe(1200 + 800);
    expect(summary.shipping).toBe(599);
    expect(summary.total).toBe(2599);
    expect(summary.itemCount).toBe(3);
  });

  test("large orders ship free", () => {
    const summary = summarize(new Map([["hoodie", 1], ["mug", 1]]));
    expect(summary.subtotal).toBe(6000);
    expect(summary.shipping).toBe(0);
  });

  test("an empty cart costs nothing", () => {
    expect(summarize(new Map())).toMatchObject({ subtotal: 0, shipping: 0, total: 0 });
  });
});
`,
  },
  "tests/discounts.test.ts": {
    base: "c-validate",
    text: `import { afterAll, describe, expect, test } from "bun:test";
import { apiRoutes } from "../src/server/api.ts";
import { CODES, checkDiscount } from "../src/server/discounts.ts";

describe("checkDiscount", () => {
  test("a known code takes its percent off the subtotal", () => {
    expect(checkDiscount("NORTHWIND10", 5000)).toBe(500);
    expect(checkDiscount("WELCOME5", 2500)).toBe(125);
  });

  test("an unknown code is null", () => {
    expect(checkDiscount("FREESTUFF", 5000)).toBeNull();
  });

  test("codes are stored uppercase", () => {
    for (const code of Object.keys(CODES)) expect(code).toBe(code.toUpperCase());
  });
});

const server = Bun.serve({ port: 0, routes: apiRoutes() });
afterAll(() => server.stop(true));

/** Put one Canvas Tote in a fresh cart and check out with \`discountCode\`. */
async function checkout(discountCode?: string) {
  const add = await fetch(new URL("/api/cart/items", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: "tote" }),
  });
  const cookie = add.headers.get("set-cookie")!.split(";")[0]!;
  const res = await fetch(new URL("/api/orders", server.url), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Sam", email: "sam@example.com", address: "12 Harbor Lane, Portland", discountCode }),
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/orders with a discount code", () => {
  test("a valid code comes off the total", async () => {
    const { status, body } = await checkout("NORTHWIND10");
    expect(status).toBe(200);
    expect(body.discount).toBe(250);
    expect(body.total).toBe(2500 - 250 + 599);
  });

  test("an unknown code is a 422 on the discountCode field", async () => {
    const { status, body } = await checkout("FREESTUFF");
    expect(status).toBe(422);
    expect(body.fields.discountCode).toBe("That discount code isn't valid");
  });

  test("no code, no discount", async () => {
    const { body } = await checkout();
    expect(body.discount).toBe(0);
  });
«c-normalize»
  test("codes are case-insensitive", async () => {«c-normalize»
    const { status, body } = await checkout("  northwind10 ");«c-normalize»
    expect(status).toBe(200);«c-normalize»
    expect(body.discount).toBe(250);«c-normalize»
  });«c-normalize»
});
`,
  },
  "tests/money.test.ts": {
    base: "c-init",
    text: `import { expect, test } from "bun:test";
import { formatCents } from "../src/shared/money.ts";

test("formats cents as US dollars", () => {
  expect(formatCents(0)).toBe("$0.00");
  expect(formatCents(599)).toBe("$5.99");
  expect(formatCents(123456)).toBe("$1,234.56");
});
`,
  },
  "tests/orders.test.ts": {
    base: "c-init",
    text: `import { describe, expect, test } from "bun:test";
import { CheckoutError, OrderBook, validateDetails } from "../src/server/orders.ts";

const details = { name: "Sam", email: "sam@example.com", address: "12 Harbor Lane, Portland, ME 04101" };

describe("checkout details", () => {
  test("valid details are trimmed and accepted", () => {
    expect(validateDetails({ ...details, name: "  Sam " }).name).toBe("Sam");
  });

  test.each([
    ["name", { ...details, name: "" }],
    ["email", { ...details, email: "not-an-email" }],
    ["address", { ...details, address: "Maine" }],
  ])("a bad %s is reported against that field", (field, input) => {
    try {
      validateDetails(input);
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CheckoutError);
      expect((error as CheckoutError).field).toBe(field as never);«c-init>c-errors»
      expect(Object.keys((error as CheckoutError).fields)).toEqual([field]);«c-errors»
    }
  });
«c-lengths»
  test.each([«c-lengths»
    ["name", "x".repeat(101)],«c-lengths»
    ["email", \`\${"x".repeat(250)}@example.com\`],«c-lengths»
    ["address", "1".repeat(301)],«c-lengths»
  ])("an over-long %s is refused", (field, value) => {«c-lengths»
    try {«c-lengths»
      validateDetails({ ...details, [field]: value });«c-lengths»
      throw new Error("expected validation to fail");«c-lengths»
    } catch (error) {«c-lengths»
      expect((error as CheckoutError).fields).toHaveProperty(field);«c-lengths»
    }«c-lengths»
  });«c-lengths»
});

describe("placing an order", () => {
  test("prices come from the catalog, not the request", () => {
    const book = new OrderBook();
    const order = book.place(new Map([["tote", 1]]), { ...details, total: 1 });
    expect(order.subtotal).toBe(2500);
    expect(order.total).toBe(2500 + 599);
    expect(book.get(order.id)).toEqual(order);
  });

  test("order ids are sequential", () => {
    const book = new OrderBook();
    const first = book.place(new Map([["mug", 1]]), details);
    const second = book.place(new Map([["mug", 1]]), details);
    expect([first.id, second.id]).toEqual(["NW-1001", "NW-1002"]);
  });

  test("an empty cart cannot be ordered", () => {
    expect(() => new OrderBook().place(new Map(), details)).toThrow("Your cart is empty");
  });
});
`,
  },
  "tsconfig.json": {
    base: "c-init",
    text: `{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["server.ts", "src", "tests"]
}
`,
  },
};

for (const [path, source] of Object.entries(SOURCES)) {
  NORTHWIND_HISTORY[path] = { base: source.base, lines: parse(source) };
}

/** HEAD with every seeded commit applied — the tree `?video=1` does not start from. */
export const NORTHWIND_FILES: Record<string, NorthwindFile> = northwindFilesAt(() => true);
