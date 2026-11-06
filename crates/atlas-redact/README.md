# atlas-redact

Atlas's single source of truth for secret redaction. String in, redacted string
out, plus a tally of what was replaced.

```rust
let out = atlas_redact::redact("deploy with API_KEY=supersecretvalue123");
assert!(out.text.contains("[REDACTED]"));
assert_eq!(out.counts.total(), 1);
```

## Where it sits

Redaction runs **before persistence, not before upload**. Atlas records agent
Sessions to disk; an agent that reads a `.env` puts its contents verbatim into
the transcript, and a shell command that prints a token puts it in the tool
result. Scrubbing on the way in means the local store is never itself a place a
secret lives, so every downstream feature inherits the guarantee instead of
needing its own pass — and there is exactly one code path that can be forgotten
rather than two.

The crate is pure: no I/O, no async, no logging of the content it processes, no
Tauri runtime. That is what makes it testable as a flat table and cheap enough to
sit on the turn-completion path.

## The six layers

A string is redacted if **any** layer flags it. Each catches a class the others
provably miss:

| Layer | Catches | Why the others miss it |
| --- | --- | --- |
| Shannon entropy | random-looking tokens | the only layer that works on a format nobody has a rule for |
| Vendored rules | ~310 known provider formats | entropy too low, or alphabet too narrow, to clear the threshold |
| Provider prefixes | `sk-`, `ghp_`, `xox…`, `sb_secret_` | corpus rules are length-pinned or composite, and miss a key quoted alone |
| Credentialed URIs | `scheme://user:pass@host` | memorable passwords have low entropy and match no vendor format |
| Connection strings | JDBC, keyword DSN, semicolon | the credential is structural, not a token |
| Credential key/value | `DB_PASSWORD=…` | the *key* is the only evidence; the value has no shape |

## Over-redaction is a failure too

A transcript reduced to `[REDACTED]` is as useless as one that leaks, and it is
the failure nobody reports — there is no raw copy to recover from, so a false
positive is permanent, silent data loss. Documentation placeholders, `${VAR}`
expansions, mask runs, ordinary identifiers (`token_count`, `cache_key`, `PWD`)
and git SHAs are held out deliberately, and `tests/negatives.rs` is load-bearing
rather than decorative.

That property is also what makes redaction **idempotent**: the placeholder is
itself recognised as a placeholder, so a second pass is a no-op.

## Vendored rules

`src/vendor_rules.rs` is generated from the
[betterleaks](https://github.com/betterleaks/betterleaks) default configuration
(MIT, © 2026 Zachary Rice). Regenerate with:

```sh
python3 scripts/gen_vendor_rules.py path/to/betterleaks.toml
cargo test   # `every_vendored_rule_compiles_under_the_rust_regex_crate` is the gate
```

The generator documents every exclusion and every pattern rewrite, so a dropped
rule is a recorded decision rather than a silent gap. Rules compile lazily and
are gated behind a keyword prefilter, so a typical call touches a handful of the
310 and the rest never compile at all.

The layered approach — entropy, vendor corpus, provider prefixes, credentialed
URIs, connection strings, bounded credential pairs — is what lets each layer
stay narrow: no single detector has to catch every secret shape, so none has to
be loose enough to flag ordinary text. Provenance for the borrowed pieces is in
`LICENSE-betterleaks`.
