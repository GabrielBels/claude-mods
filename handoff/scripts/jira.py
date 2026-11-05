"""Prints one Jira ticket as JSON, for /handoff.

Usage: python3 -I jira.py '{"api": "<Jira REST API v3 base>", "key": "PROJ-1"}'

`api` is the REST API v3 base, e.g. https://<site>.atlassian.net/rest/api/3 or the Atlassian API gateway's
https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3. Credentials come from JIRA_API_EMAIL and JIRA_API_TOKEN, or
else from ~/.jira-cred ("email:token"); they are only sent to `api`. Rich text (ADF) is flattened to plain text.
Output: {key, summary, type, status, priority, assignee, parent, description, comments: [{author, created, text}]},
the latest comments oldest first. Exit 2 without credentials, 3 when Jira does not answer for the key.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_S = 20
DESCRIPTION_CHARS = 3000
COMMENT_CHARS = 500
COMMENTS = 6
FIELDS = "summary,issuetype,status,priority,assignee,parent,description,comment"


def credentials():
    email, token = os.environ.get("JIRA_API_EMAIL"), os.environ.get("JIRA_API_TOKEN")
    if email and token:
        return email, token
    try:
        with open(os.path.expanduser("~/.jira-cred"), encoding="utf-8") as f:
            email, _, token = f.read().strip().partition(":")
    except OSError:
        return None
    return (email, token) if email and token else None


def get(url, auth):
    request = urllib.request.Request(url, headers={"Authorization": auth, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        return None


BLOCKS = {"paragraph", "heading", "blockquote", "codeBlock", "rule", "panel", "tableRow", "mediaSingle"}


def adf_text(node):
    """Plain text of an Atlassian Document Format node: blocks on their own lines, list items as `- `."""
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return ""
    kind = node.get("type")
    attrs = node.get("attrs") or {}
    if kind == "text":
        return node.get("text", "")
    if kind == "hardBreak":
        return "\n"
    if kind in ("mention", "emoji", "status", "date"):
        return attrs.get("text") or attrs.get("shortName") or ""
    if kind in ("inlineCard", "blockCard"):
        return attrs.get("url", "")
    inner = "".join(adf_text(child) for child in node.get("content") or [])
    if kind == "listItem":
        return "- " + inner.strip() + "\n"
    if kind == "tableCell" or kind == "tableHeader":
        return inner.strip() + " | "
    if kind in BLOCKS:
        return inner.strip() + "\n"
    return inner


def tidy(text, limit):
    lines = [" ".join(line.split()) for line in text.splitlines()]
    text = "\n".join(line for line in lines if line != "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def name_of(field):
    return (field or {}).get("displayName") or (field or {}).get("name") or ""


def main():
    request = json.loads(sys.argv[1])
    api = request["api"].rstrip("/")
    key = request["key"]
    found = credentials()
    if found is None:
        sys.exit(2)
    email, token = found
    auth = "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()
    data = get(f"{api}/issue/{urllib.parse.quote(key)}?fields={FIELDS}", auth)
    fields = (data or {}).get("fields")
    if not isinstance(fields, dict):
        sys.exit(3)
    comments = ((fields.get("comment") or {}).get("comments") or [])[-COMMENTS:]
    parent = fields.get("parent") or {}
    json.dump(
        {
            "key": data.get("key") or key,
            "summary": fields.get("summary") or "",
            "type": name_of(fields.get("issuetype")),
            "status": name_of(fields.get("status")),
            "priority": name_of(fields.get("priority")),
            "assignee": name_of(fields.get("assignee")),
            "parent": f"{parent.get('key', '')} {((parent.get('fields') or {}).get('summary') or '')}".strip(),
            "description": tidy(adf_text(fields.get("description")), DESCRIPTION_CHARS),
            "comments": [
                {"author": name_of(c.get("author")), "created": (c.get("created") or "")[:10], "text": tidy(adf_text(c.get("body")), COMMENT_CHARS)}
                for c in comments
            ],
        },
        sys.stdout,
        ensure_ascii=False,
    )


main()
