// Feedback panel state.
//
// Not persisted, deliberately: a draft is session state, and a base64 screenshot
// has no business in localStorage. What it does guarantee is that closing the
// panel — by Esc, by the X, or by opening it again from Settings — never costs
// the user a half-written bug report. Only a successful send clears the draft.

import { create } from "zustand";
import { toast } from "sonner";
import { createSelectors } from "@/lib/create-selectors";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  feedback,
  downscaleForUpload,
  type CaptureResult,
  type FeedbackCategory,
} from "../lib/feedback-api";

type Source = "status-bar" | "settings";

/** How long the thank-you card stays up before the form returns. */
const SENT_DISMISS_MS = 3500;
/** Matches `message-input.tsx` — long enough for the panel to actually repaint
 *  as hidden before `screencapture` grabs the screen. */
const CAPTURE_HIDE_MS = 250;

let sentTimer: ReturnType<typeof setTimeout> | null = null;

interface FeedbackState {
  open: boolean;
  /** Panel hidden (not unmounted) while the capture crosshair is up, so it
   *  never appears in the user's own screenshot. */
  capturing: boolean;
  category: FeedbackCategory;
  message: string;
  shot: CaptureResult | null;
  /** User's explicit choice. Forced on (and not offered) while signed out. */
  anonymous: boolean;
  submitting: boolean;
  sent: boolean;
  error: string | null;
  source: Source;
  actions: {
    openPanel: (source: Source) => void;
    closePanel: () => void;
    toggle: (source: Source) => void;
    setCategory: (c: FeedbackCategory) => void;
    setMessage: (m: string) => void;
    setAnonymous: (v: boolean) => void;
    attachScreenshot: () => Promise<void>;
    removeScreenshot: () => void;
    submit: () => Promise<void>;
    /** "Send another" — drop the thank-you immediately. */
    dismissSent: () => void;
  };
}

const useFeedbackStoreBase = create<FeedbackState>()((set, get) => ({
  open: false,
  capturing: false,
  category: "issue",
  message: "",
  shot: null,
  anonymous: false,
  submitting: false,
  sent: false,
  error: null,
  source: "status-bar",

  actions: {
    openPanel: (source) => set({ open: true, source, error: null, sent: false }),
    // Draft survives on purpose — see the module note.
    closePanel: () => set({ open: false }),
    toggle: (source) => (get().open ? get().actions.closePanel() : get().actions.openPanel(source)),

    setCategory: (category) => set({ category }),
    setMessage: (message) => set({ message }),
    setAnonymous: (anonymous) => set({ anonymous }),

    attachScreenshot: async () => {
      set({ capturing: true, error: null });
      try {
        await new Promise((r) => setTimeout(r, CAPTURE_HIDE_MS));
        const shot = await feedback.capture();
        // `null` is the user pressing Esc. A deliberate cancel is not an error
        // and must not raise a toast.
        if (shot) set({ shot });
      } catch (e) {
        toast.error(`Screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        set({ capturing: false });
      }
    },

    removeScreenshot: () => set({ shot: null }),

    submit: async () => {
      const s = get();
      if (s.submitting || !s.message.trim()) return;
      set({ submitting: true, error: null });

      let screenshotBase64: string | null = null;
      let screenshotMimeType: string | null = null;
      if (s.shot) {
        try {
          const small = await downscaleForUpload(s.shot);
          screenshotBase64 = small.base64;
          screenshotMimeType = small.mimeType;
        } catch {
          // A screenshot we couldn't re-encode is not worth failing the report
          // over — send the words, drop the picture.
          screenshotBase64 = null;
        }
      }

      // Read the active tab lazily and non-reactively: a *type* ("chat"), never
      // a title or a path.
      const layout = useLayoutStore.getState();
      const activeTab = layout.tabs.find((t) => t.id === layout.activeTabId)?.type ?? null;

      try {
        const receipt = await feedback.submit({
          category: s.category,
          message: s.message.trim(),
          anonymous: s.anonymous,
          screenshotBase64,
          screenshotMimeType,
          source: s.source,
          activeTab,
        });
        if (receipt.screenshotDropped) {
          toast.message("Sent — the screenshot was too large to include.");
        }
        // Reset the draft AND show the thank-you, so repeat submissions work.
        set({ submitting: false, sent: true, message: "", shot: null });
        if (sentTimer) clearTimeout(sentTimer);
        sentTimer = setTimeout(() => set({ sent: false }), SENT_DISMISS_MS);
      } catch (e) {
        // Keep the message and the screenshot — losing a report to a failed
        // send is the one outcome worse than not having the feature.
        set({
          submitting: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },

    dismissSent: () => {
      if (sentTimer) clearTimeout(sentTimer);
      sentTimer = null;
      set({ sent: false });
    },
  },
}));

export const useFeedbackStore = createSelectors(useFeedbackStoreBase);
