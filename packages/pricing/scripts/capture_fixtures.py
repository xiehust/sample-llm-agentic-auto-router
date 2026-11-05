# /// script
# requires-python = ">=3.11"
# dependencies = ["botocore>=1.40"]
# ///
"""Capture real Bedrock usage fixtures for @auto-router/pricing (makes billed Bedrock calls).

  uv run packages/pricing/scripts/capture_fixtures.py --region <aws-region> [messages|chat|responses|kimi ...]

With no dialect named, captures messages, chat and responses; `kimi` (Kimi K3 on Chat Completions) is opt-in.

- Region: --region, else AWS_REGION; there is no default.
- Signs with botocore SigV4Auth (service "bedrock") using the default credential chain. AWS_BEARER_TOKEN_BEDROCK is
  removed from the environment and never used.
- Refuses to run unless sts:GetCallerIdentity returns the account in LLMAR_SPIKE_ACCOUNT (set it in your own,
  untracked env file, e.g. scripts/local.env). The id is never printed or written.
- Writes scrubbed fixtures (no account ids, request ids or response ids) to packages/pricing/src/__fixtures__.
  Review the diff before committing it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)

import botocore.session  # noqa: E402
from botocore.auth import SigV4Auth  # noqa: E402
from botocore.awsrequest import AWSRequest  # noqa: E402

REGION_RE = re.compile(r"[a-z]{2}(-[a-z]+)+-\d")
DIALECTS = ("messages", "chat", "responses", "kimi")
CLAUDE = "global.anthropic.claude-haiku-5-5"
GPT = "global.openai.gpt-6-luna"
KIMI = "global.moonshotai.kimi-k3"
OUT = Path(__file__).resolve().parent.parent / "src/__fixtures__"


class Client:
    """SigV4-signed POSTs to bedrock-runtime in one region."""

    def __init__(self, region: str) -> None:
        self.region = region
        self.host = f"https://bedrock-runtime.{region}.amazonaws.com"
        self.session = botocore.session.get_session()
        self.session.set_config_variable("region", region)
        self.creds = None

    def check_account(self, expected: str) -> None:
        acct = self.session.create_client("sts", region_name=self.region).get_caller_identity()["Account"]
        if not expected or acct != expected:
            sys.exit("refusing: caller account does not match LLMAR_SPIKE_ACCOUNT")
        print("account check ok")

    def post(self, path: str, body: dict, extra_headers: dict | None = None) -> tuple[int, str, str]:
        if self.creds is None:
            self.creds = self.session.get_credentials().get_frozen_credentials()
        url = self.host + path
        data = json.dumps(body).encode()
        headers = {"content-type": "application/json", **(extra_headers or {})}
        req = AWSRequest(method="POST", url=url, data=data, headers=headers)
        SigV4Auth(self.creds, "bedrock", self.region).add_auth(req)
        r = urllib.request.Request(url, data=data, headers=dict(req.headers.items()), method="POST")
        try:
            # The URL is https://bedrock-runtime.<validated region>.amazonaws.com<fixed path>; no user-supplied scheme.
            with urllib.request.urlopen(r, timeout=120) as resp:  # nosec B310
                return resp.status, resp.headers.get("content-type", ""), resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("content-type", ""), e.read().decode()


def prefix(tag: str, words: int) -> str:
    # Deterministic, unique-per-run static context; ~1.3 tokens per word.
    lines = [f"Reference note {i} for run {tag}: the quick brown fox number {i} jumps over lazy dog {i * 7 % 13}." for i in range(words // 16)]
    return "You are a terse assistant. Answer in one word.\n" + "\n".join(lines)


ID_RE = re.compile(r"\b(msg|chatcmpl|resp|rs|fc|call|req|toolu|item)([-_])[A-Za-z0-9_-]{6,}")
UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
ACCT_RE = re.compile(r"\b\d{12}\b")


def scrub(text: str) -> str:
    mapping: dict[str, str] = {}

    def sub_id(m: re.Match) -> str:
        key = m.group(0)
        if key not in mapping:
            mapping[key] = f"{m.group(1)}{m.group(2)}SCRUBBED{len(mapping) + 1}"
        return mapping[key]

    text = ID_RE.sub(sub_id, text)
    text = UUID_RE.sub("00000000-0000-0000-0000-000000000000", text)
    return ACCT_RE.sub("000000000000", text)


def save(dialect: str, case: str, status: int, ctype: str, body: str, stream: bool) -> None:
    d = OUT / dialect
    d.mkdir(parents=True, exist_ok=True)
    if status != 200:
        print(f"!! {dialect}/{case} HTTP {status}: {scrub(body[:400])}")
        (d / f"{case}.error.txt").write_text(scrub(body))
        return
    if stream:
        (d / f"{case}.sse.txt").write_text(scrub(body))
    else:
        (d / f"{case}.json").write_text(json.dumps(json.loads(scrub(body)), indent=2) + "\n")
    usage_line = body if not stream else "\n".join(line for line in body.splitlines() if "usage" in line)[-600:]
    m = re.findall(r'"usage"\s*:\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', usage_line)
    print(f"ok {dialect}/{case} ({ctype}): {m[-1] if m else 'NO USAGE FOUND'}")


def messages(c: Client, case: str, text: str, stream: bool, ttl: str | None = None) -> None:
    cc = {"type": "ephemeral", **({"ttl": ttl} if ttl else {})}
    body = {
        "model": CLAUDE,
        "max_tokens": 32,
        "system": [{"type": "text", "text": text, "cache_control": cc}],
        "messages": [{"role": "user", "content": "Say ok."}],
        **({"stream": True} if stream else {}),
    }
    save("anthropic-messages", case, *c.post("/anthropic/v1/messages", body, {"anthropic-version": "2023-06-01"}), stream)


def chat(c: Client, case: str, text: str, stream: bool, include_usage: bool = True, model: str = GPT) -> None:
    body: dict = {
        "model": model,
        "max_completion_tokens": 64,
        "reasoning_effort": "none",
        "messages": [
            {"role": "developer", "content": [{"type": "text", "text": text, "prompt_cache_breakpoint": {"mode": "explicit"}}]},
            {"role": "user", "content": "Say ok."},
        ],
    }
    if stream:
        body["stream"] = True
        if include_usage:
            body["stream_options"] = {"include_usage": True}
    save("openai-chat", case, *c.post("/openai/v1/chat/completions", body), stream)


def responses(c: Client, case: str, text: str, stream: bool) -> None:
    body = {
        "model": GPT,
        "store": False,
        "max_output_tokens": 64,
        "reasoning": {"effort": "none"},
        "input": [
            {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": text, "prompt_cache_breakpoint": {"mode": "explicit"}}]},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Say ok."}]},
        ],
        **({"stream": True} if stream else {}),
    }
    save("openai-responses", case, *c.post("/openai/v1/responses", body), stream)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", ""), help="AWS Region (default: AWS_REGION; required)")
    ap.add_argument("dialects", nargs="*", metavar="dialect", help=f"any of {', '.join(DIALECTS)}")
    args = ap.parse_args()
    if not args.region:
        ap.error("no region: pass --region <aws-region> or set AWS_REGION")
    if not REGION_RE.fullmatch(args.region):
        ap.error(f"not an AWS region: {args.region}")
    bad = sorted(set(args.dialects) - set(DIALECTS))
    if bad:
        ap.error(f"unknown dialect(s): {', '.join(bad)} (choose from {', '.join(DIALECTS)})")

    c = Client(args.region)
    c.check_account(os.environ.get("LLMAR_SPIKE_ACCOUNT", ""))
    print(f"region {args.region}")
    run = str(int(time.time()))
    only = set(args.dialects)
    if not only or "messages" in only:
        a, b, d = prefix(f"{run}-ma", 1200), prefix(f"{run}-mb", 1200), prefix(f"{run}-mc", 1200)
        messages(c, "nonstream-write", a, False)
        messages(c, "nonstream-read", a, False)
        messages(c, "stream-read", a, True)
        messages(c, "stream-write", b, True)
        messages(c, "nonstream-write-1h", d, False, ttl="1h")
    if not only or "chat" in only:
        a, b = prefix(f"{run}-ca", 1800), prefix(f"{run}-cb", 1800)
        chat(c, "nonstream-write", a, False)
        chat(c, "nonstream-read", a, False)
        chat(c, "stream-read", a, True)
        chat(c, "stream-write", b, True)
        chat(c, "stream-no-include-usage", a, True, include_usage=False)
    if "kimi" in only:  # opt-in only
        a = prefix(f"{run}-ka", 1800)
        chat(c, "kimi-k3-nonstream-write", a, False, model=KIMI)
        chat(c, "kimi-k3-nonstream-read", a, False, model=KIMI)
        chat(c, "kimi-k3-stream-read", a, True, model=KIMI)
    if not only or "responses" in only:
        a, b = prefix(f"{run}-ra", 1800), prefix(f"{run}-rb", 1800)
        responses(c, "nonstream-write", a, False)
        responses(c, "nonstream-read", a, False)
        responses(c, "stream-read", a, True)
        responses(c, "stream-write", b, True)


if __name__ == "__main__":
    main()
