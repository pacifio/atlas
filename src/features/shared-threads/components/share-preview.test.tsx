// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { ShareFile } from "../lib/shared-threads-api";

// The badge's styling library is not what is under test; its text is.
vi.mock("@/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const { SharePreviewList, formatBytes, uploads } = await import("./share-preview");

afterEach(cleanup);

const FILES: ShareFile[] = [
  { path: ".env.local", kind: "text", bytes: 31, deleted: false, blocked: "name" },
  { path: "logo.png", kind: "binary", bytes: 2048, deleted: false, blocked: null },
  { path: "old.ts", kind: "text", bytes: 0, deleted: true, blocked: null },
  { path: "src/banner.css", kind: "text", bytes: 30, deleted: false, blocked: null },
];

describe("the share dialog's file list (ATL-402)", () => {
  it("lists every file, says the repository is not uploaded, and blocks secrets", () => {
    render(<SharePreviewList files={FILES} include={[]} onToggle={() => {}} />);
    const list = screen.getByRole("list", { name: "Files to share" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByText(/3 changed files will be uploaded/)).toBeTruthy();
    expect(screen.getByText("Your repository is not uploaded")).toBeTruthy();
    expect(screen.getByText(/kept on this machine/)).toBeTruthy();
    expect(screen.getByText("Binary")).toBeTruthy();
    expect(screen.getByText("Deleted")).toBeTruthy();
    // Only the blocked file offers an override.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("includes a blocked file only when the person ticks it", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SharePreviewList files={FILES} include={[]} onToggle={onToggle} />,
    );
    const box = screen.getByRole("checkbox", { name: "Include anyway" });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith(".env.local", true);

    rerender(<SharePreviewList files={FILES} include={[".env.local"]} onToggle={onToggle} />);
    expect(screen.getByText(/4 changed files will be uploaded/)).toBeTruthy();
  });

  it("counts uploads and sizes the way the dialog shows them", () => {
    expect(uploads(FILES, []).map((f) => f.path)).toEqual(["logo.png", "old.ts", "src/banner.css"]);
    expect(uploads(FILES, [".env.local"])).toHaveLength(4);
    expect(formatBytes(31)).toBe("31 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
