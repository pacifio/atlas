// @vitest-environment happy-dom
//
// Web links in rendered session markdown: the service icon each one wears,
// the short label a bare one reads as, the full address it keeps in its
// tooltip and its copy, and what is left alone.

import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown-render";

const ROOT = "/Users/dev/acme-app";

interface LinkView {
  href: string;
  service?: string;
  text: string;
  title?: string;
  copy?: string;
  mono?: boolean;
}

function links(html: string): LinkView[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return [...doc.querySelectorAll<HTMLAnchorElement>("a")].map((a) => ({
    href: a.getAttribute("href") ?? "",
    ...(a.querySelector<HTMLElement>(".atlas-link__icon")
      ? { service: a.querySelector<HTMLElement>(".atlas-link__icon")!.dataset.linkService }
      : {}),
    text: a.textContent ?? "",
    ...(a.title ? { title: a.title } : {}),
    ...(a.dataset.linkCopy ? { copy: a.dataset.linkCopy } : {}),
    ...(a.classList.contains("atlas-link--mono") ? { mono: true } : {}),
  }));
}

describe("web links in session markdown", () => {
  it("shortens a bare pull request and Linear issue, keeping the address", () => {
    const pr = "https://github.com/acme/web/pull/415";
    const issue = "https://linear.app/atlas/issue/ATL-978/browser-goes-agent-driven";
    expect(links(parseMarkdown(`Moved into ${issue} and ${pr}.`))).toEqual([
      { href: issue, service: "linear", text: "ATL-978", title: issue, copy: issue },
      { href: pr, service: "github", text: "PR #415", title: pr, copy: pr },
    ]);
  });

  it("shortens issues, commits and repositories on GitHub", () => {
    const sha = "3f9c2d1e8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d";
    const html = parseMarkdown(
      `<https://github.com/acme/web/issues/17> https://github.com/acme/web/commit/${sha} [https://github.com/acme/web](https://github.com/acme/web)`,
    );
    expect(links(html).map(({ text, mono }) => ({ text, mono }))).toEqual([
      { text: "#17", mono: undefined },
      { text: "3f9c2d1", mono: true },
      { text: "acme/web", mono: undefined },
    ]);
  });

  it("never dresses a look-alike host as the service it imitates", () => {
    const spoof = "https://github.evil-login.io/acme/web/pull/42";
    const nested = "https://github.com.evil.io/acme/web/pull/42";
    const issue = "https://linear.app.evil.com/atlas/issue/ATL-978";
    expect(links(parseMarkdown(`${spoof} ${nested} ${issue}`))).toEqual([
      {
        href: spoof,
        service: "web",
        text: "github.evil-login.io · acme/web PR #42",
        title: spoof,
        copy: spoof,
      },
      {
        href: nested,
        service: "web",
        text: "github.com.evil.io · acme/web PR #42",
        title: nested,
        copy: nested,
      },
      { href: issue, service: "web", text: issue, title: issue },
    ]);
  });

  it("keeps a link's own words, with the icon and tooltip", () => {
    const href = "https://github.com/acme/web/pull/42#discussion_r1";
    expect(links(parseMarkdown(`See [the review thread](${href}).`))).toEqual([
      { href, service: "github", text: "the review thread", title: href },
    ]);
  });

  it("gives other services their icon and any other site the globe", () => {
    const html = parseMarkdown(
      [
        "https://gitlab.com/a/b/-/merge_requests/7",
        "https://bitbucket.org/a/b/pull-requests/3",
        "https://codeberg.org/a/b/pulls/5",
        "https://acme.slack.com/archives/C1/p1",
        "https://www.notion.so/acme/Plan-0123",
        "https://www.figma.com/design/AbC/x",
        "https://vercel.com/acme/web",
        "https://www.npmjs.com/package/react",
        "https://example.com/docs",
      ].join(" "),
    );
    expect(links(html).map((l) => [l.service, l.text])).toEqual([
      ["gitlab", "PR #7"],
      ["bitbucket", "PR #3"],
      ["forgejo", "PR #5"],
      ["slack", "https://acme.slack.com/archives/C1/p1"],
      ["notion", "https://www.notion.so/acme/Plan-0123"],
      ["figma", "https://www.figma.com/design/AbC/x"],
      ["vercel", "https://vercel.com/acme/web"],
      ["npm", "https://www.npmjs.com/package/react"],
      ["web", "https://example.com/docs"],
    ]);
  });

  it("keeps the protocol on the icon's line so a wrap cannot strand it", () => {
    const html = parseMarkdown("https://example.com/docs");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector(".atlas-link__lead")?.textContent).toBe("https://");
    expect(doc.querySelector(".atlas-link__icon")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("leaves code, fences, bare keys and non-web links alone", () => {
    const html = parseMarkdown(
      [
        "`https://github.com/a/b/pull/1` and ATL-978 and [mail](mailto:a@b.c) and [top](#top)",
        "",
        "```sh",
        "gh pr view https://github.com/a/b/pull/1",
        "```",
      ].join("\n"),
    );
    expect(html).not.toContain("atlas-link__icon");
    expect(html).toContain("<code>https://github.com/a/b/pull/1</code>");
    expect(links(html).map((l) => l.href)).toEqual(["mailto:a@b.c", "#top"]);
  });

  it("does not put an icon on an image link", () => {
    const html = parseMarkdown("[![shot](https://example.com/a.png)](https://example.com/a)");
    expect(html).not.toContain("atlas-link__icon");
  });

  it("leaves a project path to the file chips", () => {
    const html = parseMarkdown("[the readme](README.md)", ROOT);
    expect(html).not.toContain("atlas-link__icon");
    expect(html).toContain("atlas-file-chip");
  });

  it("survives sanitising: no unknown class, and a script URL stays dead", () => {
    const html = parseMarkdown("[x](javascript:alert(1)) https://github.com/a/b/pull/2");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('class="atlas-link"');
    expect(html).toContain('data-link-service="github"');
  });

  it("keeps a footnote back-reference's own class", () => {
    const html = parseMarkdown("Text[^1]\n\n[^1]: Note.");
    expect(html).toContain("data-footnote-backref");
  });
});
