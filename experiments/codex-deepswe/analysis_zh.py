"""Written analysis for the zh-CN report (report.render calls it). Every number is read from report-data.json.

The wording states conclusions that hold for the recorded run (e.g. "F is worse than A, the CI excludes 0"). checks()
lists each such premise; when the data no longer satisfies one, the report says so at the top instead of silently
printing a stale conclusion. No dataset text: ids, codes and numbers only.
"""
from __future__ import annotations

from typing import Any

import report as R

SOL, LUNA, ASTRA = 'Sol', 'Luna', 'Astra'


def _g(d: dict[str, Any] | None, *path: str, default: Any = None) -> Any:
    for k in path:
        if not isinstance(d, dict) or k not in d:
            return default
        d = d[k]
    return d


def _pp(x: float | None) -> str:
    return '—' if x is None else f'{100 * x:+.1f} pp'


def _ci_pp(ci: Any) -> str:
    return '—' if not ci else f'[{100 * ci[0]:.1f}, {100 * ci[1]:.1f}]'


def _r(x: float | None, d: int = 3) -> str:
    return R._num(x, d)


def _cost_ci(c: dict[str, Any] | None, d: int = 3) -> str:
    if not c:
        return '—'
    ci = c.get('ci')
    return f"{c['point']:.{d}f}" + ('' if R._degenerate(ci) else f" [{ci[0]:.{d}f}, {ci[1]:.{d}f}]")


def _zero_disc(x: dict[str, Any] | None) -> bool:
    return bool(x) and x['resolve']['a_only'] + x['resolve']['b_only'] == 0


def checks(data: dict[str, Any]) -> list[str]:
    """Premises the written text relies on; returns the ones the data does not satisfy."""
    fa, ca, ba, da = (data.get(f'{a}_vs_A') for a in 'FCBD')
    tr = data.get('transparency') or {}
    asr = data.get('assessor') or {}
    want = [
        (bool(fa) and fa['resolve']['ci'][1] < 0, 'F vs A：解决率差的 CI 整体小于 0'),
        (bool(fa) and not _g(fa, 'noninferiority', 'noninferior'), 'F vs A：10 pp 非劣效未被证明'),
        (bool(fa) and fa['resolve']['p_mcnemar'] < 0.025, 'F vs A：McNemar p < 0.025（两个主要问题的 Bonferroni 校正）'),
        (_zero_disc(ca), 'C vs A：0 个不一致对'),
        (_zero_disc(ba) and _zero_disc(da), 'B vs A、D vs A：0 个不一致对'),
        (bool(asr) and set(asr.get('tier') or {}) == {'standard'}, 'B 组评估器每次都给出 standard'),
        (all((t.get('cache_retention') or 0) >= 0.999 and not t['gateway_fallback_calls'] and not t['router_failovers'] and not t['proxy_refused']
             for t in tr.values()), '各组缓存保留率 ≈ 100%，无 fallback / failover / 代理拒绝'),
        (_g(data, 'repeats', 'A', 'pair_disagreement') == 0, 'A 在重复阶段没有任务翻转'),
    ]
    return [msg for ok, msg in want if not ok]


def _net(fa: dict[str, Any]) -> tuple[int, float | None]:
    r = fa['resolve']
    net = r['a_only'] - r['b_only']
    return net, (r['n'] / net if net > 0 else None)


def summary(data: dict[str, Any]) -> list[str]:
    fa, ca, ba, da = (data.get(f'{a}_vs_A') for a in 'FCBD')
    asr = data.get('assessor') or {}
    out: list[str] = []
    n_main = _g(data, 'selection_facts', 'n_main', default=_g(fa, 'n'))
    out.append(f'在 {n_main} 个 Python 仓库的问题修复任务上（R2E-Gym，Codex CLI 驱动，按隐藏测试判定是否解决），比较了 Codex 固定使用三个 tier 的模型、'
               '经路由器自动选择、以及直连 Bedrock 的结果与费用。结论如下。')
    out.append('')
    if fa:
        r = fa['resolve']
        net, every = _net(fa)
        out.append(f"1. **fast 便宜得多，但不够用。** fast 模型 {LUNA}（F 组）解决 {R._pct(r['rate_b'])}，standard 模型 {SOL}（A 组）解决 {R._pct(r['rate_a'])}，"
                   f"差 {_pp(r['diff'])}（95% CI {_ci_pp(r['ci'])} pp，McNemar p = {R._p(r['p_mcnemar'])}）。"
                   f"{r['a_only']} 个任务只有 Sol 解决，{r['b_only']} 个只有 Luna 解决，净少 {net} 个"
                   + (f'，约每 {every:.0f} 个任务少解决 1 个' if every else '') +
                   f"。Luna 的总费用是 Sol 的 {_r(fa['cost']['ratio_of_sums']['point'])}（约 1/{1 / fa['cost']['ratio_of_sums']['point']:.0f}）。"
                   '10 pp 的非劣效没有被证明。')
    if ca:
        r = ca['resolve']
        out.append(f"2. **frontier 在这组任务上没有带来收益。** {r['n']} 个任务上 frontier 模型 {ASTRA}（C 组）与 Sol 逐任务结果相同"
                   f"（都解决 {r['both']} 个，都失败 {r['neither']} 个，0 个不一致对），费用是 {ca['cost']['ratio_of_sums']['point']:.1f} 倍。"
                   f"在这组任务上 frontier 提升超过约 {100 * R.zero_upper(r['n']):.0f} pp 不太可能；失败的 {r['neither']} 个任务 Luna 也没有解决。")
    rp = data.get('repeats') or {}
    if rp.get('A') and rp.get('F') and fa:
        out.append(f"3. **这个差距不是运行间波动。** 同一任务重复跑 3 次，Sol 在 {rp['A']['tasks']} 个任务上翻转 {rp['A'].get('mixed_tasks', 0)} 个，"
                   f"Luna 翻转 {rp['F'].get('mixed_tasks', 0)} 个（成对不一致率上界分别约 {100 * R.noise_upper(rp['A']):.0f}% 和 {100 * R.noise_upper(rp['F']):.0f}%）。F 与 A 的不一致对是 {fa['resolve']['a_only']} 比 {fa['resolve']['b_only']} 的单向偏斜，"
                   '而波动产生的不一致在两个方向上是对称的。')
    ir = _g(data, 'ideal_router', 'F_A')
    if ir and fa:
        vs = ir['vs']['always_sol']
        fr = fa['resolve']
        out.append(f"4. **逐任务选对 tier 能省很多，但现在拿不到。** 事后看，每个任务都用能解决它的最便宜模型（都没解决时用最便宜的；{ir['choice_counts'].get('F', 0)} 个用 Luna、"
                   f"{ir['choice_counts'].get('A', 0)} 个用 Sol），可解决 {ir['ideal']['solved']} 个，费用只有一直用 Sol 的 {_r(vs['cost_ratio']['point'], 2)}。"
                   f"但这需要预先知道哪 {fr['a_only']} 个任务（{R._pct(fr['a_only'] / fr['n'], 0)}）只有 Sol 能解决。"
                   f"评估器（v2.1）在会话开始从不给出 fast（离线 tier pass {_g(data, 'tierpass', 'n', default='—')} 个候选、B 组 {_g(asr, 'runs', default='—')} 个会话），所以这部分节省一点也没拿到。")
    if ba and da:
        out.append(f"5. **没有观察到路由器对结果或缓存的影响。** 同一个 Sol 经路由器自动选择（B 组，{ba['n']} 个任务）、经路由器固定（A 组）、直连 Bedrock（D 组，{da['n']} 个任务），"
                   '逐任务结果相同；各组缓存保留率 100%，没有网关 fallback、路由 failover 或代理拒绝；路由器每个请求的开销中位数 '
                   f"{_r(_g(data, 'timing', 'A', 'router_overhead_ms_p50'), 0)} ms。评估器每个会话调用一次，"
                   f"增加约 {_r((_g(asr, 'latency_ms', 'p50') or 0) / 1000, 1)} s 延迟和 {R._pct(asr.get('cost_share_of_arm'))} 的费用。")
    eo = data.get('escalation_oracle')
    if eo:
        out.append(f"6. **对路由策略的含义。** 对这类任务，省钱的空间在 fast 一侧，不在 frontier。值得试的是“先用 fast，有失败信号再升级到 standard”："
                   f"如果能在 Luna 运行结束时可靠地判断失败，本数据上这种策略可解决 {eo['solved']} 个任务，费用是一直用 Sol 的 {_r(eo['cost_ratio_vs_always_sol'], 2)}。"
                   'Luna 失败的运行在调用次数、失败命令数等表面特征上与成功的运行差不多，可靠的失败信号是下一步要验证的（第 7 节）。')
    c = _g(data, 'ledger', 'committed') or {}
    if c:
        rn = data.get('runner') or {}
        out.append(f"7. **花费。** 模型费用：主阶段 ${c.get('main', 0):.2f}，重复阶段 ${c.get('repeat', 0):.2f}，离线 tier pass ${c.get('tierpass', 0):.2f}，"
                   f"试点账本记 ${c.get('pilot', 0):.2f}" + (f"（高估，实际约 ${_g(data, 'pilot', 'real_usd'):.2f}）" if _g(data, 'pilot', 'real_usd') is not None else '（高估，见第 6 节）') + f"；runner 约 {rn.get('hours', 0):.1f} 小时"
                   + (f"（${rn['usd']:.2f}）" if rn.get('usd') is not None else '（费率未记录，未计入）') + '。')
    return out


def setup(data: dict[str, Any]) -> list[str]:
    sel = data['selection']
    sf = data.get('selection_facts') or {}
    rules = sf.get('rules') or {}
    cap = sf.get('repo_cap_effect') or {}
    bound = ', '.join(f'{k}（跳过 {v} 个）' for k, v in sorted((cap.get('skipped_by_repo') or {}).items())) or '无'
    sizes = sf.get('size_counts') or {}
    rep = sf.get('repeat_size_counts') or {}
    v = data.get('validation') or {}
    return [
        f"- 任务：{sel['dataset']['repo']}@{sel['dataset']['revision'][:12]}（{sel['dataset']['license']}）。从 {_g(data, 'tierpass', 'n', default='—')} 个候选的种子随机顺序中依次取通过 gold 验证的任务，"
        f"得到 {sf.get('n_main')} 个主任务（规模 small {sizes.get('small', 0)} / medium {sizes.get('medium', 0)} / large {sizes.get('large', 0)}）"
        f"和 {sf.get('n_pilot')} 个试点任务（试点不进入分析）。每个仓库最多 {rules.get('repo_cap')} 个（{R._pct(rules.get('repo_cap_frac'), 0)}），"
        f"只有 {bound} 触到这个上限。",
        f"- 验证：每个任务在干净容器里各跑 3 次 base 与 gold，用多数一致的测试结果推出 F2P/P2P；共验证 {v.get('validated')} 个，"
        f"{v.get('validated', 0) - v.get('ok', 0)} 个未通过（gold 不稳定或不能严格通过），按同一顺序替换（{sf.get('replacements')} 次）。",
        f"- 子集：C、B、D 组从主任务中按规模分层抽取（{', '.join(f'{a} {sum(c.values())}' for a, c in sorted((sf.get('subset_size_counts') or {}).items()))}）；"
        f"重复阶段的 {sum(rep.values())} 个任务也按规模分层抽取（{' / '.join(f'{k} {v}' for k, v in sorted(rep.items()))}），A、F 各再跑 2 次。",
        '- Codex：CLI 0.166.0（固定版本与 sha256），reasoning medium，`codex exec` 非交互、无审批，单次运行上限 2400 s；容器 2 CPU / 8 GB，'
        '没有出网路由，只能经宿主机上的代理访问网关或 bedrock-runtime（路径与模型白名单，按运行限额）。',
        '- 评分：SWE-bench 方式，在新容器里应用补丁（去掉测试文件与构建产物）后运行隐藏测试，F2P 与 P2P 全部通过才算解决；R2E 严格判定作为次要指标。'
        '开始前从镜像的 git 历史中移除了修复提交（见第 5 节）。',
    ]


def primary(data: dict[str, Any]) -> list[str]:
    fa, ca = data.get('F_vs_A'), data.get('C_vs_A')
    out: list[str] = []
    if fa:
        r = fa['resolve']
        half = (r['ci'][1] - r['ci'][0]) / 2
        out.append(f"**F vs A（fast 是否够用）。** F 比 A 低 {abs(100 * r['diff']):.1f} pp，95% CI {_ci_pp(r['ci'])} pp 不含 0；"
                   f"McNemar p = {R._p(r['p_mcnemar'])}，按两个主要问题做 Bonferroni 校正（α = 0.025）后仍然显著。"
                   f"10 pp 的非劣效没有被证明（CI 下界 {100 * r['ci'][0]:.1f} 低于 −10），但点估计在界内，所以也不能说 F 比 A 差 10 pp 以上。"
                   f"总成本比 ΣF/ΣA = {_cost_ci(fa['cost']['ratio_of_sums'])}，$/解决比 {_cost_ci(fa.get('usd_per_solved_ratio'))}。"
                   f"实际不一致率 {R._pct(r['discordance'])}，低于计划时假设的 20%，所以 CI 比计划窄（半宽约 ±{100 * half:.1f} pp）。")
        by = data.get('F_vs_A_by_size') or {}
        if by:
            parts = [f"{k} {_pp(v['resolve']['diff'])}（n = {v['n']}）" for k in ('small', 'medium', 'large') if (v := by.get(k))]
            out += ['', f"按规模看（描述性，不做推断）：{'，'.join(parts)}，方向一致；large 只有 {_g(by, 'large', 'n', default=0)} 个任务。"]
    if ca:
        r = ca['resolve']
        sp = ca.get('same_patch_stats') or {}
        ub = R.zero_upper(r['n'])
        out += ['', f"**C vs A（frontier 是否值得）。** {r['n']} 个任务上 C 与 A 逐任务结果相同：{r['both']} 个都解决，{r['neither']} 个都失败，0 个不一致对。"
                f"这不是同一份结果被复用：两组是不同模型在不同容器里的独立运行，{sp.get('n')} 对中有 {sp.get('n', 0) - sp.get('same', 0)} 对补丁的大小统计"
                f"（文件、增删行数、字节数）不同，其余 {sp.get('same')} 对相同。"
                f"预注册的 Newcombe 区间是 {_ci_pp(r['ci'])} pp，但不一致对为 0 时这个区间按条件读会偏窄；直接从数据看，0/{r['n']} 不一致对给出不一致率的 "
                f"95% Wilson 上界 {R._pct(ub)}，所以 |C − A| < {100 * ub:.1f} pp。等价地说，若 frontier 真能多解决 5 pp（3 个任务），"
                '本实验约有 95% 的概率至少看到一个不一致对。'
                f"结论是：n = {r['n']} 时没有检测到差异，在这组任务上 frontier 提升超过约 {100 * ub:.0f} pp 不太可能。这不是“等价”，C 也没有预注册非劣效检验。"
                f"成本比 ΣC/ΣA = {_cost_ci(ca['cost']['ratio_of_sums'], 2)}；解决数相同，所以 $/解决比与成本比相同（B、D 同理）。"
                '两个主要问题中，F vs A 经校正后仍显著，C vs A 没有需要校正的阳性结果。']
    rp = data.get('repeats') or {}
    if rp.get('A') and rp.get('F') and fa:
        a, f = rp['A'], rp['F']
        mean = (a['pair_disagreement'] + f['pair_disagreement']) / 2
        out += ['', f"**运行间噪声。** {a['tasks']} 个重复任务各跑 3 次：A 翻转 {a.get('mixed_tasks', 0)} 个任务（成对不一致率 "
                f"{R._pct(a['pair_disagreement'])}，上界约 {100 * R.noise_upper(a):.0f}%），F 翻转 {f.get('mixed_tasks', 0)} 个（{R._pct(f['pair_disagreement'])}，"
                f"上界约 {100 * R.noise_upper(f):.0f}%）。纯噪声基准是两者的均值 {R._pct(mean)}；"
                f"F vs A 的不一致率是 {R._pct(fa['resolve']['discordance'])}（同一批重复任务上 {R._pct(_g(data, 'F_vs_A_on_repeat_tasks', 'discordance'))}）。"
                '20 个任务上的上界很宽，单看比例分不清噪声占多少；但噪声产生的不一致对在两个方向上是对称的，'
                f"而 F vs A 是 {fa['resolve']['a_only']} 比 {fa['resolve']['b_only']}，这种偏斜就是组间差异，McNemar 检验在有噪声时仍然有效。"]
    return out


def ideal(data: dict[str, Any]) -> list[str]:
    ir = data.get('ideal_router') or {}
    fa = data.get('F_vs_A')
    v = ir.get('F_A')
    out: list[str] = []
    if v and fa:
        vs = v['vs']['always_sol']
        f_cost, a_cost = fa['cost']['sum_b'], fa['cost']['sum_a']
        f_rate = fa['resolve']['rate_b']
        out.append(f"**理想路由需要预知结果。** 它在 {v['choice_counts'].get('F', 0)} 个任务上用 Luna、{v['choice_counts'].get('A', 0)} 个用 Sol，"
                   f"解决 {v['ideal']['solved']} 个，比一直用 Sol 多 {v['ideal']['solved'] - fa['resolve']['rate_a'] * fa['n']:.0f} 个"
                   f"（{_pp(vs['resolve_diff']['diff'])}，{_ci_pp(vs['resolve_diff']['ci'])} pp，下界 0 由构造决定；多出的是只有 Luna 解决的 {fa['resolve']['b_only']} 个任务，"
                   f"与 Luna 自身的运行间波动同一量级），费用是一直用 Sol 的 {_cost_ci(vs['cost_ratio'], 2)}，即约省 {100 * (1 - vs['cost_ratio']['point']):.0f}%。"
                   f"与一直用 Luna 相比，它多 {100 * (v['ideal']['rate'] - f_rate):.1f} pp 解决率，费用是 {v['ideal']['cost'] / f_cost:.1f} 倍。"
                   f"要做到这一点，路由器必须在开始前认出那 {fa['resolve']['a_only']} 个只有 Sol 能解决的任务；"
                   f"评估器的实际选择等于一直用 Sol（解决 {_g(v, 'vs', 'assessor_choice', 'solved')} 个，${a_cost:.2f}），一点节省也没拿到。")
        out.append('')
    c3 = ir.get('F_A_C')
    if c3:
        nab = _g(ir, 'noise_A_B', 'n')
        out.append(f"在 C 子集上加入 Astra 也不改变理想选择：Astra 一次也没被选中（{R._counts(c3['choice_counts'])}），没有额外解决的任务。"
                   + (f"A/B 两次 Sol 运行的理想组合也没有额外解决（0/{nab}），所以在这批任务上看不到 oracle 因运行噪声而膨胀。" if nab else ''))
        out.append('')
    eo = data.get('escalation_oracle')
    fs = data.get('failure_signals') or {}
    if eo:
        ok, bad = fs.get('F_solved') or {}, fs.get('F_failed_A_solved') or {}
        out.append(f"**升级策略不需要预知，但需要可靠的失败信号。** 先用 Luna、失败后再用 Sol（假设失败能在运行结束时被完美识别），"
                   f"会在 {eo['escalated']} 个任务上再跑一次 Sol，解决 {eo['solved']} 个，费用是一直用 Sol 的 {_r(eo['cost_ratio_vs_always_sol'], 2)}"
                   f"（一直用 Luna 的 {_r(eo['cost_ratio_vs_always_luna'], 1)} 倍）。这比理想路由贵，因为每个失败都要先付一次 Luna，"
                   f"而且 {eo['escalated'] - (fa['resolve']['a_only'] if fa else 0)} 次升级再跑也没解决。"
                   + (f"从这些粗特征看分不出哪些 Luna 运行会失败：只有 Sol 能解决的任务上，Luna 运行的模型调用中位数 {_r(bad.get('calls_p50'), 0)}、"
                      f"失败命令中位数 {_r(bad.get('commands_failed_p50'), 0)}，与 Luna 成功的运行（{_r(ok.get('calls_p50'), 0)}、{_r(ok.get('commands_failed_p50'), 0)}）相同；"
                      f"只是输出 token（{_r(bad.get('output_tokens_p50'), 0)} vs {_r(ok.get('output_tokens_p50'), 0)}）与墙钟略多。" if ok and bad else ''))
    return out


def router_path(data: dict[str, Any]) -> list[str]:
    ba, da = data.get('B_vs_A'), data.get('D_vs_A')
    asr = data.get('assessor') or {}
    tp = data.get('tierpass') or {}
    out: list[str] = []
    if asr:
        la = asr['latency_ms']
        out.append(f"**评估器。** B 组 {asr['runs']} 个会话各在开始时咨询一次评估器，全部返回 ok，给出的 tier 都是 standard，置信度 "
                   f"{_r(asr['confidence']['min'], 2)}–{_r(asr['confidence']['max'], 2)}。standard 就是默认 tier，所以决策没有改变（路由日志 applied=false），"
                   f"B 组全部由 Sol 服务。这与离线 tier pass 一致：{tp.get('n', '—')} 个候选上评估器从未给出 fast 或 frontier。"
                   f"路由器内实测延迟中位数 {_r(la['p50'], 0)} ms（{la['min']}–{la['max']} ms），比开发机上的 tier pass（p50 {_g(tp, 'latency_ms', 'p50')} ms）快；"
                   f"按原来的 1500 ms 超时仍有 {la['n'] - la['within_1500']}/{la['n']} 会超时，按主运行的 5000 ms 全部在时限内。"
                   f"这次等待只发生在每个会话的第一个请求上。评估器总费用 ${asr['cost_usd']:.3f}。")
        out.append('')
    if ba:
        r = ba['resolve']
        out.append(f"**B vs A（描述性）。** {r['n']} 个任务上逐任务结果相同（0/{r['n']} 不一致，差在 ±{100 * R.zero_upper(r['n']):.1f} pp 内），"
                   f"总成本比 {_cost_ci(ba['cost']['ratio_of_sums'])}。B 的费用包含评估器调用（占 {R._pct(asr.get('cost_share_of_arm'))}），"
                   f"其余差异来自 Codex 每次运行的轮数不同。n = {r['n']} 时没有检测到经路由器自动选择带来的收益或损失。")
        out.append('')
    if da:
        r = da['resolve']
        cs = da.get('calls_sum') or {}
        sh = _g(da, 'cost', 'share_top5_a')
        cr = da['cost']['ratio_of_sums']
        out.append(f"**D vs A（描述性）。** 直连 bedrock-runtime（不经网关和路由器）的 {r['n']} 个任务上结果相同（0/{r['n']} 不一致，"
                   f"差在 ±{100 * R.zero_upper(r['n']):.1f} pp 内；一个任务翻转就会让 D 的解决率变 {100 / r['n']:.0f} pp）。"
                   f"D 的总费用高 {100 * (cr['point'] - 1):.1f}%（总成本比 {_cost_ci(cr)}，bootstrap CI；n = {r['n']}"
                   + (f" 且前 5 个任务占 A 费用的 {R._pct(sh, 0)}" if sh is not None else '') + "，这个区间不可靠）。"
                   f"两组单价相同（A 组的代理计价与路由器日志计价在每个运行上一致），D 多 {_g(cs, 'D', 'calls', default=0) - _g(cs, 'A', 'calls', default=0)} 次模型调用"
                   f"（{_g(cs, 'D', 'calls')} vs {_g(cs, 'A', 'calls')}）、提示 token 多 "
                   f"{R._pct((_g(cs, 'D', 'prompt_tokens', default=0) / _g(cs, 'A', 'prompt_tokens', default=1)) - 1, 0)}，与 Codex 轮数的波动一致；"
                   f"n = {r['n']} 不足以判断费用差的来源。直连不经路由器，所以这个差异不是路由器开销。")
    return out


def transparency(data: dict[str, Any]) -> list[str]:
    tr = data.get('transparency') or {}
    tm = data.get('timing') or {}
    h = data.get('history') or {}
    net = {a: t['network_commands'] for a, t in tr.items() if t['network_commands']}
    mx = max((t['router_overhead_ms_max_excl_assessor'] for t in tm.values() if t.get('router_overhead_ms_max_excl_assessor') is not None), default=None)
    out = ["- 缓存：同一模型的相邻调用应读到的缓存都读到了（保留率 100%），没有缓存丢失事件；每个运行的第一次调用缓存读为 0，说明运行之间没有共享缓存。",
           '- 路由器没有改变任何请求的服务模型：没有网关 fallback、路由 failover 或代理拒绝'
           + ('，所有调用都是 HTTP 200。' if all(set(t.get('call_statuses') or {}) <= {'200'} for t in tr.values()) else
              f"；调用状态：{ {a: t.get('call_statuses') for a, t in tr.items()} }。"),
           f"- 开销：路由器每请求开销（路由日志 `overheadMs`）中位数 {_r(_g(tm, 'A', 'router_overhead_ms_p50'), 0)} ms，"
           f"所有经路由器的组的最大值 {_r(mx, 0)} ms（不含 B 组等待评估器的会话开始请求）。",
           ('- 网络：' + '，'.join(f'{a} 组有 {n} 条联网命令' for a, n in net.items()) + '（容器没有出网路由，这些命令无法联网）；其他组为 0。') if net
           else '- 网络：没有运行尝试联网命令。',
           f"- 未来提交：{h.get('leak_before')}/{h.get('runs')} 个运行（含 {_g(data, 'pilot', 'runs', default=0)} 个试点运行）的镜像在 git 历史中仍能找到修复提交，"
           f"harness 在 Codex 开始前把它们移除，移除后为 {h.get('leak_after')} 个。不移除的话，代理可以直接从历史里拿到答案。"]
    return out


def costs(data: dict[str, Any]) -> list[str]:
    c = _g(data, 'ledger', 'committed') or {}
    arms = data.get('arms') or {}
    rn = data.get('runner') or {}
    pl = data.get('pilot') or {}
    out = ['| 项目 | 金额 $ | 说明 |', '|---|---|---|']
    out.append(f"| 离线 tier pass | {c.get('tierpass', 0):.2f} | 500 次评估器调用（开发机） |")
    out.append(f"| 试点 | {c.get('pilot', 0):.2f} | 账本金额，高估（见下） |")
    out.append(f"| 主阶段 | {c.get('main', 0):.2f} | " + '，'.join(f"{a} {s['sum_cost']:.2f}" for a, s in arms.items()) + '（路由器日志计价，D 按代理记录） |')
    out.append(f"| 重复阶段 | {c.get('repeat', 0):.2f} | " + '，'.join(f"{a} {R.repeat_runs(x)} 次运行" for a, x in sorted((data.get('repeats') or {}).items())) + ' |')
    out.append(f"| 模型费用合计 | {sum(c.values()):.2f} | 账本 |")
    if rn:
        out.append(f"| runner | {'—' if rn.get('usd') is None else f'{rn['usd']:.2f}'} | 约 {rn['hours']:.1f} 小时（从实例启动到"
                   f"{'实例停止' if rn.get('end') == 'instance-stop' else '最后一个运行结束'}）"
                   + ('' if rn.get('usd_per_hour') else '，费率未记录') + ' |')
    out += ['', '- 账本是预算控制用的保守记账：按代理记录结算，B 组另加评估器预留，所以主阶段账本略高于各组路由器计价之和。',
            f"- 试点在代理修复 SSE 计价之前运行：{pl.get('calls', 0)} 次调用中 {pl.get('unpriced_calls', 0)} 次无法计价，按最坏情况估计记账，"
            f"所以账本记 ${pl.get('ledger_usd', 0):.2f}；"
            + (f"按路由器日志（{pl.get('router_runs')} 个经路由器的运行）加上直连运行的代理计价，实际约 ${pl['real_usd']:.2f}。" if pl.get('real_usd') is not None
               else '实际费用以路由器日志为准（本数据文件的路由器日志不含试点时段，未能逐运行核对）。')
            + '试点数据不进入分析。']
    return out


def implications(data: dict[str, Any]) -> list[str]:
    fa = data.get('F_vs_A')
    eo = data.get('escalation_oracle') or {}
    r = (fa or {}).get('resolve') or {}
    return [
        f"1. **省钱的杠杆在 fast 一侧。** 在这类 Codex 修复任务上，frontier 没有多解决任务，费用却是 {_g(data, 'C_vs_A', 'cost', 'ratio_of_sums', 'point', default=0):.1f} 倍；fast 的费用约为 1/{1 / fa['cost']['ratio_of_sums']['point']:.0f}，但每 {_net(fa)[1]:.0f} 个任务少解决 1 个。"
        '对类似负载，默认 tier 用 standard 是合理的；不应默认升级到 frontier。' if fa else '',
        f"2. **会话开始的一次性判断不够。** v2.1 评估器在会话开始只看到问题描述和工具列表，从不给出 fast，"
        f"分不出那 {R._pct(r.get('a_only', 0) / r['n'], 0) if r else '—'} 需要 Sol 的任务：离线 tier pass 对这 {r.get('a_only', '—')} 个任务的意见是 "
        f"{R._counts(_g(data, 'a_only_tier_opinion', 'a_only'))}，与全部任务（{R._counts(_g(data, 'a_only_tier_opinion', 'all'))}）没有区别。"
        '只看任务文本可能本来就分不出来。',
        f"3. **值得试的方向：fast 优先，按失败信号升级。** 如果失败能在 Luna 运行结束时被可靠识别，“先 Luna、失败再 Sol”可以保持 Sol 的解决数，"
        f"费用约为一直用 Sol 的 {_r(eo.get('cost_ratio_vs_always_sol'), 2)}。这要求路由器在会话中途也能改变 tier（目前只在会话开始和新 lineage 时决策），"
        '并且要有可用的失败信号。',
        '4. **下一步建议。**',
        '   - 失败信号：在已有记录上检验代理自己的测试结果、最后一次测试命令的退出码、编辑后是否运行过测试等信号能否预测 Luna 失败；本报告只看了调用次数、失败命令数等粗特征，它们分不开。',
        '   - 升级的真实成本：对 Luna 失败的任务，以 Luna 的会话为上下文续跑 Sol（而不是从头再跑），测实际的解决率、费用和缓存损失。',
        '   - 中途升级的路由能力：在 core 中加入“会话内升级”决策点（例如测试失败或轮数超过阈值时从 fast 换到 standard），并评估它对缓存保留率的影响。',
        f"   - frontier 的价值需要更难的任务：C 子集的 {_g(data, 'C_vs_A', 'n', default='—')} 个任务中 {_g(data, 'C_vs_A', 'resolve', 'neither', default='—')} 个三个模型都没解决、其余 Sol 都已解决，"
        '中间没有 frontier 能起作用的任务。要回答 frontier 是否值得，需要 Sol 解决率更低的任务集（例如更大的改动或多文件修复）。',
    ]


def observed(data: dict[str, Any]) -> list[str]:
    fa = data.get('F_vs_A')
    sf = data.get('selection_facts') or {}
    sub = sf.get('subset_size_counts') or {}
    sizes = sf.get('size_counts') or {}
    out = []
    if fa:
        r = fa['resolve']
        out.append(f"- F vs A 的实际不一致率是 {R._pct(r['discordance'])}（计划假设 20%），实际 CI 半宽约 ±{100 * (r['ci'][1] - r['ci'][0]) / 2:.1f} pp（计划约 ±6 pp）。")
    out.append(f"- 规模分布不均：F/A 的 {sf.get('n_main')} 个任务为 small {sizes.get('small', 0)} / medium {sizes.get('medium', 0)} / large {sizes.get('large', 0)}"
               "（上面“每个规模约 67 个”的假设不成立）；" + '；'.join(f"{a} 组 " + ' / '.join(f'{k} {v}' for k, v in sorted(c.items())) for a, c in sorted(sub.items())) + '。')
    return out


def limitations(data: dict[str, Any]) -> list[str]:
    ca = data.get('C_vs_A') or {}
    r = ca.get('resolve') or {}
    rp = data.get('repeats') or {}
    return [
        f"- **结果几乎逐任务确定。** A 在 3 次运行中 0/{_g(rp, 'A', 'tasks', default='—')} 个任务翻转，B vs A 0/{_g(data, 'B_vs_A', 'n', default='—')} 不一致，"
        f"C vs A 0/{r.get('n', '—')} 不一致；C 子集的任务要么 C 与 A 都解决（{r.get('both', '—')} 个），要么都失败（{r.get('neither', '—')} 个）。"
        '这组任务几乎没有落在 frontier 可能帮上忙的区间，所以 C 的零结果只适用于这种任务构成，不能推广；数据污染（下一条）会让情况更明显。',
        '- **数据污染（D15）。** 这些是热门开源仓库的历史修复，模型可能见过；这会抬高所有组的解决率，并压缩 tier 之间的差距，对 C vs A 影响最大。',
        f"- **任务小，判定是二元的。** gold 补丁的非测试改动 ≤ 40 行的任务占 {R._pct(1 - _g(data, 'selection_facts', 'size_counts', 'large', default=0) / max(1, _g(data, 'selection_facts', 'n_main', default=1)), 0)}；"
        '按隐藏测试判定是否解决，不反映补丁质量、可读性或部分完成。',
        '- **只有一个 Codex 配置。** 固定版本、reasoning medium、回退的模型元数据；其他代理、其他推理强度或其他提示词下结果可能不同。',
        '- **只评估了会话开始的决策点。** 路由器目前只在会话开始（和新 lineage）时决策，本实验没有覆盖会话中途升级。',
        '- **理想路由和升级策略都是事后估计。** 前者需要预知哪些任务只有 Sol 能解决，后者需要完美的失败检测；两者都不是可直接实现的策略。',
        '- **试点账本高估。** 试点在代理计价修复之前运行，账本按最坏情况估计记账；试点不进入分析。',
    ]
