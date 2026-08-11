# Atlas landing site

Static landing page for [tryatlas.cc](https://www.tryatlas.cc/). Pure
HTML + CSS + a tiny inline script, no build step, no framework, no Node
dependency. The whole folder is what Vercel uploads.

## Contents

```
landing/
├── index.html            # the page
├── atlas.css             # design-system tokens + atlas-* primitives
├── antarys-logo.png      # footer + favicon
├── og-image.png          # Open Graph / Twitter card image
├── vercel.json           # caching headers + security headers
└── README.md             # this file
```

Total deploy: ~1.3 MB. The Atlas product mock is rendered inline via CSS
(see `.pw-*` / `.pm-*` classes in `index.html`) rather than embedded as
screenshots, so we don't ship a screenshots directory.

## Local preview

Any static file server works. Two zero-dep options:

```bash
# Python
cd landing && python3 -m http.server 4173

# Node
cd landing && npx --yes serve -p 4173
```

Open `http://localhost:4173`.

## Deploy to Vercel

**One-time setup** (skip if `vercel` CLI is already linked):

```bash
npm i -g vercel        # or: brew install vercel-cli
vercel login
```

**Deploy:**

```bash
cd landing
vercel --prod          # production deploy to whatever domain is wired up
# or
vercel                 # preview deploy (random URL, no domain change)
```

The first run prompts to link the directory to a Vercel project. Pick or
create one named `atlas-landing`; subsequent runs reuse `.vercel/`.

The dashboard alternative: drag the `landing/` folder onto
`vercel.com/new` — same result, no CLI needed.

## What `vercel.json` does

- **`cleanUrls: true`** — `/foo` serves `/foo.html`; we only have
  `index.html` today but this is the standard config.
- **`trailingSlash: false`** — canonical URLs without trailing slashes.
- **Cache headers**:
  - Images get `max-age=31536000, immutable` (1 year). Safe because the
    screenshot filenames are content-stamped (e.g. `code-d591eee0.png`).
  - `atlas.css` gets `max-age=86400, must-revalidate` (1 day) — we
    update it more frequently than images.
- **Security headers** on every response:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`

## Updating links / copy

Three external links live in `index.html`. Search by tag to find them:

| Target            | Where                  | Current value |
|-------------------|------------------------|---------------|
| Discord           | nav pill, mid-page CTA | `https://discord.gg/GmnFggaPfP` |
| GitHub (repo)     | nav, hero, CTA, footer | `https://github.com/pacifio/atlas` |
| X / Twitter       | footer                 | `https://x.com/antarys_ai` |
| LinkedIn          | footer                 | `https://www.linkedin.com/company/107506241/` |
| ACP docs          | "Read the ACP docs" button | `https://github.com/zed-industries/agent-client-protocol` |
| Download for Mac  | nav, hero, CTA-section | `https://github.com/pacifio/atlas/releases/download/alpha-0.2.6/Atlas_0.2.6_aarch64.dmg` |

The download URL is hard-coded to the alpha-0.2.6 GitHub Release asset.
When you cut a new release, update the version label + URL in three
places: the nav "Download" button, the hero "Download for Mac" button,
and the bottom CTA "Download for Mac" button. Easiest:

```bash
# replace the URL across all three (current → next)
sed -i '' 's|alpha-0.2.6/Atlas_0.2.6_aarch64.dmg|alpha-0.2.7/Atlas_0.2.7_aarch64.dmg|g' landing/index.html
# then update the version label in the hero-meta + cta-tiny lines
sed -i '' 's|v0.2.6|v0.2.7|g' landing/index.html
```

## Image sizes (heads up)

The page itself renders the Atlas mock inline via CSS (no screenshot
embedding), so the only image we ship is `uploads/home.png` (~1 MB) —
used as the Open Graph / Twitter preview when the URL is shared. Total
deploy footprint is ~1.3 MB. No optimization needed for launch.

If the OG image ever feels heavy you can replace it with a webp:

```bash
brew install webp
cwebp -q 82 landing/uploads/home.png -o landing/uploads/home.webp
# Then update the og:image / twitter:image meta tags in index.html.
```

## Design source

This file was generated from a Claude Design (claude.ai/design) handoff
bundle. The original HTML/CSS export is preserved in `index.html` +
`atlas.css` — link/copy edits happened in place.
