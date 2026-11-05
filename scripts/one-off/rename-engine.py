#!/usr/bin/env python3
"""One-off: rename the engine from its upstream name to atlas-engine
(ADR-0011). Committed with the sweep it produced so a reviewer can re-run it on
the parent commit; deleted in the follow-up PR because it necessarily spells
the retired names.

    python3 scripts/one-off/rename-engine.py moves    # git mv / git rm, no content edits
    python3 scripts/one-off/rename-engine.py sweep    # content substitution (idempotent)
    python3 scripts/one-off/rename-engine.py headers  # Apache §4(b) notice on modified files
    python3 scripts/one-off/rename-engine.py verify   # print leftovers outside the allowlist

Rules are applied most-specific first. Product-facing tokens (the home dir,
the project-local dot-dir, env vars, MCP identity, OTel names) become
"atlas-agent"/"ATLAS_AGENT_*"; crate names, Rust identifiers and types become
"atlas-engine-*"/"atlas_engine_*"/"AtlasEngine*". Bare words are split by
context: inside code they are identifiers (`atlas_engine` / `AtlasEngine`),
inside strings, comments and prose they are the product name (`atlas-agent` /
`Atlas Agent`). Protected and never rewritten: the LICENSE and NOTICE, the
§4(b) notice line, every URL, and OpenAI model ids.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
OLD_DIR = "vendor/codex"
NEW_DIR = "vendor/atlas-engine"
NOTICE = "Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md."
FORK_COMMIT = "67fb707d3d5fd35f57726fcb17ed3177bcc34c58"

# Atlas-side files the sweep may touch (everything under vendor is in scope).
ATLAS_SIDE = [
    "Cargo.toml",
    "clippy.toml",
    ".gitignore",
    ".gitattributes",
    ".husky/pre-commit",
    ".github/workflows/ci.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "scripts/test-rust.sh",
    "crates/atlas-process/tests/spawn_audit.rs",
    "crates/atlas-thread-metadata/tests/sqlite_floor.rs",
]
ATLAS_SIDE_GLOBS = ["crates/atlas-native-agent/**/*", "tests/*.test.ts"]
# Hand-edited: it names the path the engine was first imported under, on purpose.
ATLAS_SIDE_SKIP = {"tests/vendor-licensing.test.ts", "tests/no-legacy-names.test.ts"}

CODE_EXT = {".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".proto", ".lark"}
BINARY_EXT = {".zst", ".png", ".jpg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".pem"}
SKIP_FILES = {f"{NEW_DIR}/LICENSE", f"{NEW_DIR}/NOTICE"}
# OpenAI model ids stay (wire values); the model-keyed prompt files are not moved.
KEEP_NAME = re.compile(r"gpt[-_][\w.-]*codex[\w.-]*|codex-auto-review|codex-mini[\w-]*")

# ── protected tokens ────────────────────────────────────────────────────────
PROTECT_LINE = re.compile(r"Modified by Atlas from upstream OpenAI Codex|OpenAI-Codex-")
PROTECT_TOKEN = re.compile(
    r"https?://[^\s\"'`)>\]]*"                      # every URL, the original's included
    r"|atlas-agent-codex-port-spec"                 # the archived spec keeps its filename
    r"|gpt[-_][\w.]*?[-_]codex[\w.-]*"              # gpt-5-codex, gpt_5_codex_prompt, gpt-5.2-codex_friendly
    r"|\bcodex-auto-review\b|\bcodex-mini[\w-]*\b"  # model slugs
)

# ── ordered substitution rules (regex, replacement) ─────────────────────────
# 0. paths
R_PATH = [
    (re.compile(r"vendor/codex\b"), "vendor/atlas-engine"),
    # the `codex-home` crate (a path, not the home dir) — its lib is atlas_engine_home
    (re.compile(r"\b(codex_home|atlas_agent_home)::"), "atlas_engine_home::"),
    (re.compile(r"\bcodex\.(code_mode|thread_config|exec_server)\."), r"atlas_engine.\1."),
]
# 1. product-facing tokens
R_PRODUCT = [
    (re.compile(r"codex_home"), "atlas_agent_home"),
    (re.compile(r"codexHome"), "atlasAgentHome"),
    (re.compile(r"CodexHome"), "AtlasAgentHome"),
    (re.compile(r"dot_codex_folder"), "dot_atlas_agent_folder"),
    (re.compile(r"dotCodexFolder"), "dotAtlasAgentFolder"),
    (re.compile(r"DotCodexFolder"), "DotAtlasAgentFolder"),
    (re.compile(r"codex_apps"), "atlas_apps"),
    (re.compile(r"CODEX_APPS"), "ATLAS_APPS"),
    (re.compile(r"codexApps"), "atlasApps"),
    (re.compile(r"CodexApps"), "AtlasApps"),
    (re.compile(r"codex_(request_type|approval_kind|strict_auto_review)"), r"atlas_agent_\1"),
    (re.compile(r"_codex_executed_tool_call_"), "_atlas_agent_executed_tool_call_"),
    (re.compile(r"codex_cli_rs"), "atlas_agent"),
    (re.compile(r"codex_atlas\b"), "atlas_agent"),
    (re.compile(r"codex-mcp-client"), "atlas-agent"),
    (re.compile(r"x-openai-internal-codex-residency"), "x-atlas-agent-residency"),
    (re.compile(r"\"Codex Auth\""), "\"Atlas Agent Auth\""),
    (re.compile(r"\"Codex MCP Credentials\""), "\"Atlas Agent MCP Credentials\""),
    (re.compile(r"\"codex/"), "\"atlas-agent/"),          # MCP `_meta` keys
    (re.compile(r"\"codex\.(?=[a-z_]+[.\"])"), "\"atlas_agent."),  # OTel metric names in string literals
]
# text-only product paths (in code `.codex` is a field or module access)
R_TEXT_PATHS = [
    (re.compile(r"\\\.codex\b"), "\\.atlas-agent"),      # already-escaped regex spellings
    (re.compile(r"\.codex\b"), ".atlas-agent"),          # ~/.codex, .codex/, .codex-plugin
    (re.compile(r"\\nCodex\b"), "\\nAtlas Agent"),         # a prose line break inside a string
]
# 2. mechanical identifier classes
R_IDENT = [
    (re.compile(r"(?<![A-Za-z0-9])codex-"), "atlas-engine-"),
    (re.compile(r"(?<![A-Za-z0-9])codex_"), "atlas_engine_"),
    (re.compile(r"(?<![A-Za-z0-9])CODEX_"), "ATLAS_AGENT_"),
    (re.compile(r"(?<![A-Za-z0-9_])codex(?=[A-Z])"), "atlasEngine"),
    (re.compile(r"Codex(?=[A-Z0-9])"), "AtlasEngine"),
    (re.compile(r"(?<=[A-Za-z0-9])Codex(?![a-z])"), "AtlasEngine"),      # TestCodex, RunCodex
    (re.compile(r"(?<=[A-Za-z0-9_])codex(?![A-Za-z0-9_])"), "atlas_engine"),  # test_codex, dot_codex
    (re.compile(r"(?<=_)codex(?=[A-Z])"), "atlasEngine"),                     # __codexContentItems
    (re.compile(r"Codex(?=_)"), "AtlasEngine"),                               # Codex_Desktop
    (re.compile(r"_CODEX(?![A-Za-z0-9])"), "_ATLAS_ENGINE"),                  # TEST_RELEASED_CODEX
    (re.compile(r"(?<=\\n)codex_"), "atlas_engine_"),                        # "\ncodex_hooks" in a string
]
# 3. bare words — split by context
W_CODE = [
    (re.compile(r"(?<![A-Za-z0-9_])CODEX(?![A-Za-z0-9_])"), "ATLAS_ENGINE"),
    (re.compile(r"(?<![A-Za-z0-9_])Codex(?![A-Za-z0-9_])"), "AtlasEngine"),
    (re.compile(r"(?<![A-Za-z0-9_])codex(?![A-Za-z0-9_])"), "atlas_engine"),
    (re.compile(r"\.codex\b"), ".atlas_engine"),
    (re.compile(r"\.atlas-agent\b"), ".atlas_engine"),  # repair: a hyphen cannot be in an identifier
]
W_TEXT = [
    (re.compile(r"(?<![A-Za-z0-9_])codex(?=\d)"), "atlas-agent"),            # fixture paths like code/codex3
    (re.compile(r"(?<![A-Za-z0-9_])Codex(?![A-Za-z0-9_])"), "Atlas Agent"),
    (re.compile(r"(?<![A-Za-z0-9_])codex(?![A-Za-z0-9_])"), "atlas-agent"),
    (re.compile(r"(?<![A-Za-z0-9_])CODEX(?![A-Za-z0-9_])"), "ATLAS_AGENT"),
]


def apply(rules, s):
    for rx, rep in rules:
        s = rx.sub(rep, s)
    return s


def split_segments(line: str, ext: str):
    """Yield (text, is_code) for one line: string literals and comments are text."""
    if ext not in CODE_EXT:
        yield line, False
        return
    i, n, buf, out = 0, len(line), [], []
    seg_start = 0
    while i < n:
        ch = line[i]
        two = line[i : i + 2]
        if two == "//" or (ext == ".py" and ch == "#"):
            out.append((line[seg_start:i], True))
            out.append((line[i:], False))
            seg_start = n
            break
        if ch in "\"'`":
            if ch == "'" and ext == ".rs":
                # lifetimes and char literals: treat as code unless it closes on this line
                j = line.find("'", i + 1)
                if j == -1 or j - i > 2:
                    i += 1
                    continue
            q = ch
            j = i + 1
            while j < n:
                if line[j] == "\\":
                    j += 2
                    continue
                if line[j] == q:
                    break
                j += 1
            out.append((line[seg_start:i], True))
            out.append((line[i : j + 1], False))
            i = j + 1
            seg_start = i
            continue
        i += 1
    if seg_start < n:
        out.append((line[seg_start:], True))
    for seg, is_code in out:
        if seg:
            yield seg, is_code


BACKTICK = re.compile(r"`[^`]*`")


def rename_line(line: str, ext: str, in_block_comment: bool) -> str:
    if PROTECT_LINE.search(line):
        return line
    # protect tokens with placeholders
    holds: list[str] = []

    def hold(m):
        tok = m.group(0)
        if tok.startswith("http"):
            # a format placeholder inside a URL literal is an identifier, not a URL
            tok = re.sub(r"\{([^}]*)\}", lambda g: "{" + apply(R_IDENT, apply(W_CODE, g.group(1))) + "}", tok)
        holds.append(tok)
        return f"\x00{len(holds) - 1}\x00"

    line = PROTECT_TOKEN.sub(hold, line)
    line = apply(R_PATH, line)
    line = apply(R_PRODUCT, line)
    line = apply(R_IDENT, line)
    pieces = []
    segs = [(line, False)] if in_block_comment else list(split_segments(line, ext))
    for seg, is_code in segs:
        if is_code:
            pieces.append(apply(W_CODE, seg))
        else:
            # inside text, backticked spans are code (`Codex` names the struct)
            parts, last = [], 0
            for m in BACKTICK.finditer(seg):
                parts.append(apply(W_TEXT, apply(R_TEXT_PATHS, seg[last : m.start()])))
                parts.append(apply(W_CODE, m.group(0)))
                last = m.end()
            parts.append(apply(W_TEXT, apply(R_TEXT_PATHS, seg[last:])))
            pieces.append("".join(parts))
    line = "".join(pieces)
    return re.sub(r"\x00(\d+)\x00", lambda m: holds[int(m.group(1))], line)


def rename_text(s: str, ext: str) -> str:
    out = []
    in_block = False
    for line in s.split("\n"):
        # crude Rust/TS block-comment tracking: a line inside `/* ... */` is text
        this_block = in_block
        if ext in CODE_EXT and ext != ".py":
            if "/*" in line and "*/" not in line:
                in_block = True
            elif "*/" in line:
                in_block = False
        out.append(rename_line(line, ext, this_block))
    return "\n".join(out)


def tracked(prefix: str | None = None) -> list[str]:
    args = ["git", "ls-files", "-z"] + ([prefix] if prefix else [])
    return [p for p in subprocess.check_output(args, cwd=ROOT).decode().split("\0") if p]


def walk(prefix: str) -> list[str]:
    """Every file under `prefix` in the working tree, `target/` excluded.

    The working tree and not the index on purpose: the moves are plain
    filesystem renames so they stay out of the index until the reviewer stages
    them, which keeps this PR's commits separable from the one before it.
    """
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT / prefix):
        dirnames[:] = [d for d in dirnames if d != "target" and d != ".git"]
        for f in filenames:
            out.append(str((Path(dirpath) / f).relative_to(ROOT)))
    return sorted(out)


def fs_move(src: str, dst: str):
    d = ROOT / dst
    d.parent.mkdir(parents=True, exist_ok=True)
    (ROOT / src).rename(d)


def fs_rm(path: str):
    p = ROOT / path
    if p.is_dir():
        import shutil
        shutil.rmtree(p)
    elif p.exists():
        p.unlink()


# ── phases ──────────────────────────────────────────────────────────────────
def moves():
    if (ROOT / OLD_DIR).exists():
        fs_move(OLD_DIR, NEW_DIR)
    base = ROOT / NEW_DIR
    for d in ["codex-api", "codex-backend-openapi-models", "codex-client",
              "codex-experimental-api-macros", "codex-home", "codex-mcp"]:
        if (base / d).exists():
            fs_move(f"{NEW_DIR}/{d}", f"{NEW_DIR}/atlas-engine-{d[len('codex-'):]}")
    if (base / "atlas-engine-mcp/src/codex_apps").exists():
        fs_move(f"{NEW_DIR}/atlas-engine-mcp/src/codex_apps", f"{NEW_DIR}/atlas-engine-mcp/src/atlas_apps")
    # dead for cargo; deletion needs no §4(b) notice
    for p in walk(NEW_DIR):
        if re.search(r"(BUILD\.bazel|MODULE\.bazel|WORKSPACE(\.bazel)?|\.bazelrc|\.bzl)$", p):
            fs_rm(p)
    for sample in ["openai-docs", "imagegen"]:
        fs_rm(f"{NEW_DIR}/skills/src/assets/samples/{sample}")
    # files whose basename spells the old name, model-keyed prompt files excepted
    for p in walk(NEW_DIR):
        name = os.path.basename(p)
        if "codex" not in name.lower() or KEEP_NAME.search(name):
            continue
        new = rename_line(name, os.path.splitext(name)[1], False)
        new = new.replace("atlas-agent", "atlas-engine") if name.endswith(".manifest") else new
        if new != name:
            fs_move(p, os.path.join(os.path.dirname(p), new))
    print("moves: done")


def sweep_files() -> list[str]:
    files = [p for p in walk(NEW_DIR) if p not in SKIP_FILES]
    files += [p for p in ATLAS_SIDE if (ROOT / p).exists()]
    for g in ATLAS_SIDE_GLOBS:
        files += [str(p.relative_to(ROOT)) for p in ROOT.glob(g) if p.is_file() and "/target/" not in str(p)]
    return sorted(set(files) - ATLAS_SIDE_SKIP)


def sweep():
    changed = 0
    for rel in sweep_files():
        p = ROOT / rel
        ext = p.suffix
        if ext in BINARY_EXT or not p.is_file():
            continue
        try:
            s = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        t = rename_text(s, ext)
        if t != s:
            p.write_text(t, encoding="utf-8")
            changed += 1
    print(f"sweep: {changed} files changed")


COMMENT = {
    ".rs": "// {}", ".ts": "// {}", ".tsx": "// {}", ".js": "// {}", ".mjs": "// {}", ".cjs": "// {}",
    ".proto": "// {}", ".lark": "// {}",
    ".md": "<!-- {} -->", ".html": "<!-- {} -->", ".svg": "<!-- {} -->", ".xml": "<!-- {} -->", ".manifest": "<!-- {} -->",
    ".toml": "# {}", ".py": "# {}", ".sh": "# {}", ".yaml": "# {}", ".yml": "# {}", ".ps1": "# {}", ".rules": "# {}",
    ".gitattributes": "# {}",
    ".sbpl": "; {}",
    ".sql": "-- {}",
}


def fork_blobs() -> dict[str, str]:
    out = subprocess.check_output(["git", "ls-tree", "-r", f"{FORK_COMMIT}:{OLD_DIR}"], cwd=ROOT, text=True)
    blobs = {}
    for line in out.splitlines():
        meta, path = line.split("\t", 1)
        blobs[path] = meta.split()[2]
    return blobs


def modified_set() -> list[str]:
    """Working-tree files under the engine that differ from the fork-point tree.

    Compared by blob hash at the same relative path, so it needs neither the
    index nor a commit — a renamed file has no counterpart and counts as
    modified, which it is (its contents changed with the rename).
    """
    blobs = fork_blobs()
    files = walk(NEW_DIR)
    hashes = subprocess.run(["git", "hash-object", "--stdin-paths"], cwd=ROOT, text=True,
                            input="\n".join(files) + "\n", capture_output=True, check=True).stdout.split()
    out = []
    for rel, h in zip(files, hashes):
        old = rel[len(NEW_DIR) + 1:]
        if blobs.get(old) != h:
            out.append(rel)
    return out


# Generated fixtures a test regenerates and compares byte-for-byte: a header
# would be dropped or would fail the comparison. Listed in ATLAS-CHANGES.md.
GENERATED_DIRS = (f"{NEW_DIR}/app-server-protocol/schema/", f"{NEW_DIR}/hooks/schema/")


def headers():
    added, exempt = 0, []
    for rel in modified_set():
        p = ROOT / rel
        if not p.is_file() or rel in SKIP_FILES or rel.startswith(GENERATED_DIRS):
            continue
        ext = p.suffix if p.suffix else p.name
        try:
            s = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            exempt.append(rel)
            continue
        if NOTICE in s:
            continue
        if ext == ".json":
            # Fixtures are compared structurally by tests; a root `$comment`
            # would change what they assert. Listed in ATLAS-CHANGES.md instead
            # (config.schema.json emits its own notice from the generator).
            exempt.append(rel)
            continue
        fmt = COMMENT.get(ext)
        if fmt is None:
            exempt.append(rel)
            continue
        head = fmt.format(NOTICE) + "\n"
        if s.startswith("#!"):
            first, rest = s.split("\n", 1)
            s = first + "\n" + head + rest
        elif ext == ".xml" or ext == ".manifest" or (ext == ".svg" and s.startswith("<?xml")):
            first, rest = s.split("\n", 1) if s.startswith("<?xml") else ("", s)
            s = (first + "\n" if first else "") + head + rest
        else:
            s = head + s
        p.write_text(s, encoding="utf-8"); added += 1
    print(f"headers: {added} added; {len(exempt)} files cannot carry one:")
    for e in exempt:
        print("  ", e)


def verify():
    out = subprocess.run(["git", "grep", "-n", "-i", "-E", "--untracked", "cersei|codex", "--", ".", ":!docs/adr", ":!docs/archive", ":!Cargo.lock",
                          ":!graphify-out", f":!{NEW_DIR}/LICENSE", f":!{NEW_DIR}/NOTICE",
                          ":!src-tauri/licenses", ":!scripts/one-off"], cwd=ROOT, text=True, capture_output=True).stdout
    keep = re.compile(r"Modified by Atlas from upstream OpenAI Codex|https?://\S*codex|gpt[-_][\w.]*codex|codex-auto-review|codex-mini|OpenAI-Codex-")
    for line in out.splitlines():
        if not keep.search(line):
            print(line)


if __name__ == "__main__":
    {"moves": moves, "sweep": sweep, "headers": headers, "verify": verify}[sys.argv[1]]()
