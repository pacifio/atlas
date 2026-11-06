import type { Scenario } from "../types";

/**
 * The design-system gallery (decision 21) — `localhost:1420/?scenario=design-system`.
 *
 * It mounts as a SECOND React root over a hidden app root rather than replacing
 * `main.tsx`'s render. Two reasons: nothing dev-only has to reach into
 * production code to do it, and the app underneath stays mounted, so the theme
 * it hydrated (and the theme store the gallery's picker drives) is the real one
 * rather than a copy set up here.
 *
 * The gallery is imported lazily so that every other scenario — and every
 * production build, which never loads this file at all — pays nothing for it.
 */
export const designSystem: Scenario = {
  name: "design-system",
  description:
    "The active theme's colour roles and desktop's own utilities; primitives are in Storybook.",
  setup: async () => {
    const [{ createRoot }, { DesignSystemGallery }] = await Promise.all([
      import("react-dom/client"),
      import("@/dev/design-system/gallery"),
    ]);

    const appRoot = document.getElementById("root");
    if (appRoot) appRoot.style.display = "none";

    // `body` is `height: 100%; overflow: hidden` (globals.css) because the app
    // manages its own scrolling. The gallery host has to fill it and scroll
    // itself, or the page ends at the fold.
    const host = document.createElement("div");
    host.id = "atlas-design-system";
    host.style.height = "100%";
    document.body.append(host);
    createRoot(host).render(<DesignSystemGallery />);
  },
};
