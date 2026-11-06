// @vitest-environment happy-dom
//
// A cloned repository's README is not trusted code: its raw HTML keeps
// GitHub's layout tags but loses anything that could reach past the document
// (a <meta> refresh navigating the window, a <style> restyling the app, a
// script, an iframe, an inline style pinning an overlay).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => {}),
  revealItemInDir: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { ReadmeView } from "./readme-view";

afterEach(() => {
  cleanup();
  vi.mocked(openUrl).mockClear();
});

describe("ReadmeView links and images", () => {
  it("opens web and mail links in the system browser, and nothing else", () => {
    render(
      <ReadmeView
        source={[
          "[site](https://acme.dev) [mail](mailto:hi@acme.dev)",
          "[docs](docs/setup.md) [up](#install)",
        ].join("\n\n")}
      />,
    );
    fireEvent.click(screen.getByText("site"));
    fireEvent.click(screen.getByText("mail"));
    expect(vi.mocked(openUrl).mock.calls).toEqual([["https://acme.dev"], ["mailto:hi@acme.dev"]]);

    fireEvent.click(screen.getByText("docs"));
    fireEvent.click(screen.getByText("up"));
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(screen.getByText("docs").getAttribute("title")).toBe("docs/setup.md");
    expect(screen.getByText("up").getAttribute("title")).toBe("#install");
  });

  it("shows an image as its alt text, never an <img>", () => {
    const { container } = render(
      <ReadmeView
        source={[
          "![Build status](https://ci.example/badge.svg)",
          '<img src="assets/logo.png">',
        ].join("\n\n")}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Build status")).toBeTruthy();
    expect(screen.getByText("logo.png")).toBeTruthy();
  });
});

describe("ReadmeView raw HTML", () => {
  it("keeps layout HTML and drops what could reach the app", () => {
    const source = [
      '<h1 align="center">Acme</h1>',
      "<details><summary>More</summary>inside</details>",
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      "<style>body { display: none }</style>",
      "<script>window.pwned = true</script>",
      '<iframe srcdoc="<b>x</b>"></iframe>',
      '<div style="position:fixed;inset:0">overlay</div>',
    ].join("\n\n");
    const { container } = render(<ReadmeView source={source} />);
    expect(container.querySelector("h1")?.textContent).toBe("Acme");
    expect(container.querySelector("details summary")?.textContent).toBe("More");
    for (const tag of ["meta", "style", "script", "iframe"]) {
      expect(container.querySelector(tag), tag).toBeNull();
    }
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.textContent).toContain("overlay");
  });
});
