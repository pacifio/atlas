// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AudioPlayer } from "./audio-player";

afterEach(() => {
  cleanup();
});

describe("AudioPlayer", () => {
  it("offers Download only when the caller can save the file", () => {
    const { rerender } = render(<AudioPlayer src={null} filename="note.webm" />);
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    const onDownload = vi.fn();
    rerender(<AudioPlayer src={null} filename="note.webm" onDownload={onDownload} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("holds the download arc in a disabled Play control while buffering", () => {
    const { container } = render(
      <AudioPlayer
        src={null}
        filename="note.webm"
        buffering
        bufferProgress={{ got: 40, total: 100 }}
      />,
    );
    const play = screen.getByRole("button", { name: "Play" });
    expect(play.hasAttribute("disabled") || play.getAttribute("aria-disabled") === "true").toBe(
      true,
    );
    expect(play.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-audio-player]")).not.toBeNull();
  });

  it("asks for the file when Play is pressed before it is local", () => {
    const onRequestSrc = vi.fn();
    render(<AudioPlayer src={null} filename="note.webm" onRequestSrc={onRequestSrc} />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onRequestSrc).toHaveBeenCalledOnce();
  });
});
