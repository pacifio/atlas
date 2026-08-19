Bug report — credential keys with an all-caps acronym prefix escape
redaction.

`crates/atlas-redact/src/credential.rs` classifies a JSON key as a
credential by splitting it into camel-case segments (`segments()`) and
checking them against credential vocabulary. The splitter only breaks on a
lowercase→uppercase transition, so a key that *starts* with an all-caps
acronym directly followed by a capitalised word never splits:
`JWTSecret`, `DBPassword`, and `GCPSecret` each collapse into one
unsplittable segment, are never recognised as containing "secret" /
"password", and their values are not redacted.

Fix `segments()` so an acronym run followed by a capitalised word splits at
the right boundary (`JWTSecret` → `jwt`, `secret`), without breaking any of
the existing splitting behavior (underscores, dashes, dots, ordinary
camel-case, digits).

Run the `atlas-redact` crate's tests from `crates/atlas-redact/` to check
your work.
