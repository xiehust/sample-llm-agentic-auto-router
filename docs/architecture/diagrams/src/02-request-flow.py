#!/usr/bin/env python3
"""Generates 02-request-flow.svg (sequence diagram, Style 1 Flat Icon tokens).

The fireworks-tech-graph JSON generator has no lifeline layout, so this view is authored
as SVG directly and then checked with `fireworks.py check`. Run: python3 02-request-flow.py <out.svg>
"""
import sys
from html import escape

W, H = 1500, 1420
FONT = "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Droid Sans Fallback', sans-serif"
BLUE, GREEN, PURPLE, RED, GRAY = "#2563eb", "#10b981", "#7c3aed", "#ef4444", "#6b7280"

# participants: (id, title, subtitle, fill, stroke)
P = [
    ("client", "Agent 客户端", "Claude Code / OpenAI SDK", "#eff6ff", "#3b82f6"),
    ("gw", "AgentCore Gateway", "CUSTOM_JWT · rules", "#faf5ff", "#8b5cf6"),
    ("pe", "托管私有端点", "managed private endpoint", "#f8fafc", "#94a3b8"),
    ("vpce", "execute-api VPCE", "interface endpoint", "#f8fafc", "#94a3b8"),
    ("api", "私有 REST API", "AWS_IAM + resource policy", "#fff7ed", "#f97316"),
    ("nlb", "VPC link → NLB", "internal · TCP 8080", "#f8fafc", "#94a3b8"),
    ("router", "router (Fargate)", "core + pricing", "#f0fdf4", "#16a34a"),
    ("bedrock", "Bedrock runtime", "/anthropic · /openai", "#ecfdf5", "#10b981"),
]
X0, DX, BW, BH, PY = 100, 186, 168, 58, 108
X = {pid: X0 + i * DX for i, (pid, *_rest) in enumerate(P)}
LIFE_TOP, LIFE_BOTTOM = PY + BH, H - 70

out = []
add = out.append


def tx(x, y, s, size=12, color="#374151", anchor="middle", weight=400, role="label"):
    attr = f' data-graph-role="{role}"' if role else ''
    return (f'<text{attr} x="{x}" y="{y}" font-size="{size}" fill="{color}" '
            f'text-anchor="{anchor}" font-weight="{weight}">{escape(s)}</text>')


def text(*args, **kwargs):
    add(tx(*args, **kwargs))


def est_width(s, size=12):
    return sum(size * (1.0 if ord(ch) > 0x2E80 else 0.56) for ch in s)


def msg(src, dst, y, label, color=BLUE, dashed=False, marker="arrowBlue"):
    x1, x2 = X[src], X[dst]
    sign = 1 if x2 > x1 else -1
    x1 += sign * 4
    x2 -= sign * 6
    dash = ' stroke-dasharray="7,5"' if dashed else ''
    add(f'<path data-graph-role="edge" data-source="{src}" data-target="{dst}" d="M {x1} {y} L {x2} {y}" '
        f'stroke="{color}" stroke-width="1.8" fill="none"{dash} marker-end="url(#{marker})"/>')
    half = est_width(label) / 2 + 6
    cx = min(max((X[src] + X[dst]) / 2, 20 + half), W - 20 - half)
    text(cx, y - 8, label, size=12, color="#1f2937")


def note(pid, y, lines, side="right", width=300, fill="#fffbeb", stroke="#f59e0b"):
    h = 14 + 18 * len(lines)
    x = X[pid] + 10 if side == "right" else X[pid] - 10 - width
    body = "".join(tx(x + 10, y + 22 + 18 * i, line, anchor="start", role=None) for i, line in enumerate(lines))
    add(f'<g data-graph-role="node" data-graph-bounds="{x} {y} {x + width} {y + h}">'
        f'<rect x="{x}" y="{y}" width="{width}" height="{h}" rx="6" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>{body}</g>')
    return y + h


add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
add(f'<style>text {{ font-family: {FONT}; }}</style>')
add('<defs>')
for mid, c in (("arrowBlue", BLUE), ("arrowGreen", GREEN), ("arrowRed", RED), ("arrowPurple", PURPLE)):
    add(f'<marker id="{mid}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">'
        f'<polygon points="0 0, 10 3.5, 0 7" fill="{c}"/></marker>')
add('</defs>')
add(f'<rect data-graph-role="background" width="{W}" height="{H}" fill="#ffffff"/>')
text(W / 2, 46, "请求路径：Gateway → 私有 REST API hop → router → Bedrock", size=24, color="#111827", weight=700)
text(W / 2, 76, "以 Messages 为例；Chat Completions / Responses 路径相同，只是上游路径为 /openai/v1/…", size=14, color=GRAY)

# participants + lifelines
for pid, title, sub, fill, stroke in P:
    x = X[pid]
    add(f'<line data-graph-role="decoration" x1="{x}" y1="{LIFE_TOP}" x2="{x}" y2="{LIFE_BOTTOM}" '
        f'stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="5,4"/>')
for pid, title, sub, fill, stroke in P:
    x = X[pid]
    add(f'<g data-graph-role="node" id="p-{pid}" data-graph-bounds="{x - BW / 2} {PY} {x + BW / 2} {PY + BH}">'
        f'<rect x="{x - BW / 2}" y="{PY}" width="{BW}" height="{BH}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/>'
        + tx(x, PY + 25, title, size=14, color="#111827", weight=600, role=None)
        + tx(x, PY + 44, sub, size=11, color=GRAY, role=None) + '</g>')

# phase bands (decoration only)
def band(y1, y2, label, color):
    add(f'<rect data-graph-role="decoration" x="16" y="{y1}" width="{W - 32}" height="{y2 - y1}" rx="10" fill="{color}" opacity="0.35"/>')
    text(28, y1 + 18, label, size=12, color="#475569", anchor="start", weight=600)

band(190, 600, "① 入站与 hop：身份在每一跳被重新校验", "#eff6ff")
band(610, 990, "② router 内部：决策、转发、计量", "#f0fdf4")
band(1000, 1335, "③ 回退：router 不可用时 gateway 按回退链直连 Bedrock（router 不参与）", "#fef2f2")

y = 250
msg("client", "gw", y, "POST /inference/v1/messages · Bearer JWT · model=router/auto")
y = note("gw", y + 16, ["校验 JWT（issuer · client · scope）", "rule: model auto / auto:* → router target"], width=290)
y += 34
msg("gw", "pe", y, "SigV4 (execute-api)")
y += 46
msg("pe", "vpce", y, "routingDomain")
y += 46
msg("vpce", "api", y, "Host = 私有 API 域名")
y = note("api", y + 16, ["AWS_IAM 验签 + resource policy：只放行 gateway role，",
                          "且 aws:SourceVpce = 本 VPCE（其他角色显式 Deny）",
                          "注入 x-router-caller-arn / x-router-source-vpce",
                          "（取自 context.identity，客户端伪造值被覆盖）"], width=360)
y += 34
msg("api", "nlb", y, "HTTP_PROXY · STREAM")
y += 46
msg("nlb", "router", y, "TCP 8080（SG 只放行 NLB）")

y = 650
y = note("router", y, ["1. hop 校验 apigw-iam（fail-closed）：caller ARN 是 gateway",
                        "    role session、源 VPCE 匹配、x-amz-source-arn = gateway",
                        "2. body 校验：≤ 10 MiB、合法 JSON、无重复顶层 key、pin 在允许列表",
                        "3. summarize → decide（可选 assessor）→ beta 兼容性 veto",
                        "4. 只改写顶层 model 字段，其余字节不动"], side="left", width=470,
         fill="#f0fdf4", stroke="#16a34a")
y += 34
msg("router", "bedrock", y, "SigV4 (bedrock) · 选中的模型", color=BLUE)
y += 46
msg("bedrock", "router", y, "SSE 事件流（含 usage）", color=GREEN, dashed=True, marker="arrowGreen")
y += 46
msg("router", "client", y, "逐块转发 SSE（反向经 NLB → API → Gateway）+ x-router-decision / -model / -reason",
    color=GREEN, dashed=True, marker="arrowGreen")
y = note("router", y + 16, ["流结束：normalize usage → costOf → core.record", "→ JSON 日志 + EMF（不记 body / 凭证）"],
         side="left", width=340, fill="#f0fdf4", stroke="#16a34a")

y = 1062
msg("router", "gw", y, "5XX / 连接失败 / 610 s 内无首字节（router 的 4XX 直接返回客户端）", color=RED, dashed=True, marker="arrowRed")
y += 46
msg("gw", "bedrock", y, "fallback 1 → bedrock target：固定 Sonnet 5.5", color=RED, marker="arrowRed")
y += 46
msg("bedrock", "gw", y, "4XX（Chat / Responses 请求必然如此：这些 API 不接受 Claude）", color=RED, dashed=True, marker="arrowRed")
y += 46
msg("gw", "bedrock", y, "fallback 2 → bedrock target：固定 GPT-6.1 Sol", color=RED, marker="arrowRed")
y += 46
msg("bedrock", "client", y, "响应经 Gateway 返回（只能从 body.model 看出走了回退；两跳都失败则返回最后一个错误）",
    color=RED, dashed=True, marker="arrowRed")
y = note("gw", y + 18, ["熔断：router 连续 5xx 时 gateway 可能把它摘掉，", "auto* 流量静默走回退链，期间没有 router 计量"],
         width=330, fill="#fef2f2", stroke="#ef4444")

# legend
ly = H - 40
for i, (c, m, label, dashed) in enumerate(((BLUE, "arrowBlue", "请求", False), (GREEN, "arrowGreen", "响应 / 流", True),
                                           (RED, "arrowRed", "回退路径", False))):
    lx = 40 + i * 170
    dash = ' stroke-dasharray="7,5"' if dashed else ''
    add(f'<g data-graph-role="legend"><line x1="{lx}" y1="{ly}" x2="{lx + 36}" y2="{ly}" stroke="{c}" stroke-width="1.8"{dash} marker-end="url(#{m})"/>'
        f'<text x="{lx + 46}" y="{ly + 4}" font-size="12" fill="{GRAY}">{label}</text></g>')
text(W - 40, ly + 4, "Style 1 · Flat Icon · sequence", size=11, color="#9ca3af", anchor="end")
add('</svg>')

with open(sys.argv[1] if len(sys.argv) > 1 else "02-request-flow.svg", "w", encoding="utf-8") as f:
    f.write("\n".join(out) + "\n")
