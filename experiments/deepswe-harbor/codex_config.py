"""Codex config.toml for every arm (design §4.3): one custom provider pointing at the trial's proxy route.

Settings are the R2E pins (codex_setup.CODEX_SETTINGS) with reasoning effort high (user decision) and Harbor's own
`codex exec` flags. Identical for every arm: the arm only exists on the proxy side (the route's router hint), so the
container config differs between trials only in the route id inside base_url.

Any change here (features, skills, tools, settings) changes Codex's session-start request: re-capture it
(`cli.py dryrun --arms B --instruction-from <task dir>`, results/capture/) and send it to 73 before the pilot, so the
step 1 assessor cards stay comparable (73 checked the 2026-11-05 capture: card identical).
"""
from __future__ import annotations

import copy
import ipaddress
import urllib.parse
from typing import Any

import hcommon  # noqa: F401  (sys.path for codex-deepswe)
import codex_setup
from hcommon import DUMMY_KEY_ENV

PROVIDER_ID = 'llmar'
EFFORT = 'high'
# Same window and compaction for every arm (0d finding 3): with model = "auto" Codex cannot infer the window, so it
# is set explicitly, far below the smallest pool window (Sol 6.1: 1,000,000) and at the long-context price step.
CONTEXT_WINDOW = 272_000
AUTO_COMPACT = 200_000

# Features that reach the internet at startup in Codex 0.166.0 (found with a logging DNS stub, design §4.3): the
# curated-plugin sync (`plugins`: api.github.com, chatgpt.com/backend-api/plugins) and its prefetch. Off for every
# arm: on the runner every external lookup times out (~5 s each), and nothing may leave the container anyway.
OFFLINE_FEATURES = {'plugins': False, 'plugin_discovery_prefetch': False}

# Keys Harbor sets itself (`-c model_reasoning_effort=…` from the agent option; web_search from the network policy).
_HARBOR_OWNED = ('model_reasoning_effort', 'web_search')


def settings() -> dict[str, Any]:
    s = copy.deepcopy(codex_setup.CODEX_SETTINGS)
    for k in _HARBOR_OWNED:
        s.pop(k, None)
    s['features'] = {**s.get('features', {}), **OFFLINE_FEATURES}
    s['model_context_window'] = CONTEXT_WINDOW
    s['model_auto_compact_token_limit'] = AUTO_COMPACT
    return s


def config(base_url: str) -> dict[str, Any]:
    """The native Codex config (a JSON object Harbor converts to $CODEX_HOME/config.toml)."""
    u = urllib.parse.urlsplit(base_url)
    try:
        private = ipaddress.ip_address(u.hostname or '').is_private
    except ValueError:
        private = False
    if u.scheme != 'http' or not private or not u.port or not u.path.startswith('/r/'):
        # Containers reach only the proxy, by IP literal on the bridge (the sidecar has no DNS on the runner).
        raise ValueError('base_url must be the host proxy route http://<private-ip>:<port>/r/<trial>/v1')
    provider = {'name': 'llmar experiment proxy', 'base_url': base_url, 'env_key': DUMMY_KEY_ENV, 'wire_api': 'responses',
                **codex_setup.PROVIDER_SETTINGS}
    cfg: dict[str, Any] = {'model': 'auto', 'model_provider': PROVIDER_ID}
    cfg.update(settings())
    cfg['model_providers'] = {PROVIDER_ID: provider}
    return cfg


def summary() -> dict[str, Any]:
    """What every result row records about the agent settings (text-free)."""
    return {'version': codex_setup.CODEX['version'], 'effort': EFFORT, 'settings': settings(),
            'provider': dict(codex_setup.PROVIDER_SETTINGS)}
