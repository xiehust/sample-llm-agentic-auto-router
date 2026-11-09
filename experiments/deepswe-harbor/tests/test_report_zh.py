"""report_zh: row selection (0d's notes), the pre-registered comparisons and claims, S7a/S7b, and the zh render."""
import json
import re

import pytest

import report_zh as rz
import routerlogs

NB = 300


def row(arm, task, rep=1, ok=True, usd=1.0, pass_=None, phase='main', status='scored', cls='agent', attempt=1, runner=0, **kw):
    pass_ = pass_ or ('main' if rep == 1 else f'rep{rep}')
    r = {'schema': 'deepswe-harbor-run/v1', 'run_id': f'{arm}{task}{rep}{pass_}{attempt}', 'trial_id': f'{arm}{task}{rep}{pass_}{attempt}',
         'pass': pass_, 'phase': phase, 'arm': arm, 'task_id': task, 'rep': rep, 'attempt': attempt, 'final_status': status,
         'in_comparisons': status == 'scored', 'class': cls, 'score': (1.0 if ok else 0.0) if status == 'scored' else None,
         'resolved': bool(ok) and status == 'scored', 'ledger_usd': usd, 'exit_reason': 'done', 'runner': runner, 'wall_s': 600,
         'pred_tier': 'none', 'calls': {'usage': {'prompt': 100, 'read': 90, 'output': 5}}, 'tokens_by_model': {}}
    r.update(kw)
    return r


def test_select_drops_the_pilot_phase_and_keys_by_pass():
    rows = [row('A', 't1', pass_='pilot', phase='pilot', status='excluded', cls='cap_stop'),  # nosec B106: pass name, not a credential
            row('A', 't1', pass_='pilot2', phase='pilot'),        # in_comparisons=True, but a pilot: not analysed  # nosec B106: pass name, not a credential
            row('A', 't1')]
    sel = rz.select(rows)
    assert [(r['pass'], r['phase']) for r in sel] == [('main', 'main')]
    both = rz.select(rows, include_pilot=True)                     # dry run: pilot and pilot2 don't collide
    assert sorted(r['pass'] for r in both) == ['main', 'pilot', 'pilot2']
    again = rz.select([row('A', 't1', ok=False), row('A', 't1', ok=True, attempt=2)])
    assert len(again) == 1 and again[0]['attempt'] == 2


def test_strata_come_from_strata_json_not_pred_tier(tmp_path):
    p = tmp_path / 'strata.json'
    p.write_text(json.dumps({'tasks': {'t1': {'stratum': 'frontier', 'stable': True, 'reps': ['frontier'] * 3}}}))
    assert rz.load_strata(p) == {'t1': {'stratum': 'frontier', 'stable': True}}


def _two_arm(n=12, a_ok=lambda i: i % 2 == 0, b_ok=lambda i: i % 2 == 0, reps=3, a_usd=1.0, b_usd=2.0):
    rows = []
    for i in range(n):
        for k in range(1, reps + 1):
            rows.append(row('A', f't{i}', k, a_ok(i), a_usd))
            rows.append(row('B', f't{i}', k, b_ok(i), b_usd))
    return rows


def test_compare_is_y_minus_x_with_ratio_of_per_task_mean_costs():
    rows = _two_arm(b_ok=lambda i: True)
    rs = {a: rz.runs(rows, a) for a in 'AB'}
    c = rz.compare(rs['A'], rs['B'], n_boot=NB)
    assert c['resolve']['diff'] == 0.5 and c['tasks'] == 12
    assert abs(c['cost']['ratio_of_sums']['point'] - 2.0) < 1e-9
    assert c['resolve']['runs_a'] == {'3': 12}


def test_claims_follow_the_preregistered_rules():
    def mk(lo, hi, clo, chi, ni=None):
        return {'resolve': {'noninferiority': {'noninferior': lo > -0.10 if ni is None else ni}, 'ci': (lo, hi), 'ci_degenerate': False},
                'cost': {'ratio_of_sums': {'ci': (clo, chi)}}}
    c = rz.claims(mk(-0.05, 0.05, 0.8, 0.95))
    assert c['b_geq_a_at_lower_cost'] and not c['b_better'] and not c['b_costs_more']
    c = rz.claims(mk(0.01, 0.1, 1.2, 1.5))
    assert c['b_better'] and c['b_costs_more'] and not c['b_geq_a_at_lower_cost']
    c = rz.claims(mk(-0.2, 0.05, 0.9, 1.1))
    assert c['noninferior'] is False and 'B 更差' not in rz._claim_text(c).replace('不是“B 更差”', '')
    deg = mk(0.0, 0.0, 0.8, 0.9)
    deg['resolve']['ci_degenerate'] = True
    c = rz.claims(deg)
    assert c['noninferior'] is None and c['b_geq_a_at_lower_cost'] is None and '不作解决率方面的判定' in rz._claim_text(c)
    assert '等价' not in rz._claim_text(rz.claims(mk(-0.05, 0.05, 0.8, 0.95))).replace('不允许说“等价”', '')


def test_s7a_keeps_planned_reps_and_s7b_compares_reps_4_5_with_1_3():
    rows = _two_arm(reps=3)
    rows += [row('A', f't{i}', k, False, 1.0) for i in range(12) for k in (4, 5)]   # A got worse late: drift
    rows += [row('B', f't{i}', k, i % 2 == 0, 2.0) for i in range(12) for k in (4, 5)]
    d = rz.build(rows, n_boot=NB)
    assert d['primary']['s7a_reps_1_3']['resolve']['runs_a'] == {'3': 12}
    assert d['primary']['B_vs_A']['resolve']['runs_a'] == {'5': 12}
    assert d['s7b_drift']['A']['diff'] == -0.5 and d['s7b_drift']['B']['diff'] == 0.0


def test_excluded_runs_trigger_the_failure_sensitivity_only_past_three_tasks():
    rows = _two_arm(reps=1)
    few = rows + [row('B', f't{i}', 2, status='excluded', cls='harness') for i in range(3)]
    assert 'excluded_as_failures' not in rz.build(few, n_boot=NB)['primary']
    many = rows + [row('B', f't{i}', 2, status='excluded', cls='harness', usd=0.5) for i in range(4)]
    many += [row('B', 't9', 3, status='excluded', cls='cap_stop')]                 # cap stops never count
    d = rz.build(many, n_boot=NB)
    assert d['excluded_tasks'] == {'B': ['t0', 't1', 't2', 't3']}
    sens = d['primary']['excluded_as_failures']['resolve']
    assert sens['runs_b'] == {'1': 8, '2': 4} and sens['diff'] < d['primary']['B_vs_A']['resolve']['diff']


def test_strata_decomposition_adds_up_and_render_is_text_free():
    rows = _two_arm(n=10, b_ok=lambda i: i < 8, reps=2)
    for i in range(10):
        for k in (1, 2):
            rows.append(row('C', f't{i}', k, i < 7, 3.0))
            rows.append(row('F', f't{i}', k, i < 3, 0.1))
    strata = {f't{i}': {'stratum': 'frontier' if i < 6 else 'standard', 'stable': i % 3 != 0} for i in range(10)}
    d = rz.build(rows, strata, n_boot=NB)
    dec = d['strata']['decomposition_B_vs_A']
    assert abs(dec['total'] - d['primary']['B_vs_A']['resolve']['diff']) < 1e-9
    assert d['ideal']['heldout']['n'] == 10 and d['ideal']['B_on_heldout_tasks']['n'] == 10
    assert d['noise']['A']['tasks'] == 10
    md = rz.render(d)
    assert md.startswith('# DeepSWE') and '试运行' not in md and 'S4' in md
    assert not re.search(r'(?<!\d)\d{12}(?!\d)', md + json.dumps(d))
    assert '试运行' in rz.render(rz.build(rows + [row('A', 't0', pass_='pilot2', phase='pilot')], strata, include_pilot=True, n_boot=NB))  # nosec B106: pass name, not a credential


def test_router_logs_feed_the_assessor_section_and_b_cost(tmp_path):
    rows = _two_arm(n=4, reps=1)
    recs = []
    for r in rows:
        assess = {'tier': 'frontier', 'proposedTier': 'frontier', 'status': 'ok', 'outcome': 'ok', 'applied': True,
                  'latencyMs': 1200, 'confidence': 0.9, 'basis': ['card'], 'costUsd': 0.01} if r['arm'] == 'B' else None
        recs.append({'ts': '2026-11-05T00:00:00Z', 'reqId': r['run_id'], 'kind': 'model', 'status': 200, 'session': routerlogs.label(r['run_id']),
                     'servedModel': 'global.openai.gpt-6-astra', 'costUsd': {'total': r['ledger_usd']}, **({'assessor': assess} if assess else {})})
    d = rz.build(rows, router_records=recs, n_boot=NB)
    assert d['router_logs']['runs_joined'] == 8 and d['router_logs']['ledger_vs_router_cost']['over_2pct'] == 0
    assert d['cost_basis'] == {'B': 'ledger+assessor', 'others': 'ledger', 'b_runs_without_router_logs': 0, 'fell_back': False}
    primary, ledger = d['primary']['B_vs_A']['cost'], d['primary']['B_vs_A_ledger_only']
    assert abs(primary['sum_b'] - (ledger['sum_b'] + 0.04)) < 1e-9 and primary['sum_a'] == ledger['sum_a']
    assert abs(d['arms']['B']['sum_cost'] - primary['sum_b']) < 1e-9
    assert d['assessor']['b_runs'] == 4
    md = rz.render(d)
    assert 'assessor' in md and '只用账本费用的 B − A' in md
    # one scored B run without router logs: every B cost falls back to the ledger, and the report says how many
    d2 = rz.build(rows, router_records=[x for x in recs if x['session'] != routerlogs.label(rows[1]['run_id'])], n_boot=NB)
    assert d2['cost_basis']['fell_back'] and d2['cost_basis']['b_runs_without_router_logs'] == 1
    assert d2['primary']['B_vs_A']['cost']['sum_b'] == ledger['sum_b'] and 'B_vs_A_ledger_only' not in d2['primary']
    assert '1 次计分的 B 运行没有 router 日志' in rz.render(d2)
    assert '没有提供 router 日志' in rz.render(rz.build(rows, n_boot=NB))


def test_only_runs_excluded_after_reruns_count_and_s1_gets_the_sensitivity_too():
    rows = []
    for i in range(10):
        for arm, usd in (('A', 1.0), ('B', 2.0), ('C', 3.0)):
            rows.append(row(arm, f't{i}', 1, i % 2 == 0, usd))
    rows += [row('B', f't{i}', 2, status='excluded', cls=c) for i, c in enumerate(('upstream', 'harness', 'verifier_infra'))]
    rows += [row('B', 't7', 2, status='excluded', cls='cancelled'), row('B', 't8', 2, status='excluded', cls='agent')]
    d = rz.build(rows, n_boot=NB)
    assert d['excluded_tasks'] == {'B': ['t0', 't1', 't2']} and len(d['excluded_other_runs']['B']) == 2
    assert 'excluded_as_failures' not in d['primary'] and 'B_vs_C_excluded_as_failures' not in d['secondary']
    rows.append(row('B', 't3', 2, status='excluded', cls='harness'))
    d = rz.build(rows, n_boot=NB)
    assert 'excluded_as_failures' in d['primary'] and 'B_vs_C_excluded_as_failures' in d['secondary']
    assert d['secondary']['B_vs_C_excluded_as_failures']['resolve']['runs_b'] == {'1': 6, '2': 4}
    md = rz.render(d)
    assert '取消或未知处理' in md and 'S1：B − C，排除的运行记为失败' in md


def test_degenerate_ci_makes_no_resolve_claim_but_keeps_the_cost_claim():
    c = rz.claims({'resolve': {'noninferiority': {'noninferior': True}, 'ci': (0.0, 0.0), 'ci_degenerate': True},
                   'cost': {'ratio_of_sums': {'ci': (1.5, 2.5)}}})
    assert c['noninferior'] is None and c['b_better'] is None and c['b_costs_more'] is True
    txt = rz._claim_text(c)
    assert '不作解决率方面的判定' in txt and 'B 的成本高于 A' in txt


def _four_arm(n=12, reps=5, cf_reps=5, c_late_usd=None):
    rows = []
    for i in range(n):
        for k in range(1, reps + 1):
            rows.append(row('A', f't{i}', k, i % 2 == 0, 1.0))
            rows.append(row('B', f't{i}', k, i % 2 == 0, 2.0))
        for k in range(1, cf_reps + 1):
            p = {4: 'rep4c', 5: 'rep5c'}.get(k)
            rows.append(row('C', f't{i}', k, i % 2 == 0, c_late_usd if (c_late_usd and k >= 4) else 3.0, pass_=p))
            rows.append(row('F', f't{i}', k, i % 3 == 0, 0.1, pass_=p))
    return rows


def test_s1_s2_use_the_blind_design_set_and_show_all_runs_next_to_them():
    d = rz.build(_four_arm(), n_boot=NB)
    s = d['secondary']
    assert s['B_vs_C']['resolve']['runs_a'] == {'3': 12} and s['B_vs_C']['resolve']['runs_b'] == {'5': 12}   # C at 5 → 3
    assert s['all_runs']['B_vs_C']['resolve']['runs_a'] == {'5': 12}
    assert s['F_vs_A']['resolve']['runs_b'] == {'3': 12} and s['C_vs_A']['resolve']['runs_a'] == {'5': 12}
    assert d['primary']['B_vs_A']['resolve']['runs_a'] == {'5': 12}                    # P1 unaffected
    assert d['primary']['s7a_reps_1_3']['resolve']['runs_a'] == {'3': 12}             # S7a unchanged
    assert s['s7a_B_vs_C']['resolve']['runs_a'] == {'2': 12}
    assert d['interim_look']['present'] and d['interim_look']['runs_after_look'] == {'C': 24, 'F': 24}
    assert sorted(r for r in d['rows']['by_pass'] if r.startswith('rep4c')) == ['rep4c:C', 'rep4c:F']


def test_s7b_covers_all_four_arms():
    d = rz.build(_four_arm(), n_boot=NB)
    assert sorted(d['s7b_drift']) == sorted(rz.ARMS)
    assert all(d['s7b_drift'][a]['n'] == 12 for a in rz.ARMS)
    md = rz.render(d)
    assert all(f'- {rz.LABEL[a]}：rep 4–5 − rep 1–3' in md for a in rz.ARMS)


def test_disclosure_header_always_and_labels_on_s3_s5_only_with_cf_reps_4_5():
    strata = {f't{i}': {'stratum': 'frontier' if i < 6 else 'standard', 'stable': True} for i in range(12)}
    md = rz.render(rz.build(_four_arm(), strata, n_boot=NB))
    assert '中期查看披露（design §7.5.2、§11）' in md.split('## 1.')[0] and 'C 24 次（计分 24）' in md
    for h in ('## 4. 理想的逐任务路由（S3，描述性）', '## 5. 按 tier pass 分层（S4，次要）', '## 6. 运行间噪声（S5）', '## 7. 描述性结果（S6）'):
        assert f'{h}（{rz.AFTER_LOOK}）' in md, h
    assert f'S1：B − C（{rz.AFTER_LOOK}）' in md and 'S1：B − C（盲设计集）' in md
    s7b = {a: next(x for x in md.splitlines() if x.startswith(f'- {rz.LABEL[a]}：rep 4–5')) for a in rz.ARMS}
    assert all(rz.AFTER_LOOK in s7b[a] for a in 'CF') and not any(rz.AFTER_LOOK in s7b[a] for a in 'AB')
    blind_only = rz.render(rz.build(_four_arm(cf_reps=3), strata, n_boot=NB))
    assert '中期查看披露' in blind_only and '还没有这样的运行' in blind_only and rz.AFTER_LOOK not in blind_only


def test_a_claim_that_differs_between_blind_and_all_runs_is_flagged_and_the_blind_claim_kept():
    d = rz.build(_four_arm(c_late_usd=0.1), n_boot=NB)     # C's late runs are cheap: B − C's cost claim flips
    c = d['secondary']['claims']['B_vs_C']
    assert c['blind']['b_lower_cost'] and c['all_runs']['b_costs_more']
    assert {'b_lower_cost', 'b_costs_more'} <= set(c['differ']) and d['secondary']['claims_differ'] == ['B_vs_C']
    md = rz.render(d)
    line = next(x for x in md.splitlines() if x.startswith('- **S1：B − C 判定（盲设计集）**'))
    assert 'B 的成本低于 C' in line
    assert '**判定不同**' in md and 'B 的成本高于 C' in md and '保留盲设计集的判定' in md
    assert not rz.build(_four_arm(), n_boot=NB)['secondary']['claims_differ']


# ---------------------------------------------------------------- Terminal-Bench 2.1 profile (TB design §4.7; 0d §7)

def tbrow(arm, task, rep=1, ok=True, usd=1.0, flag=False, difficulty='medium', flaky=False, **kw):
    r = row(arm, task, rep, ok, usd, schema='tbench-harbor-run/v1', **kw)
    r.update(tb={'difficulty': difficulty, 'category': 'software-engineering'}, flaky_env=flaky,
             lookup={'scanner': 'v', 'source': 'rollout', 'flag': flag, 'flag_l1': flag, 'flag_l2': False, 'evidence': {}})
    return r


def _tb_rows(n=12, flag_b=(), c_ok=lambda i: True):
    rows = []
    for i in range(n):
        d = 'hard' if i < 4 else 'easy' if i == 4 else 'medium'
        for k in (1, 2, 3):
            rows += [tbrow('A', f't{i}', k, i % 2 == 0, 1.0, difficulty=d, flaky=i == 11),
                     tbrow('B', f't{i}', k, True, 2.0, flag=(i in flag_b and k == 1), difficulty=d, flaky=i == 11),
                     tbrow('C', f't{i}', k, c_ok(i), 3.0, difficulty=d, flaky=i == 11),
                     tbrow('F', f't{i}', k, i % 3 == 0, 0.1, difficulty=d, flaky=i == 11)]
    return rows


def test_tb_selects_its_schema_and_scores_flagged_runs_as_not_resolved():
    rows = _tb_rows(flag_b=(0, 1, 2))
    assert rz.build(rows, n_boot=NB)['rows']['selected'] == 0                  # the DeepSWE profile ignores TB rows
    d = rz.build(rows, n_boot=NB, profile='tb21')
    assert d['profile'] == 'tb21' and d['rows']['selected'] == 12 * 3 * 4
    prim, graded = d['primary']['B_vs_A']['resolve']['diff'], d['tb']['as_graded']['B_vs_A']['resolve']['diff']
    assert abs(graded - 0.5) < 1e-9 and abs(prim - (0.5 - 3 / 12 / 3)) < 1e-9     # 3 flagged resolved runs → not resolved
    lf = d['tb']['lookup']['by_arm']
    assert lf['B']['flag'] == 3 and lf['B']['flagged_resolved'] == 3 and lf['A']['flag'] == 0 and d['tb']['lookup']['over_5pct'] == ['B']
    assert d['tb']['ni_tight']['margin'] == 0.05 and 'B_vs_C' in d['tb']['ni_tight']
    assert d['arms']['B']['rate'] < 1.0                                         # S6 rates use the primary scoring too


def test_tb_render_has_its_sections_and_none_of_deepswes():
    rows = _tb_rows(flag_b=(0,))
    strata = {f't{i}': {'stratum': 'frontier' if i < 6 else 'standard', 'stable': True} for i in range(12)}
    md = rz.render(rz.build(rows, strata, n_boot=NB, profile='tb21'))
    assert md.startswith('# Terminal-Bench 2.1')
    for want in ('P1-tight（非劣性 5 pp', '按原始评分（不计查找标记；§7.7 敏感性）', '### 按 TB 作者难度分层', '### 查找检查（§7.7）',
                 'flaky_env', 'GPT-6 Astra + Codex 87.4%', '任务容器可以访问互联网', 'tier pass 分层 × 难度'):
        assert want in md, want
    for unwanted in ('中期查看披露', '盲设计集', 'S7a', '漂移检查', 'DeepSWE v1.1 的这些任务'):
        assert unwanted not in md, unwanted
    assert not re.search(r'(?<!\d)\d{12}(?!\d)', md)


def test_tb_difficulty_flaky_premise_and_oracle_recheck():
    d = rz.build(_tb_rows(c_ok=lambda i: i % 2 == 0), n_boot=NB, profile='tb21', oracle_failed=['t0', 't1'])
    tb = d['tb']
    assert tb['difficulty']['counts'] == {'hard': 4, 'easy+medium': 8}
    assert tb['difficulty']['by_stratum']['hard']['B_vs_A']['tasks'] == 4
    assert tb['flaky_env']['tasks'] == ['t11'] and tb['flaky_env']['rate_on_flaky']['B'] == 1.0
    assert tb['premise'] == {'C_run1_rate': 0.5, 'tasks': 12, 'threshold': 0.8, 'flag': True}
    assert tb['oracle_recheck']['B_vs_A']['tasks'] == 10 and tb['oracle_recheck']['failed_tasks'] == ['t0', 't1']
    md = rz.render(d)
    assert '前提检查未通过' in md and 'oracle 复查失败的 2 个任务' in md
    assert not rz.build(_tb_rows(), n_boot=NB, profile='tb21')['tb']['premise']['flag']


def test_tb_side_by_side_with_deepswe_and_fisher():
    ds = rz.build(_four_arm(n=10), n_boot=NB)                                  # DeepSWE's report-data.json shape
    d = rz.build(_tb_rows(), n_boot=NB, profile='tb21', compare_with=json.loads(json.dumps(ds)))
    sb = d['tb']['side_by_side']
    assert set(sb) == {'B_vs_A', 'B_vs_C', 'C_vs_A', 'F_vs_A'}
    x = sb['B_vs_A']
    assert x['tb']['ni5'] is not None and x['deepswe']['ni5'] is None and 'avg' in x['both_descriptive']
    assert '## 8. 与 DeepSWE 并列' in rz.render(d)
    assert abs(rz.fisher_two_sided(3, 1, 1, 3) - 0.4857142857) < 1e-6 and rz.fisher_two_sided(0, 0, 1, 1) is None
    assert rz.fisher_two_sided(5, 0, 0, 5) < 0.01


def test_tb_strata_file_schema_loads(tmp_path):
    p = tmp_path / 'strata.json'
    p.write_text(json.dumps({'schema': 'tbench-harbor-strata/v1', 'tasks': {'t1': {'stratum': 'frontier', 'stable': True, 'reps': ['frontier'] * 3}}}))
    assert rz.load_strata(p) == {'t1': {'stratum': 'frontier', 'stable': True}}


def test_tb_cli_writes_the_report(tmp_path):
    rows = tmp_path / 'rows.jsonl'
    rows.write_text(''.join(json.dumps(r) + '\n' for r in _tb_rows()))
    fail = tmp_path / 'failed.json'
    fail.write_text(json.dumps({'failed': ['t3']}))
    out = tmp_path / 'out'
    assert rz.main(['--rows', str(rows), '--strata', str(tmp_path / 'none.json'), '--out', str(out), '--profile', 'tb21',
                    '--oracle-recheck', str(fail)]) == 0
    assert (out / 'report.zh.md').read_text().startswith('# Terminal-Bench 2.1')
    assert json.loads((out / 'report-data.json').read_text())['tb']['oracle_recheck']['failed_tasks'] == ['t3']


def _tb_strata_file(tmp_path, schema='tbench-harbor-strata/v1', ids=('t0', 't1', 't2', 't3')):
    """73's TB strata.json shape (`tierpass.py strata`): top-level keys as in the real file, synthetic task ids."""
    tasks = {t: {'stratum': 'frontier' if i % 2 else 'standard', 'stable': i != 3, 'reps': (['frontier'] if i % 2 else ['standard']) * 3}
             for i, t in enumerate(ids)}
    d = {'schema': schema, 'created': '2026-11-06T00:00:00Z', 'set': 'tb21', 'reps': 3, 'definition': 'majority of 3 tier passes; none = standard',
         'counts': {'frontier': 2, 'standard': 2}, 'stable': 3, 'stable_by_stratum': {'frontier': 2, 'standard': 1}, 'tasks': tasks}
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / 'strata.json').write_text(json.dumps(d))
    return tmp_path


def test_tb_strata_schema_is_accepted_by_the_assessor_section_and_unknown_ones_still_raise(tmp_path):
    import assessor_live
    d = _tb_strata_file(tmp_path)
    assert assessor_live.load_strata(d)['t1'] == {'stratum': 'frontier', 'stable': True, 'reps': ['frontier'] * 3}
    assert rz.load_strata(d / 'strata.json')['t3'] == {'stratum': 'frontier', 'stable': False}
    with pytest.raises(ValueError, match='unexpected strata schema'):
        assessor_live.load_strata(_tb_strata_file(tmp_path / 'x', schema='something-else/v1'))
    with pytest.raises(ValueError):
        assessor_live.load_strata(_tb_strata_file(tmp_path / 'y', schema=None))
    # the TB report path end to end: router logs present, so assessor_live.build reads strata.json from strata_dir
    rows = [tbrow(a, f't{i}', k, True, 1.0) for i in range(4) for k in (1, 2, 3) for a in rz.ARMS]
    recs = [{'ts': '2026-11-06T00:00:00Z', 'reqId': r['run_id'], 'kind': 'model', 'status': 200, 'session': routerlogs.label(r['run_id']),
             'servedModel': 'global.openai.gpt-6.1-sol', 'costUsd': {'total': r['ledger_usd']},
             **({'assessor': {'tier': 'standard', 'proposedTier': 'standard', 'status': 'ok', 'outcome': 'ok', 'applied': False,
                              'latencyMs': 900, 'confidence': 0.9, 'basis': ['card'], 'costUsd': 0.001}} if r['arm'] == 'B' else {})} for r in rows]
    strata = rz.load_strata(d / 'strata.json')
    out = rz.build(rows, strata, recs, strata_dir=d, n_boot=NB, profile='tb21')
    assert out['assessor']['b_runs'] == 12 and '### assessor' in rz.render(out)


def test_tb_assessor_section_scores_outcomes_like_the_primary(tmp_path):
    """0d: the assessor section's per-stratum outcome table uses the same outcome basis as the primary (§7.7)."""
    d = _tb_strata_file(tmp_path)
    rows = [tbrow(a, f't{i}', k, True, 1.0, flag=(a == 'C' and i == 1)) for i in range(4) for k in (1, 2, 3) for a in rz.ARMS]
    recs = [{'ts': '2026-11-06T00:00:00Z', 'reqId': r['run_id'], 'kind': 'model', 'status': 200, 'session': routerlogs.label(r['run_id']),
             'servedModel': 'global.openai.gpt-6.1-sol', 'costUsd': {'total': r['ledger_usd']},
             **({'assessor': {'tier': 'standard', 'proposedTier': 'standard', 'status': 'ok', 'outcome': 'ok', 'applied': False,
                              'latencyMs': 900, 'confidence': 0.9, 'basis': ['card'], 'costUsd': 0.001}} if r['arm'] == 'B' else {})} for r in rows]
    out = rz.build(rows, rz.load_strata(d / 'strata.json'), recs, strata_dir=d, n_boot=NB, profile='tb21')
    cells = json.dumps(out['assessor'])
    assert out['tb']['lookup']['by_arm']['C']['flagged_resolved'] == 3
    assert '"C_resolved": 0.5' in cells          # frontier stratum (t1, t3): C's flagged t1 counts as unresolved
