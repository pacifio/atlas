This is `wordfreq`, a small Rust CLI that reads whitespace-separated words
from stdin and prints `word count` lines, most frequent first (ties broken
alphabetically).

Add a `--top N` command-line flag:

- `wordfreq --top N` prints only the first `N` rows of the normal output.
- `N` must be a positive integer. If it is zero, negative, missing, or not
  a number, print an error message to stderr and exit with code `2`.
- With no `--top` flag, behavior is exactly as today (all rows printed).
- Any other argument is also an error: stderr message, exit code `2`.

Keep the existing tests passing, and add tests covering the new flag.
