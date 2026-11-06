#!/usr/bin/env python3
"""Capture what a real ACP agent sends while it delegates to subagents.

ACP has no subagent concept, so Atlas reads one out of ordinary tool calls
(`atlas_acp_thread::subagent`). The rules there are derived from what agents
actually put on the wire — which is a claim about other people's software, and
the only way to keep it honest is to go and look.

This spawns one installed agent, asks it to delegate, and writes every
`tool_call` / `tool_call_update` it sent to a JSON file. Drop that file in
`crates/atlas-agent-delta/tests/fixtures/` and the replay tests in
`tests/live_subagents.rs` will drive it through the real thread, the real
projector and the real wire.

    python3 scripts/one-off/capture-subagents.py claude    # signed-in account
    OPENAI_API_KEY=sk-… python3 scripts/one-off/capture-subagents.py codex

Agents: claude, codex, opencode, and any other id installed from the registry
(`--agent-id`). The agent must already be installed and signed in — this
drives it, it does not set it up.

**Redact before committing.** A delegating prompt makes the agent describe the
directory it ran in, and that description lands in the fixture. Run it in a
scratch directory (the default), and read the file before checking it in.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

# A prompt that asks for delegation without naming any agent's tool, so the
# same wording exercises every agent's own vocabulary.
PROMPT = (
    "Launch two subagents in parallel: one named 'counter' that counts the "
    "files in this directory, and one named 'greeter' that composes a "
    "one-line greeting. Report both results. Do not modify any files."
)

# Anything that looks like a key, whatever the agent was given.
SECRET = re.compile(r"\b(sk-[A-Za-z0-9_\-]{20,}|ghp_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9\-]{20,})")


def atlas_data_dir() -> Path:
    """Where the desktop app keeps its installed agents, per platform."""
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/dev.atlas.ide"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData/Roaming")
        return Path(base) / "dev.atlas.ide"
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    return Path(base) / "dev.atlas.ide"


def managed_node(data_dir: Path) -> Path | None:
    """Atlas's own Node, which is what it runs npx adapters with."""
    root = data_dir / "node"
    if not root.is_dir():
        return None
    for version in sorted(root.iterdir()):
        binary = version / ("node.exe" if sys.platform == "win32" else "bin/node")
        if binary.is_file():
            return binary
    return None


def agent_command(agent_id: str, data_dir: Path) -> list[str]:
    """The argv Atlas would spawn for `agent_id`.

    npx agents run the adapter's entry point on the managed Node; binary
    agents run the executable the archive unpacked.
    """
    registry = data_dir / "external-agents/registry"

    install_dir = registry / "npx" / agent_id
    npx_dir = install_dir / "node_modules"
    if npx_dir.is_dir():
        node = managed_node(data_dir)
        if node is None:
            raise SystemExit(
                "no managed Node under "
                f"{data_dir / 'node'} — start the agent once in Atlas first"
            )
        # The package Atlas installed, from the sidecar it writes beside the
        # tree (`WANTED_SPEC_FILE`). Not a glob over `node_modules`: that
        # finds the adapter's own dependencies too, and the first one with a
        # `bin` is usually a vendored SDK that speaks no ACP.
        sidecar = install_dir / ".atlas-wanted"
        if not sidecar.is_file():
            raise SystemExit(f"{agent_id} has no .atlas-wanted; start it once in Atlas first")
        spec = sidecar.read_text(encoding="utf-8").strip().split("#", 1)[0]
        package_name = spec[: spec.rindex("@")] if "@" in spec[1:] else spec
        manifest = npx_dir / package_name / "package.json"
        if not manifest.is_file():
            raise SystemExit(f"{package_name} is not under {npx_dir}")
        binaries = json.loads(manifest.read_text(encoding="utf-8")).get("bin")
        entry = binaries if isinstance(binaries, str) else next(iter((binaries or {}).values()), None)
        if entry is None:
            raise SystemExit(f"{package_name} declares no entry point")
        return [str(node), str(manifest.parent / entry)]

    binary_dir = registry / agent_id
    if binary_dir.is_dir():
        for version in sorted(binary_dir.iterdir(), reverse=True):
            for name in (agent_id, f"{agent_id}.exe"):
                candidate = version / name
                if candidate.is_file():
                    # Registry binary agents take `acp` as their first arg.
                    return [str(candidate), "acp"]
    raise SystemExit(
        f"{agent_id} is not installed under {registry} — install it in "
        "Atlas (Settings → Agents) and run it once"
    )


def capture(argv: list[str], cwd: Path, prompt: str, deadline: float) -> dict:
    """Run one prompt and collect every notification the agent sent."""
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd),
        env=dict(os.environ),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        # ACP is UTF-8 JSON. Without this, Windows decodes the pipe with the
        # locale codepage (cp1252) and the first non-ASCII byte crashes it.
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    stderr: list[str] = []
    threading.Thread(
        target=lambda: [stderr.append(line.rstrip()) for line in proc.stderr],
        daemon=True,
    ).start()

    updates: list[dict] = []
    results: dict[int, dict] = {}
    next_id = [0]

    def write(message: dict) -> bool:
        """Write one JSON-RPC line. False once the agent has gone away.

        An agent that exits — a failed sign-in, a crash — closes its stdin
        while we are still mid-conversation, and the resulting BrokenPipeError
        would bury the stderr that says why.
        """
        try:
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            return True
        except (BrokenPipeError, ValueError, OSError):
            return False

    def send(method: str, params: dict) -> int:
        next_id[0] += 1
        write({"jsonrpc": "2.0", "id": next_id[0], "method": method, "params": params})
        return next_id[0]

    def answer(request_id, result) -> None:
        write({"jsonrpc": "2.0", "id": request_id, "result": result})

    started = time.time()

    def pump(until: int | None) -> dict | None:
        while time.time() - started < deadline:
            line = proc.stdout.readline()
            if not line:
                return None
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            method = message.get("method")
            if method == "session/update":
                updates.append(message["params"])
                continue
            if method and "id" in message:
                # The agent is asking US something. Say yes to permissions so
                # the children actually run; answer the rest emptily.
                if method == "session/request_permission":
                    options = message["params"].get("options", [])
                    allow = next(
                        (o for o in options if "allow" in o.get("kind", "")),
                        options[0] if options else None,
                    )
                    answer(
                        message["id"],
                        {"outcome": {"outcome": "selected", "optionId": allow["optionId"]}}
                        if allow
                        else {"outcome": {"outcome": "cancelled"}},
                    )
                elif method == "fs/read_text_file":
                    try:
                        answer(message["id"], {"content": Path(message["params"]["path"]).read_text(encoding="utf-8")})
                    except OSError:
                        answer(message["id"], {"content": ""})
                else:
                    answer(message["id"], {})
                continue
            if "id" in message:
                results[message["id"]] = message
                if until is not None and message["id"] == until:
                    return message
        return None

    initialize = pump(
        send(
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": True, "writeTextFile": True},
                    "terminal": True,
                    # The capability that makes an adapter forward a child's
                    # own narration; see `SUBAGENT_TRANSCRIPT_META_KEY`.
                    "_meta": {"subagent-transcript": True, "terminal_output": True},
                },
                "clientInfo": {"name": "atlas-subagent-capture", "version": "0.0.0"},
            },
        )
    )
    if initialize is None:
        proc.kill()
        raise SystemExit(
            "the agent never answered `initialize`:\n  "
            + "\n  ".join(stderr[-10:] or ["(it printed nothing)"])
        )

    opened = pump(send("session/new", {"cwd": str(cwd), "mcpServers": []}))
    session_id = (opened or {}).get("result", {}).get("sessionId")
    if not session_id:
        proc.kill()
        raise SystemExit(
            f"the agent opened no session: {json.dumps(opened)[:400]}\n  "
            + "\n  ".join(stderr[-10:])
        )

    pump(send("session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]}))
    proc.kill()
    return {"initialize": initialize, "updates": updates, "stderr": stderr[-40:]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("agent", help="claude | codex | opencode | <registry id>")
    parser.add_argument("--agent-id", help="the installed id, when it differs from `agent`")
    parser.add_argument("--out", type=Path, help="where to write the fixture")
    parser.add_argument("--cwd", type=Path, help="run here (default: a scratch dir)")
    parser.add_argument("--deadline", type=float, default=240.0)
    parser.add_argument("--prompt", default=PROMPT)
    args = parser.parse_args()

    known = {"claude": "claude-acp", "codex": "codex-acp", "opencode": "opencode"}
    agent_id = args.agent_id or known.get(args.agent, args.agent)
    data_dir = atlas_data_dir()
    argv = agent_command(agent_id, data_dir)

    cwd = args.cwd or Path(os.environ.get("TMPDIR", "/tmp")) / "atlas-subagent-capture"
    cwd.mkdir(parents=True, exist_ok=True)
    (cwd / "main.rs").write_text('fn main() { println!("hi"); }\n')
    (cwd / "README.md").write_text("# scratch\n")

    print(f"{agent_id}: {' '.join(argv)}\n  cwd {cwd}")
    captured = capture(argv, cwd, args.prompt, args.deadline)

    calls = [
        update["update"]
        for update in captured["updates"]
        if update["update"]["sessionUpdate"] in ("tool_call", "tool_call_update")
    ]
    text = SECRET.sub("REDACTED", json.dumps(calls, indent=1)) + "\n"

    out = args.out or Path(f"{args.agent}-subagents.json")
    out.write_text(text, encoding="utf-8")
    print(f"  {len(captured['updates'])} updates, {len(calls)} tool calls -> {out}")
    if not calls:
        print("  no tool calls: the agent answered without using any tool")
        for line in captured["stderr"][-8:]:
            print(f"  stderr: {line}")
    print("  READ THE FILE before committing it — a prompt can quote the repo.")


if __name__ == "__main__":
    main()
