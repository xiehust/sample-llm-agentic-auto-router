"""Dataset × agent profiles for the orchestration code (TB design §6.2; Claude Code design §1.1): driver, fleet and
shardplan take `--dataset` (deepswe | tb21) and `--agent` (codex | claude-code), and everything that differs between
the runs comes from here. DEEPSWE and TB21 are the Codex profiles and hold exactly the constants those runs used, so
they reproduce them byte for byte (tests/test_golden_orchestration.py, tests/test_tb.py). CC_DEEPSWE and CC_TB21 are
the Claude Code profiles (`cc-deepswe`, `cc-tb21`): their own plans, results dirs (fresh proxy ledgers and caps),
the plan's data-driven arm table, the memory/OOM sampler, outcome-blind pilot output and the stage-continuity
pre-flight. Stdlib only: fleet.py imports it on the dev box."""
from __future__ import annotations

import dataclasses
import pathlib
from typing import Any

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
TB_HERE = REPO / 'experiments' / 'tbench-harbor'
CC_HERE = REPO / 'experiments' / 'claude-code-harbor'
AGENTS = ('codex', 'claude-code')


@dataclasses.dataclass(frozen=True)
class Dataset:
    name: str
    plan: pathlib.Path                 # the committed plan
    repo_url: str                      # the dataset repository (cloned on the runner at the plan's commit)
    checkout: str                      # its directory under WORK_DIR
    results: str                       # the results directory under WORK_DIR (attempts, jobs, proxy ledger, ...)
    exports: str                       # the export staging directory under WORK_DIR
    dev_results: pathlib.Path          # dev box: fleet mirrors, merged dataset, plan detail (gitignored)
    roots: tuple[str, ...]             # repository roots that `fleet.py pack` ships
    max_concurrency: int               # the most trials a runner may run at once
    wall_timeout_h: float | None       # the driver's watchdog; None: per task (agent + verifier + build + margin)
    taskpin: bool                      # 4f's taskpin: Harbor content digests and digest-pinned images
    online: bool                       # task containers have the internet (needs CONTAINER_EGRESS=internet)
    verifier_net_rule: bool            # classify rules (a)-(c) for a shared, internet-installing verifier
    check_slots: bool                  # §7.5 checks: 2 counted slots per kind, flaky_env, unverified nop
    cpu_budget: float | None           # admission: Σ declared cpus of running trials (None: count trials only)
    mem_budget_gb: float | None        # admission: Σ declared memory of running trials
    isolation_profile: str | None      # `isolation.py run --profile …` (None: DeepSWE's suite, no flag)
    lookupscan: bool                   # 4f's solution-lookup scanner at the end of every trial
    agent: str = 'codex'               # the agent in the trial container (AGENTS)
    base: str | None = None            # the dataset an agent variant runs ('deepswe' | 'tb21'); None: the profile is one
    job_config: str = 'harbor_job:job_config'                     # module:function building a trial's Harbor job config
    environment_config: str = 'harbor_job:environment_config'     # … and the oracle/null checks' environment section
    mem_watch: bool = False            # cgroup memory/swap/OOM sampler and the OOM victim per trial (Claude Code §2.4)
    blind: bool = False                # outcome-blind output: status, project and pilot print no reward or resolve
    continuity: bool = False           # stage 2 continues stage 1: plan, agent pin, router hash and concurrency must match
    record_digests: bool = False       # prepull records RepoDigests and reports changes against the previous prepull
    stage: str = 'stage-codex'         # `cli.py <stage> --arch x86_64` at setup: the agent binary, pinned by sha256

    @property
    def tasks_subdir(self) -> str:
        return f'{self.checkout}/tasks'

    @property
    def is_default(self) -> bool:
        return self.name == 'deepswe'


DEEPSWE = Dataset(
    name='deepswe', plan=HERE / 'plan.json', repo_url='https://github.com/datacurve-ai/deep-swe', checkout='deep-swe',
    results='results', exports='exports', dev_results=HERE / 'results',
    roots=('experiments/deepswe-harbor', 'experiments/codex-deepswe', 'packages/pricing/data'),
    max_concurrency=6, wall_timeout_h=5.0, taskpin=False, online=False, verifier_net_rule=False, check_slots=False,
    cpu_budget=None, mem_budget_gb=None, isolation_profile=None, lookupscan=False)

TB21 = Dataset(
    name='tb21', plan=TB_HERE / 'plan.json', repo_url='https://github.com/harbor-framework/terminal-bench-2-1',
    checkout='terminal-bench-2-1', results='tb21/results', exports='tb21/exports', dev_results=TB_HERE / 'results',
    roots=('experiments/deepswe-harbor', 'experiments/codex-deepswe', 'packages/pricing/data', 'experiments/tbench-harbor'),
    max_concurrency=8, wall_timeout_h=None, taskpin=True, online=True, verifier_net_rule=True, check_slots=True,
    cpu_budget=8.0, mem_budget_gb=48.0, isolation_profile='tb21', lookupscan=True)

_CC: dict[str, Any] = {'agent': 'claude-code', 'job_config': 'harbor_job_cc:job_config', 'environment_config': 'harbor_job_cc:environment_config',
                       'mem_watch': True, 'blind': True, 'continuity': True, 'stage': 'stage-claude-code'}
CC_DEEPSWE = dataclasses.replace(
    DEEPSWE, name='cc-deepswe', base='deepswe', plan=CC_HERE / 'deepswe' / 'plan.json', results='cc-deepswe/results',
    exports='cc-deepswe/exports', dev_results=CC_HERE / 'results' / 'deepswe',
    roots=(*DEEPSWE.roots, 'experiments/claude-code-harbor'), record_digests=True, **_CC)
CC_TB21 = dataclasses.replace(
    TB21, name='cc-tb21', base='tb21', plan=CC_HERE / 'tb21' / 'plan.json', results='cc-tb21/results', exports='cc-tb21/exports',
    dev_results=CC_HERE / 'results' / 'tb21', roots=(*TB21.roots, 'experiments/claude-code-harbor'), **_CC)

PROFILES = {p.name: p for p in (DEEPSWE, TB21, CC_DEEPSWE, CC_TB21)}
WATCHDOG_MARGIN_S = 1800.0             # per-task watchdog: agent + verifier + build timeouts + this


def get(name: str | None, agent: str | None = None) -> Dataset:
    """The profile of `--dataset name` (deepswe | tb21) with `--agent` (codex, the default, | claude-code). A full
    profile name (cc-deepswe) also works."""
    if agent not in (None, *AGENTS):
        raise SystemExit(f'unknown --agent {agent!r} (one of {", ".join(AGENTS)})')
    key = name or 'deepswe'
    if agent == 'claude-code' and not key.startswith('cc-'):
        key = f'cc-{key}'
    try:
        p = PROFILES[key]
    except KeyError:
        raise SystemExit(f'unknown --dataset {name!r} (one of deepswe, tb21)') from None
    if agent is not None and p.agent != agent:
        raise SystemExit(f'--dataset {name} is a {p.agent} profile, not --agent {agent}')
    return p


def load_attr(spec: str):
    """`module:function` (a profile's job_config / environment_config) → the callable."""
    import importlib
    mod, _, fn = spec.partition(':')
    return getattr(importlib.import_module(mod), fn)


def of_plan(plan: dict) -> str:
    """The dataset a plan belongs to: `dataset.name`; DeepSWE's frozen plan has none."""
    return str((plan.get('dataset') or {}).get('name') or 'deepswe')


def check_plan(profile: Dataset, plan: dict) -> None:
    if of_plan(plan) != profile.name:
        raise SystemExit(f'the plan is for dataset {of_plan(plan)!r}, not --dataset {profile.name}')
