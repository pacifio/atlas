/**
 * What the top-level error boundary shows when the interface crashes: the
 * Atlas mark, a prompt-style heading, what survived and what didn't, the
 * error with its top frames, and three keyed actions (↵ reload, C copy the
 * error, R open an issue).
 *
 * Preview it under `bun run dev` with `?crash` — `CrashPreviewTrigger` throws
 * during render so the real boundary shows.
 */
import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { AtlasIcon } from "@/components/atlas-icon";
import { GITHUB_URL } from "@/lib/atlas-links";
import { isBrowserMock } from "@/lib/env";
import { Button, Kbd } from "@tryatlas/design";

const ISSUES_URL = `${GITHUB_URL}/issues/new`;

interface CrashScreenProps {
  error: unknown;
  onReload: () => void;
}

function headline(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error ?? "Unknown error");
}

function frames(error: unknown, n = 5): string[] {
  if (!(error instanceof Error) || !error.stack) return [];
  // Chromium leads with a "Name: message" header; WebKit (the shipped app) does not.
  return error.stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") || /@\S+:\d+:\d+$/.test(l))
    .slice(0, n);
}

/** A frame as shown on screen: no origin, no cache-busting query. The copy keeps the full frame. */
function shortFrame(frame: string): string {
  return frame.replace(/(?:https?|tauri|asset):\/\/[^/\s]+/g, "").replace(/\?[^:\s)]*/g, "");
}

function details(error: unknown): string {
  return [headline(error), ...frames(error).map((f) => `  ${f}`)].join("\n");
}

const openIssue = () => void openUrl(ISSUES_URL).catch(() => {});

function useCrashActions(error: unknown, onReload: () => void) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(details(error))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      // A focused button already answers Enter with its own click.
      if (k === "enter" && !(e.target instanceof HTMLButtonElement)) onReload();
      else if (k === "c") copy();
      else if (k === "r") openIssue();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return { copied, copy };
}

export function CrashScreen({ error, onReload }: CrashScreenProps) {
  const { copied, copy } = useCrashActions(error, onReload);
  return (
    <div
      role="alert"
      className="fixed inset-0 flex items-center justify-center bg-background text-foreground select-none"
    >
      <div className="flex w-full max-w-lg flex-col gap-4 px-6">
        <AtlasIcon size={40} className="rounded-lg" />
        <h1 className="font-mono text-2xl font-medium">&gt; Atlas stopped.</h1>
        <p className="text-md text-muted-foreground">
          The interface crashed or couldn&apos;t load. Reloading usually fixes it.
        </p>
        <div className="flex flex-col gap-1 font-mono text-sm">
          <p className="text-success">
            <span aria-hidden>✓ </span>sessions safe on disk
          </p>
          <p className="text-error">
            <span aria-hidden>✕ </span>interface crashed
          </p>
        </div>
        <pre className="max-h-44 overflow-auto rounded-md border border-border-subtle bg-card p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground select-text">
          <span className="text-error">{headline(error)}</span>
          {frames(error).map((f) => `\n  ${shortFrame(f)}`)}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={onReload}>
            Reload Atlas
            <Kbd variant="inverse">↵</Kbd>
          </Button>
          <Button size="lg" variant="outline" onClick={copy}>
            {copied ? "Copied" : "Copy error"}
            <Kbd>C</Kbd>
          </Button>
          <Button size="lg" variant="ghost" onClick={openIssue}>
            Report issue
            <Kbd>R</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Dev-only: `?crash` under `bun run dev` throws during render so the real boundary shows. */
export function CrashPreviewTrigger(): null {
  if (isBrowserMock && new URLSearchParams(location.search).has("crash")) {
    throw new Error("Cannot read properties of undefined (reading 'turns') — design preview");
  }
  return null;
}
