"""Prints the Claude Code and Codex sessions that worked on a ticket, as JSON, for /handoff.

Usage: python3 -I sessions.py '{"key": "PROJ-1", "dirs": [...], "since": <epoch ms>, "exclude": "<session id>"}'

Each of `dirs` is a Claude Code projects folder (~/.claude/projects) or a Codex sessions folder (~/.codex/sessions).
A transcript touched since `since` counts when the key (any case) is in its branch, its title, one of the person's
prompts or one of the answers (a session that created the ticket names it only there); tool output alone does not count. `exclude` is the calling session, whose conversation /handoff already has. Only the person's prompts, the
session title and the last answer are read; tool output and subagent transcripts are not.
Output: [{source, cwd, branch, title, start, end, prompts, lastAnswer, answerMentions}], the latest sessions, oldest first.
"""

import json
import os
import re
import sys
from datetime import datetime

PROMPT_CHARS = 300
ANSWER_CHARS = 600
PROMPTS_HEAD = 6
PROMPTS_TAIL = 4
MAX_SESSIONS = 8
COMMAND = re.compile(r"<command-name>\s*(/?[^<\s]+)\s*</command-name>")
COMMAND_ARGS = re.compile(r"<command-args>([\s\S]*?)</command-args>")
REMINDER = re.compile(r"<system-reminder>[\s\S]*?</system-reminder>")
SKIPPED_COMMANDS = {"/model", "/clear", "/exit", "/resume", "/config", "/status", "/cost", "/compact", "/reload-plugins"}


def epoch_ms(stamp):
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000
    except (AttributeError, ValueError):
        return -1


def tidy(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


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
        return tidy(f"{name} {args.group(1) if args else ''}", PROMPT_CHARS)
    if text == "" or text.startswith("<") or text.startswith("[Request interrupted") or text.startswith("Caveat:"):
        return None
    return tidy(text, PROMPT_CHARS)


def claude_answer(content):
    if isinstance(content, str):
        return content
    return " ".join(block.get("text", "") for block in content or [] if isinstance(block, dict) and block.get("type") == "text")


def read_claude(path, key):
    session = {"source": "claude", "cwd": "", "branch": "", "title": "", "start": "", "end": "", "prompts": [], "lastAnswer": "", "answerMentions": 0}
    with open(path, "rb") as lines:
        for line in lines:
            is_title = b'"ai-title"' in line or b'"custom-title"' in line
            is_user = b'"type":"user"' in line and b'"tool_result"' not in line
            is_answer = b'"type":"assistant"' in line and b'"type":"text"' in line
            if not (is_title or is_user or is_answer):
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if is_title:
                session["title"] = row.get("customTitle") or row.get("aiTitle") or session["title"]
                continue
            if row.get("isMeta") or row.get("isSidechain") or row.get("isCompactSummary"):
                continue
            content = (row.get("message") or {}).get("content")
            if row.get("type") == "assistant":
                answer = claude_answer(content).strip()
                if answer:
                    session["lastAnswer"] = answer
                    session["answerMentions"] += key in answer.lower()
                continue
            if row.get("type") != "user":
                continue
            prompt = claude_prompt(content)
            if prompt is None:
                continue
            stamp = row.get("timestamp", "")
            session["start"] = session["start"] or stamp
            session["end"] = stamp or session["end"]
            session["cwd"] = row.get("cwd") or session["cwd"]
            session["branch"] = row.get("gitBranch") or session["branch"]
            session["prompts"].append(prompt)
    return session


def read_codex(path, titles, key):
    session = {"source": "codex", "cwd": "", "branch": "", "title": "", "start": "", "end": "", "prompts": [], "lastAnswer": "", "answerMentions": 0}
    with open(path, "rb") as lines:
        for line in lines:
            is_meta = b'"session_meta"' in line
            if not is_meta and b'"role":"user"' not in line and b'"role":"assistant"' not in line:
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
            if row.get("type") != "response_item" or payload.get("type") != "message":
                continue
            parts = payload.get("content") or []
            if payload.get("role") == "assistant":
                answer = " ".join(item.get("text", "") for item in parts if isinstance(item, dict) and item.get("type") == "output_text").strip()
                if answer:
                    session["lastAnswer"] = answer
                    session["answerMentions"] += key in answer.lower()
                continue
            text = " ".join(item.get("text", "") for item in parts if isinstance(item, dict) and item.get("type") == "input_text").strip()
            if text == "" or text.startswith("<") or text.startswith("# AGENTS.md"):
                continue
            session["start"] = session["start"] or row.get("timestamp", "")
            session["end"] = row.get("timestamp", "") or session["end"]
            session["prompts"].append(tidy(text, PROMPT_CHARS))
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


def mentions(path, needles):
    """Whether the raw transcript names the key at all, read in chunks so a large one is not held whole."""
    tail = b""
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                return False
            window = tail + chunk
            if any(needle in window for needle in needles):
                return True
            tail = window[-64:]


def transcripts(root, since_s, exclude):
    for folder, dirs, files in os.walk(root):
        dirs[:] = [name for name in dirs if name != "subagents"]
        for name in files:
            path = os.path.join(folder, name)
            if not name.endswith(".jsonl") or (exclude and exclude in name):
                continue
            try:
                if os.path.getmtime(path) >= since_s:
                    yield name, path
            except OSError:
                continue


def main():
    request = json.loads(sys.argv[1])
    key = request["key"]
    lower = key.lower()
    needles = [key.encode(), lower.encode()]
    since = float(request.get("since") or 0)
    exclude = request.get("exclude") or ""
    sessions = []
    for root in request["dirs"]:
        root = os.path.expanduser(root)
        if not os.path.isdir(root):
            continue
        titles = None
        for name, path in transcripts(root, since / 1000, exclude):
            try:
                if not mentions(path, needles):
                    continue
                if name.startswith("rollout-"):
                    titles = codex_titles(root) if titles is None else titles
                    session = read_codex(path, titles, lower)
                else:
                    session = read_claude(path, lower)
            except OSError:
                continue
            prompts = session["prompts"]
            named = lower in session["branch"].lower() or lower in session["title"].lower() or any(lower in prompt.lower() for prompt in prompts) or session["answerMentions"] > 0
            if not prompts or not named:
                continue
            if len(prompts) > PROMPTS_HEAD + PROMPTS_TAIL:
                session["prompts"] = prompts[:PROMPTS_HEAD] + [f"…{len(prompts) - PROMPTS_HEAD - PROMPTS_TAIL} more…"] + prompts[-PROMPTS_TAIL:]
            session["lastAnswer"] = tidy(session["lastAnswer"], ANSWER_CHARS)
            sessions.append(session)
    sessions.sort(key=lambda session: epoch_ms(session["end"] or session["start"]))
    json.dump(sessions[-MAX_SESSIONS:], sys.stdout, ensure_ascii=False)


main()
