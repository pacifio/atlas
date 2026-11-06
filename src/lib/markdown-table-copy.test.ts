// @vitest-environment happy-dom
//
// A rendered table copied back out: as GFM with code and chips restored, and
// as CSV with a chip as the path it stood for.

import { describe, expect, it } from "vitest";
import { tableToCsv, tableToMarkdown } from "./markdown-table-copy";

function table(html: string): HTMLTableElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("table")!;
}

const SAMPLE = table(`
  <table>
    <thead><tr><th>Output</th><th align="right">What, it is</th></tr></thead>
    <tbody>
      <tr>
        <td><span class="atlas-file-chip" data-file-text="crates/x/settings_docs.gen.rs"><span class="atlas-mention-chip__icon"></span><span class="atlas-mention-chip__label">settings_docs.gen.rs</span></span></td>
        <td><code>SETTINGS_DOCS</code>, a | pipe</td>
      </tr>
      <tr><td>plain</td><td><a href="https://x.test">site</a></td></tr>
    </tbody>
  </table>`);

describe("markdown table copy", () => {
  it("copies as GFM, with code, chips and links as they were written", () => {
    expect(tableToMarkdown(SAMPLE)).toBe(
      [
        "| Output | What, it is |",
        "| --- | ---: |",
        "| `crates/x/settings_docs.gen.rs` | `SETTINGS_DOCS`, a \\| pipe |",
        "| plain | [site](https://x.test) |",
      ].join("\n"),
    );
  });

  it("copies as CSV, quoting what needs it", () => {
    expect(tableToCsv(SAMPLE)).toBe(
      [
        'Output,"What, it is"',
        'crates/x/settings_docs.gen.rs,"SETTINGS_DOCS, a | pipe"',
        "plain,site",
      ].join("\n"),
    );
  });
});
