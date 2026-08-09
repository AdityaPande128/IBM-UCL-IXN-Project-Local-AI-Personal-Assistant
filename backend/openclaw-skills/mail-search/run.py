#!/usr/bin/env python3
"""Find messages in the signed-in mail client.

Filtering is pushed into a single `whose` clause so Mail evaluates it
against its own index and a single Apple Event comes back.
"""
import argparse
import re
import subprocess
import sys

TIMEOUT_S = 180
PREVIEW_CHARS = 600


def run_applescript(source):
    try:
        done = subprocess.run(["osascript", "-e", source], capture_output=True,
                              text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None, f"the mail client did not answer within {TIMEOUT_S}s"
    if done.returncode != 0:
        return None, (done.stderr or "the mail client refused the request").strip()
    return done.stdout, None


def escape(text):
    """Quote a string for AppleScript source."""
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


def search(term, box, limit):
    """Search sender and subject as two indexed passes and merge the results."""
    where = "sent mailbox" if box == "sent" else "inbox"
    term = escape(term)

    script = f'''
    set out to ""
    set seen to {{}}
    tell application "Mail"
        set hits to (messages of {where} whose sender contains "{term}")
        try
            set more to (messages of {where} whose subject contains "{term}")
            set hits to hits & more
        end try
        set counted to 0
        repeat with m in hits
            if counted is greater than or equal to {limit} then exit repeat
            set mid to (id of m) as string
            if mid is not in seen then
                set seen to seen & mid
                set counted to counted + 1
                set theBody to ""
                try
                    set theBody to (content of m)
                end try
                if (count of theBody) > {PREVIEW_CHARS} then
                    set theBody to (text 1 thru {PREVIEW_CHARS} of theBody)
                end if
                set out to out & "\\n<<<MSG>>>\\n"
                set out to out & "date: " & ((date received of m) as string) & "\\n"
                set out to out & "from: " & (sender of m) & "\\n"
                try
                    set out to out & "to: " & (address of to recipient 1 of m) & "\\n"
                end try
                set out to out & "subject: " & (subject of m) & "\\n"
                set out to out & "body: " & theBody & "\\n"
            end if
        end repeat
    end tell
    return out
    '''
    return run_applescript(script)


OPERATOR = re.compile(r"^\s*(from|to|cc|bcc|subject|in|is|has|label)\s*:\s*", re.I)


def plain(query):
    """The name inside a search operator, or the query unchanged."""
    text = str(query or "").strip()
    while True:
        stripped = OPERATOR.sub("", text)
        if stripped == text:
            return stripped.strip().strip('"').strip()
        text = stripped


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True,
                        help="name, address or subject text to look for")
    parser.add_argument("--mailbox", default="inbox",
                        help="inbox for mail received, sent for mail the user sent")
    parser.add_argument("--limit", "--maxResults", "--max-results", type=int,
                        default=8, dest="limit")
    args = parser.parse_args()

    box = "sent" if str(args.mailbox).strip().lower().startswith("sent") else "inbox"
    raw, why = search(plain(args.query), box, max(1, min(args.limit, 25)))
    if why:
        print(f"Could not search the mailbox: {why}", file=sys.stderr)
        return 1

    blocks = [b.strip() for b in (raw or "").split("<<<MSG>>>") if b.strip()]
    if not blocks:
        print(f"No messages in the {box} match \"{args.query}\".")
        return 0

    print(f"{len(blocks)} message(s) in the {box} matching "
          f"\"{plain(args.query)}\", newest first:\n")
    for block in blocks:
        print(block)
        print("-" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
