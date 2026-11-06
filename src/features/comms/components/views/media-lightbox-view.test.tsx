// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/features/media/components/image-zoom-view", () => ({
  ImageZoomView: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

import { MediaLightboxView, type LightboxViewItem } from "./media-lightbox-view";

const items: LightboxViewItem[] = [
  { id: "a", filename: "a.png", kind: "image" },
  { id: "b", filename: "b.png", kind: "image" },
  { id: "c", filename: "c.png", kind: "image" },
  { id: "d", filename: "d.png", kind: "image" },
];

function show(over: Partial<Parameters<typeof MediaLightboxView>[0]> = {}) {
  const onIndexChange = vi.fn();
  const onClose = vi.fn();
  render(
    <MediaLightboxView
      open
      items={items}
      index={1}
      src="blob:b"
      failed={false}
      onIndexChange={onIndexChange}
      onClose={onClose}
      {...over}
    />,
  );
  return { onIndexChange, onClose, dialog: screen.getByRole("dialog") };
}

afterEach(() => {
  cleanup();
});

describe("MediaLightboxView", () => {
  it("walks the gallery from the keyboard", () => {
    const { onIndexChange, dialog } = show();
    for (const key of ["ArrowRight", " ", "End", "ArrowLeft", "Home"]) {
      fireEvent.keyDown(dialog, { key });
    }
    expect(onIndexChange.mock.calls.map((c) => c[0])).toEqual([2, 2, 3, 0, 0]);
  });

  it("shows the position and a Save link to the current file", () => {
    show();
    expect(screen.getByText("2 / 4")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save a copy" });
    expect(save.getAttribute("href")).toBe("blob:b");
    expect(save.getAttribute("download")).toBe("b.png");
  });

  it("offers no Save while the file resolves, and says so when it fails", () => {
    show({ src: null, failed: true });
    expect(screen.queryByRole("button", { name: "Save a copy" })).toBeNull();
    expect(screen.getByText("Could not load this file.")).toBeTruthy();
  });

  it("closes from its Close button", () => {
    const { onClose } = show();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
