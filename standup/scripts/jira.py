"""Prints where Jira tickets stand (status and assignee), as JSON, for /standup.

Usage: python3 -I jira.py '{"keys": ["PROJ-1", ...], "name": "<your name>"}'

Jira access comes from ~/.config/jira.json ({"apiBase", "email", "token"}, mode 600), with JIRA_API_BASE,
JIRA_API_EMAIL and JIRA_API_TOKEN over it; the credentials are only sent to apiBase. A ticket is yours when its assignee is the token's
account (/myself), or, when the token cannot read /myself, has the token's email or `name`.
Output: {key: {status, isDone, assignee, isMine}} for each key Jira answered; exit 2 when Jira is not configured.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

TIMEOUT_S = 20


CONFIG_PATH = os.path.expanduser("~/.config/jira.json")


def config():
    """(apiBase, email, token): JIRA_API_BASE, JIRA_API_EMAIL and JIRA_API_TOKEN over ~/.config/jira.json; None when incomplete."""
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            found = json.load(f)
    except (OSError, ValueError):
        found = {}
    api = os.environ.get("JIRA_API_BASE") or found.get("apiBase") or ""
    email = os.environ.get("JIRA_API_EMAIL") or found.get("email") or ""
    token = os.environ.get("JIRA_API_TOKEN") or found.get("token") or ""
    return (api.rstrip("/"), email, token) if api and email and token else None


def get(url, auth):
    request = urllib.request.Request(url, headers={"Authorization": auth, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.load(response)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def main():
    request = json.loads(sys.argv[1])
    found = config()
    if found is None:
        sys.exit(2)
    api, email, token = found
    auth = "Basic " + base64.b64encode(f"{email}:{token}".encode()).decode()
    name = (request.get("name") or "").strip().lower()
    me = (get(f"{api}/myself", auth) or {}).get("accountId")

    def issue(key):
        return key, get(f"{api}/issue/{urllib.parse.quote(key)}?fields=status,assignee", auth)

    tickets = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for key, data in pool.map(issue, request["keys"]):
            fields = (data or {}).get("fields")
            if not isinstance(fields, dict):
                continue
            status = fields.get("status") or {}
            assignee = fields.get("assignee") or {}
            if me:
                is_mine = assignee.get("accountId") == me
            else:
                is_mine = (assignee.get("emailAddress") or "").lower() == email.lower() or (name != "" and (assignee.get("displayName") or "").lower() == name)
            tickets[key] = {
                "status": status.get("name") or "",
                "isDone": (status.get("statusCategory") or {}).get("key") == "done",
                "assignee": assignee.get("displayName") or "",
                "isMine": is_mine,
            }
    json.dump(tickets, sys.stdout, ensure_ascii=False)


main()
