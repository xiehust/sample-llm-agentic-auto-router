"""Pins and paths for DeepSWE v1.1 x Codex via Harbor (design §4–5).

Shared modules (proxy, auth, pricing, results, stats, routerlogs, codex_setup, common) are imported from
../codex-deepswe unchanged; `import hcommon` puts that directory on sys.path.
"""
from __future__ import annotations

import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
R2E = HERE.parent / 'codex-deepswe'
if str(R2E) not in sys.path:
    sys.path.insert(0, str(R2E))

RESULTS = HERE / 'results'      # gitignored: proxy call logs, ledger events, harvested rows, dry-run jobs
BIN = HERE / 'bin'              # gitignored: the pinned Codex binary (staged on the host, mounted read-only)

SEED = 20261105

# Released versions only (design §4.1). Harbor 0.25.0 is the last PyPI release (later builds are 0.25.1.devN).
HARBOR_VERSION = '0.25.0'
DATASET = {'repo': 'https://github.com/datacurve-ai/deep-swe', 'version': 'v1.1', 'license': 'Apache-2.0'}

# The proxy's address as seen from every compose network: docker0's address (bip pinned by the runner) and the
# port the runner firewall opens from the bridges (a3). An IP literal, so the egress sidecar needs no DNS.
PROXY_HOST = '172.17.0.1'
PROXY_PORT = 8088
CTR_CODEX = '/usr/local/bin/codex'  # bind-mount target; Harbor's install() returns early when `codex --version` matches

ARMS = ('A', 'F', 'C', 'B')
ARM_PIN = {'A': 'global.openai.gpt-6.1-sol', 'F': 'global.openai.gpt-6-luna', 'C': 'global.openai.gpt-6-astra', 'B': None}
DUMMY_KEY_ENV = 'LLMAR_DUMMY_KEY'
DUMMY_KEY = 'not-a-credential'      # the proxy drops it; the gateway token never enters a container
ONLINE_KEYS = ('ONLINE_NETWORK', 'ONLINE_DNS')   # runner env keys of the online network (a3); Harbor-free readers use this
NET_RECORD = 'llmar-net.json'       # trial dir: an online container's IP and host veth (llmar_env writes it; Harbor-free readers use this)


def codex_bin(arch: str = 'x86_64') -> pathlib.Path:
    import codex_setup

    return BIN / f"codex-{codex_setup.CODEX['version']}-{arch}"


# ---------------------------------------------------------------- Claude Code × Harbor (task 11-07-claude-code-harbor-eval)
# Native release build, pinned by the per-version release manifest's sha256 (0c's Q1, 2026-11-07). linux-arm64 is the
# dev box's capture build (same version); the runners mount the x64 pair through CTR_CLAUDE's wrapper.
CLAUDE_CODE = {
    'version': '2.1.318',
    'base_url': 'https://downloads.claude.ai/claude-code-releases',
    'sha256': {
        'linux-x64': '708c77b204db30086ff6f1ed34577bda03e1be74ced80557cbf7b54249ebf0bd',
        'linux-x64-musl': 'e6ff03823153a699d708c88c2fa87d18a1f6b45f13b14a985a221f8af442dd54',
        'linux-arm64': '53a0d7e219d7b0804ecba5dbc002745e89f786cc946d2de85a6470d5b2d1fb06',
        'linux-arm64-musl': 'a5ec862f882101dbe3e959ec166ab144e902a8e8e76215a2345b3860fe92ad28',
    },
}
CTR_CLAUDE = '/usr/local/bin/claude'          # a wrapper that execs the build that runs in the image (glibc, then musl)
CTR_CLAUDE_BUILDS = '/opt/llmar/claude'       # read-only mounts: <dir>/glibc and <dir>/musl
CC_MODELS = {'opus': 'global.anthropic.claude-opus-5-5', 'sonnet': 'global.anthropic.claude-sonnet-5-5',
             'haiku': 'global.anthropic.claude-haiku-5-5', 'fable': 'global.anthropic.claude-fable-5-1'}
# The client's main-loop model per arm. B runs A's client; the proxy rewrites B's Sonnet-named calls to `auto`.
CC_CLIENT_MODEL = {'A': CC_MODELS['sonnet'], 'B': CC_MODELS['sonnet'], 'C': CC_MODELS['opus'], 'F': CC_MODELS['haiku']}


def claude_platform(arch: str = 'x86_64', musl: bool = False) -> str:
    base = {'x86_64': 'linux-x64', 'amd64': 'linux-x64', 'aarch64': 'linux-arm64', 'arm64': 'linux-arm64'}[arch]
    return base + ('-musl' if musl else '')


def claude_bin(platform: str = 'linux-x64') -> pathlib.Path:
    if platform not in CLAUDE_CODE['sha256']:
        raise ValueError(f'unknown Claude Code platform {platform!r}')
    return BIN / f"claude-{CLAUDE_CODE['version']}-{platform}"
