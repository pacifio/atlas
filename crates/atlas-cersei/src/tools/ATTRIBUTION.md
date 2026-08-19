# Attribution

The replacer engine in `replace.rs` (the fallback ladder behind the `Edit`
tool — `Simple`, `LineTrimmed`, `BlockAnchor`, `WhitespaceNormalized`,
`IndentationFlexible`, `EscapeNormalized`, `TrimmedBoundary`, `ContextAware`,
`MultiOccurrence`), the driver's uniqueness + disproportionate-match guard, and
the corrective error strings in `errors.rs`, the read pagination/`Did you mean?`
logic in `read.rs`, and the output-truncation spill in `truncate.rs` are ported
to Rust from **opencode** (MIT):

- opencode — `packages/opencode/src/tool/edit.ts`, `read.ts`, `grep.ts`,
  `glob.ts`, `truncate.ts` — https://github.com/sst/opencode (MIT License)

opencode's edit strategies are themselves derived from:

- **Cline** — `evals/diff-edits/diff-apply/*` — https://github.com/cline/cline (Apache-2.0)
- **Gemini CLI** — `packages/core/src/utils/editCorrector.ts` —
  https://github.com/google-gemini/gemini-cli (Apache-2.0)

`PunctuationFolded` — a tenth strategy folding typographic quotes, dashes and
exotic spaces before comparing — is Atlas's own and has no upstream equivalent.
So are `errors::already_read` and `errors::batch_failure`: opencode has neither a
repeat-read stub nor a batched edit to locate a failure within.

The Rust port is original code; only the algorithms, strategy ordering, and
error-message wording were adapted. The 2026 destructive-match guard and the
auto-apply vs. guarded-fuzzy-tail split follow opencode's hardening (see
`plans/atlas-cersei-edit-solution.md`).

## opencode (MIT)

```
MIT License

Copyright (c) opencode contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
