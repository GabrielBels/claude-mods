"""Prints the Claude Code and Codex sessions with prompts on or after a moment, as JSON, for /standup.

Usage: python3 -I sessions.py '{"since": <epoch ms>, "dirs": [...], "scopes": [...]}'

Each of `dirs` is a Claude Code projects folder (~/.claude/projects) or a Codex sessions folder (~/.codex/sessions).
A session counts when its working folder is one of `scopes` or inside one; a Windows folder (D:\\work) is compared as its
WSL mount (/mnt/d/work), case aside. Claude Code folders whose encoded name cannot be inside a scope are not opened.
Only the person's own prompts and the session titles are read; tool output, answers and subagent transcripts are not.
A transcript untouched since `since` is skipped, and each prompt is kept only when its own timestamp is on or after it.
Output: [{source, cwd, branch, title, start, prompts}] oldest first.
"""

import json
import os
import re
import sys
from datetime import datetime

PROMPT_CHARS = 300
PROMPTS_HEAD = 8
PROMPTS_TAIL = 4
COMMAND = re.compile(r"<command-name>\s*(/?[^<\s]+)\s*</command-name>")
COMMAND_ARGS = re.compile(r"<command-args>([\s\S]*?)</command-args>")
REMINDER = re.compile(r"<system-reminder>[\s\S]*?</system-reminder>")
SKIPPED_COMMANDS = {"/standup", "/model", "/clear", "/exit", "/resume", "/config", "/status", "/cost", "/compact"}


def epoch_ms(stamp):
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000
    except (AttributeError, ValueError):
        return -1


def posix(path):
    """`D:\\a\\b` as `/mnt/d/a/b`; lower case and without a trailing slash, for comparing folders."""
    drive = re.match(r"^([A-Za-z]):[\\/]?(.*)$", path or "")
    if drive:
        path = f"/mnt/{drive.group(1)}/{drive.group(2)}"
    return path.replace("\\", "/").rstrip("/").lower()


def is_inside(cwd, scopes):
    folder = posix(cwd)
    return any(folder == scope or folder.startswith(scope + "/") for scope in scopes)


def encoded(path):
    """How Claude Code names a project's transcript folder after its working folder."""
    return re.sub(r"[^A-Za-z0-9]", "-", path).lower()


def project_prefixes(scopes):
    """The encoded names a project folder inside each scope starts with, in its WSL and its Windows spelling."""
    prefixes = []
    for scope in scopes:
        prefixes.append(encoded(scope))
        mount = re.match(r"^/mnt/([a-z])(/.*)?$", scope)
        if mount:
            prefixes.append(encoded(f"{mount.group(1)}:{mount.group(2) or ''}"))
    return prefixes


def tidy(text):
    return " ".join(text.split())[:PROMPT_CHARS]


def claude_prompt(content):
    """The person's words in a Claude Code user line, or None for tool results, injected context and local commands."""
    if isinstance(content, list):
        if any(isinstance(block, dict) and block.get("type") == "tool_result" for block in content):
            return None
        content = " ".join(block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text")
    if not isinstance(content, str):
        return None
    text = REMINDER.sub("", content).strip()
    command = COMMAND.search(text)
    if command:
        name = command.group(1) if command.group(1).startswith("/") else "/" + command.group(1)
        if name in SKIPPED_COMMANDS:
            return None
        args = COMMAND_ARGS.search(text)
        return tidy(f"{name} {args.group(1) if args else ''}")
    if text == "" or text.startswith("<") or text.startswith("[Request interrupted") or text.startswith("Caveat:"):
        return None
    return tidy(text)


def codex_prompt(payload):
    if payload.get("type") != "message" or payload.get("role") != "user":
        return None
    text = " ".join(item.get("text", "") for item in payload.get("content") or [] if isinstance(item, dict) and item.get("type") == "input_text").strip()
    if text == "" or text.startswith("<") or text.startswith("# AGENTS.md"):
        return None
    return tidy(text)


def read_claude(path, since):
    session = {"source": "claude", "cwd": "", "branch": "", "title": "", "start": "", "prompts": []}
    with open(path, "rb") as lines:
        for line in lines:
            is_title = b'"ai-title"' in line or b'"custom-title"' in line
            if not is_title and (b'"type":"user"' not in line or b'"tool_result"' in line):
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if is_title:
                session["title"] = row.get("customTitle") or row.get("aiTitle") or session["title"]
                continue
            if row.get("type") != "user" or row.get("isMeta") or row.get("isSidechain") or row.get("isCompactSummary"):
                continue
            stamp = row.get("timestamp", "")
            if epoch_ms(stamp) < since:
                continue
            prompt = claude_prompt((row.get("message") or {}).get("content"))
            if prompt is None:
                continue
            session["start"] = session["start"] or stamp
            session["cwd"] = row.get("cwd") or session["cwd"]
            session["branch"] = row.get("gitBranch") or session["branch"]
            session["prompts"].append(prompt)
    return session


def read_codex(path, since, titles):
    session = {"source": "codex", "cwd": "", "branch": "", "title": "", "start": "", "prompts": []}
    with open(path, "rb") as lines:
        for line in lines:
            is_meta = b'"session_meta"' in line
            if not is_meta and b'"role":"user"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            payload = row.get("payload") or {}
            if row.get("type") == "session_meta":
                session["cwd"] = payload.get("cwd") or ""
                session["branch"] = (payload.get("git") or {}).get("branch") or ""
                session["title"] = titles.get(payload.get("id"), "")
                continue
            if row.get("type") != "response_item" or epoch_ms(row.get("timestamp", "")) < since:
                continue
            prompt = codex_prompt(payload)
            if prompt is not None:
                session["start"] = session["start"] or row["timestamp"]
                session["prompts"].append(prompt)
    return session


def codex_titles(sessions_dir):
    """Codex keeps thread names beside its sessions folder, one JSON line per rename; the last one wins."""
    titles = {}
    try:
        with open(os.path.join(os.path.dirname(os.path.normpath(sessions_dir)), "session_index.jsonl"), "rb") as lines:
            for line in lines:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("id") and row.get("thread_name"):
                    titles[row["id"]] = row["thread_name"]
    except OSError:
        pass
    return titles


def transcripts(root, since_s, prefixes):
    for folder, dirs, files in os.walk(root):
        is_top = os.path.normpath(folder) == os.path.normpath(root)
        dirs[:] = [
            name for name in dirs
            if name != "subagents" and (not is_top or re.match(r"^\d{4}$", name) or name.lower().startswith(tuple(prefixes)))
        ]
        for name in files:
            path = os.path.join(folder, name)
            try:
                if name.endswith(".jsonl") and os.path.getmtime(path) >= since_s:
                    yield name, path
            except OSError:
                continue


def main():
    request = json.loads(sys.argv[1])
    since = float(request["since"])
    scopes = [posix(scope) for scope in request["scopes"] if posix(scope) != ""]
    prefixes = project_prefixes(scopes)
    sessions = []
    for root in request["dirs"]:
        if not os.path.isdir(root):
            continue
        titles = None
        for name, path in transcripts(root, since / 1000, prefixes):
            try:
                if name.startswith("rollout-"):
                    titles = codex_titles(root) if titles is None else titles
                    session = read_codex(path, since, titles)
                else:
                    session = read_claude(path, since)
            except OSError:
                continue
            prompts = session["prompts"]
            if len(prompts) > PROMPTS_HEAD + PROMPTS_TAIL:
                session["prompts"] = prompts[:PROMPTS_HEAD] + [f"…{len(prompts) - PROMPTS_HEAD - PROMPTS_TAIL} more…"] + prompts[-PROMPTS_TAIL:]
            if prompts and is_inside(session["cwd"], scopes):
                sessions.append(session)
    sessions.sort(key=lambda session: epoch_ms(session["start"]))
    json.dump(sessions, sys.stdout, ensure_ascii=False)


main()
