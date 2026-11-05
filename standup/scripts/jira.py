"""Prints where Jira tickets stand (status and assignee), as JSON, for /standup.

Usage: python3 -I jira.py '{"api": "<Jira REST API v3 base>", "keys": ["PROJ-1", ...], "name": "<your name>"}'

`api` is the REST API v3 base, e.g. https://<site>.atlassian.net/rest/api/3 or the Atlassian API gateway's
https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3. Credentials come from JIRA_API_EMAIL and JIRA_API_TOKEN, or
else from ~/.jira-cred ("email:token"); they are only sent to `api`. A ticket is yours when its assignee is the token's
account (/myself), or, when the token cannot read /myself, has the token's email or `name`.
Output: {key: {status, isDone, assignee, isMine}} for each key Jira answered; exit 2 without credentials.
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


def main():
    request = json.loads(sys.argv[1])
    api = request["api"].rstrip("/")
    found = credentials()
    if found is None:
        sys.exit(2)
    email, token = found
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
