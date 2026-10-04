# Security

Report security issues privately by email rather than opening a public issue.

## Scope

Atlas runs coding agents that read files and execute commands. An agent doing that after you approved it is the product working as designed. An agent doing it **without** the approval step, or reaching outside the project you granted it, is a vulnerability.

Credential handling, the update channel, and anything that causes local data to leave the machine unexpectedly are all in scope.

## Reporting a vulnerability

Email **adibmohsin.root@gmail.com** with:

- **Atlas version** — Settings → About.
- **OS and chip** — macOS version, Apple Silicon or Intel.
- **Steps to reproduce.**
- **Impact** — what an attacker could do with it.

## What to expect

We acknowledge reports as soon as we can and prioritise confirmed issues. There is no formal SLA, and response times vary. Please hold off on public disclosure until we have had a chance to look.

## Supported versions

Atlas is pre-1.0. Only the latest release is supported — update and confirm the issue still reproduces before reporting.
