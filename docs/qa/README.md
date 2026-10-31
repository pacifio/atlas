# QA

Hardening and smoke reports, written per release or per feature: what was run, on
which branch and machine, what passed, and what was found. They are records of one run,
not living checklists.

A report is added when a hardening pass or a live smoke run finishes, and it is not
rewritten afterwards. A later run gets its own file (or its own dated section) rather
than overwriting the earlier result. Reports that stop being useful move to `docs/archive/`.

- `0.3.4-hardening-report.md` - the 0.3.4 release-hardening run on Windows 11: chat comments, the UI tool server and the organisation tool server.
- `org-tools-smoke-matrix.md` - the live smoke matrix for Atlas Agent's organisation tools, with the first run on 2026-09-27.
