#!/usr/bin/env python3
"""Write a message in the mail client; drafts by default, sends only with --send true."""
import argparse
import subprocess
import sys

TIMEOUT_S = 90


def escape(text):
    """Quote a string for AppleScript source."""
    return str(text).replace("\\", "\\\\").replace('"', '\\"')


def compose(to, subject, body, send):
    verb = "send msg" if send else "save msg"
    script = f'''
    tell application "Mail"
        set msg to make new outgoing message with properties ¬
            {{subject:"{escape(subject)}", content:"{escape(body)}", visible:true}}
        tell msg
            make new to recipient at end of to recipients ¬
                with properties {{address:"{escape(to)}"}}
        end tell
        {verb}
    end tell
    return "ok"
    '''
    try:
        done = subprocess.run(["osascript", "-e", script], capture_output=True,
                              text=True, timeout=TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return f"the mail client did not answer within {TIMEOUT_S}s"
    if done.returncode != 0:
        return (done.stderr or "the mail client refused the request").strip()
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--to", required=True, help="recipient email address")
    parser.add_argument("--subject", required=True)
    parser.add_argument("--body", required=True)
    parser.add_argument("--send", default="false",
                        help="true to send it, false to leave it as a draft")
    args = parser.parse_args()

    send = str(args.send).strip().lower() in ("true", "yes", "1")

    if "@" not in args.to:
        print(f"\"{args.to}\" is not an email address. Find the address first, "
              "then send to it.", file=sys.stderr)
        return 1

    why = compose(args.to, args.subject, args.body, send)
    if why:
        print(f"Could not write the message: {why}", file=sys.stderr)
        return 1

    print(f"{'Sent' if send else 'Drafted'}: to {args.to}, "
          f"subject \"{args.subject}\".")
    return 0


if __name__ == "__main__":
    sys.exit(main())
