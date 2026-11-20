"""The Finger Tapping report: results first, then every step of the working (M15).

One self-contained HTML file (inline SVG charts, no scripts, no web fonts needed), made at the
hospital from the result and the analysis details. Text comes from config/messages/report.en.json.
It holds no name or record number; the NCID is shown only when the caller passes it.
"""

from __future__ import annotations

import json
from contextvars import ContextVar
from datetime import UTC, datetime
from functools import lru_cache
from html import escape

import numpy as np

from .config import analysis_config, config_dir
from .cyclic import MEASURES, HandDetail, layout

SIDES = ("right", "left")


@lru_cache
def text() -> dict:
    return json.loads((config_dir() / "messages" / "report.en.json").read_text(encoding="utf-8"))


#: The test being written up: its own wording (tests.<code>.*) wins over the shared wording.
_TEST: ContextVar[str] = ContextVar("report_test", default="FT")


def _lookup(node: object, key: str) -> object | None:
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def tr(key: str, **kw: object) -> str:
    node = _lookup(text().get("tests", {}).get(_TEST.get(), {}), key)
    if node is None:
        node = _lookup(text(), key)
    if node is None:
        raise KeyError(key)
    s = str(node)
    return s.format(**kw) if kw else s


def num(v: float | None, unit: str = "") -> str:
    """3 decimals below 10, 1 decimal above (accelerations), never 'nan'."""
    if v is None or not np.isfinite(v):
        return "—"
    s = f"{v:.1f}" if abs(v) >= 10 else f"{v:.3f}"
    return s


# ── charts (inline SVG, drawn to one scale) ──────────────────────────────────────────────


def _nice_max(v: float) -> float:
    if not np.isfinite(v) or v <= 0:
        return 1.0
    mag = 10 ** np.floor(np.log10(v))
    for m in (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if m * mag >= v:
            return float(m * mag)
    return float(10 * mag)


def _ticks(top: float, n: int = 4) -> list[float]:
    return [top * i / n for i in range(n + 1)]


def _path(xs: np.ndarray, ys: np.ndarray, sx, sy) -> str:
    """SVG path with a new segment after every gap (NaN)."""
    out, pen = [], False
    for x, y in zip(xs, ys, strict=True):
        if not np.isfinite(y):
            pen = False
            continue
        out.append(f"{'L' if pen else 'M'}{sx(x):.1f},{sy(y):.1f}")
        pen = True
    return "".join(out)


class Frame:
    """Plot area with margins; maps data to SVG units."""

    def __init__(
        self, w: int, h: int, x0: float, x1: float, ytop: float, left=46, right=16, top=12, bottom=30
    ):
        self.w, self.h = w, h
        self.l, self.r, self.t, self.b = left, right, top, bottom
        self.x0, self.x1, self.ytop = x0, x1, ytop

    def sx(self, x: float) -> float:
        return self.l + (x - self.x0) / (self.x1 - self.x0) * (self.w - self.l - self.r)

    def sy(self, y: float) -> float:
        return self.h - self.b - y / self.ytop * (self.h - self.t - self.b)

    def axes(self, xticks: list[float], xfmt, ylabel: str, xlabel: str) -> str:
        g = []
        for y in _ticks(self.ytop):
            py = self.sy(y)
            g.append(f'<line class="grid" x1="{self.l}" x2="{self.w - self.r}" y1="{py:.1f}" y2="{py:.1f}"/>')
            g.append(
                f'<text class="tick" x="{self.l - 6}" y="{py + 4:.1f}" text-anchor="end">{num(y)}</text>'
            )
        for x in xticks:
            px = self.sx(x)
            g.append(
                f'<text class="tick" x="{px:.1f}" y="{self.h - self.b + 16}" text-anchor="middle">{xfmt(x)}</text>'
            )
        g.append(
            f'<line class="axis" x1="{self.l}" x2="{self.w - self.r}" '
            f'y1="{self.sy(0):.1f}" y2="{self.sy(0):.1f}"/>'
        )
        g.append(
            f'<text class="axlabel" x="{self.w - self.r}" y="{self.h - 2}" text-anchor="end">{escape(xlabel)}</text>'
        )
        g.append(
            f'<text class="axlabel" x="{self.l}" y="{self.t - 2}" text-anchor="start">{escape(ylabel)}</text>'
        )
        return "".join(g)


def signal_chart(t: np.ndarray, h: HandDetail, ytop: float) -> str:
    f = Frame(720, 190, 0.0, float(np.ceil(t[-1])), ytop, top=18)
    xt = list(range(0, int(f.x1) + 1, 3))
    parts = [f.axes(xt, lambda x: f"{x:g}", tr("step2.yAxis"), tr("step2.xAxis"))]
    if h.raw is not None:
        parts.append(f'<path class="raw" d="{_path(t, h.raw, f.sx, f.sy)}"/>')
    if h.smooth is not None:
        parts.append(f'<path class="line {h.side}" d="{_path(t, h.smooth, f.sx, f.sy)}"/>')
        mins = sorted({i for c in h.cycles for i in c})
        for i in mins:
            parts.append(
                f'<circle class="dot {h.side}" cx="{f.sx(t[i]):.1f}" cy="{f.sy(h.smooth[i]):.1f}" r="3.5">'
                f"<title>{escape(tr('step2.closing'))} · {t[i]:.2f} s</title></circle>"
            )
    label = escape(tr(f"hands.{h.side}"))
    return f'<svg viewBox="0 0 {f.w} {f.h}" role="img" aria-label="{label}">{"".join(parts)}</svg>'


def one_tap_chart(t: np.ndarray, h: HandDetail, k: int = 1) -> tuple[str, str]:
    """Zoom on tap k (1-based) with its amplitude, period and fastest point marked."""
    i0, i1 = h.cycles[k - 1]
    y = h.smooth
    assert y is not None
    a = max(0, i0 - 12)
    b = min(t.size - 1, i1 + 12)
    seg = slice(i0, i1 + 1)
    imax = i0 + int(np.nanargmax(y[seg]))
    imin = i0 + int(np.nanargmin(y[seg]))
    v = np.gradient(y, t)
    ispd = i0 + int(np.nanargmax(np.abs(v[seg])))
    top = _nice_max(float(np.nanmax(y[a : b + 1])) * 1.15)
    f = Frame(720, 230, float(t[a]), float(t[b]), top, top=18, bottom=34)
    xs = np.arange(np.ceil(t[a] * 10) / 10, t[b], 0.1)
    p = [f.axes(list(xs), lambda x: f"{x:.1f}", tr("step2.yAxis"), tr("step2.xAxis"))]
    p.append(
        f'<rect class="band" x="{f.sx(t[i0]):.1f}" y="{f.t}" width="{f.sx(t[i1]) - f.sx(t[i0]):.1f}" '
        f'height="{f.h - f.t - f.b}"/>'
    )
    p.append(f'<path class="line {h.side}" d="{_path(t[a : b + 1], y[a : b + 1], f.sx, f.sy)}"/>')
    amp = float(y[imax] - y[imin])
    per = float(t[i1] - t[i0])
    # Amplitude: vertical bracket at the peak.
    xa = f.sx(t[imax]) + 26
    p.append(
        f'<line class="note" x1="{xa:.1f}" x2="{xa:.1f}" y1="{f.sy(y[imin]):.1f}" y2="{f.sy(y[imax]):.1f}"/>'
    )
    for yy in (y[imin], y[imax]):
        p.append(
            f'<line class="note" x1="{xa - 5:.1f}" x2="{xa + 5:.1f}" y1="{f.sy(yy):.1f}" y2="{f.sy(yy):.1f}"/>'
        )
    p.append(
        f'<text class="notetext" x="{xa + 9:.1f}" y="{(f.sy(y[imin]) + f.sy(y[imax])) / 2 + 4:.1f}">'
        f"{escape(tr('oneTap.amplitude', value=num(amp)))}</text>"
    )
    # Period: arrow between the two closings, under the curve.
    yp = f.sy(0) - 10
    p.append(
        f'<line class="note" x1="{f.sx(t[i0]):.1f}" x2="{f.sx(t[i1]):.1f}" y1="{yp:.1f}" y2="{yp:.1f}"/>'
    )
    p.append(
        f'<text class="notetext" x="{(f.sx(t[i0]) + f.sx(t[i1])) / 2:.1f}" y="{yp - 6:.1f}" '
        f'text-anchor="middle">{escape(tr("oneTap.period", value=num(per)))}</text>'
    )
    for i in (i0, i1):
        p.append(f'<circle class="dot {h.side}" cx="{f.sx(t[i]):.1f}" cy="{f.sy(y[i]):.1f}" r="4.5"/>')
    p.append(f'<circle class="ring" cx="{f.sx(t[ispd]):.1f}" cy="{f.sy(y[ispd]):.1f}" r="6"/>')
    p.append(
        f'<text class="notetext" x="{f.sx(t[ispd]) - 10:.1f}" y="{f.sy(y[ispd]) - 10:.1f}" text-anchor="end">'
        f"{escape(tr('oneTap.speed', value=num(abs(float(v[ispd])))))}</text>"
    )
    cap = tr("oneTap.body", n=k, hand=tr(f"hands.{h.side}").lower(), t0=f"{t[i0]:.2f}", t1=f"{t[i1]:.2f}")
    svg = f'<svg viewBox="0 0 {f.w} {f.h}" role="img" aria-label="{escape(cap)}">{"".join(p)}</svg>'
    return svg, cap


def per_tap_chart(hands: dict[str, HandDetail]) -> str:
    amps = {s: hands[s].per_cycle.get("amplitude", []) for s in SIDES}
    n = max((len(v) for v in amps.values()), default=0)
    if n == 0:
        return ""
    top = _nice_max(max(max(v) for v in amps.values() if v) * 1.1)
    f = Frame(720, 200, 1, max(n, 2), top, right=70, top=18)
    step = 5 if n > 20 else 2
    p = [
        f.axes(
            [1, *range(step, n + 1, step)], lambda x: f"{x:g}", tr("measures.amplitude"), tr("step3.xAxis")
        )
    ]
    for s in SIDES:
        v = amps[s]
        if not v:
            continue
        xs = np.arange(1, len(v) + 1)
        p.append(f'<path class="line {s}" d="{_path(xs, np.asarray(v), f.sx, f.sy)}"/>')
        for i, a in enumerate(v, 1):
            p.append(
                f'<circle class="dot {s}" cx="{f.sx(i):.1f}" cy="{f.sy(a):.1f}" r="3">'
                f"<title>{escape(tr(f'hands.{s}'))} · {escape(tr('step5.cols.tap'))} {i}: {num(a)}</title></circle>"
            )
        p.append(
            f'<text class="direct {s}" x="{f.sx(len(v)) + 8:.1f}" y="{f.sy(v[-1]) + 4:.1f}">'
            f"{escape(tr(f'summary.{s}'))}</text>"
        )
    return f'<svg viewBox="0 0 {f.w} {f.h}" role="img" aria-label="{escape(tr("step3.chart"))}">{"".join(p)}</svg>'


# ── the page ─────────────────────────────────────────────────────────────────────────────

CSS = """
:root {
  --ground: #f6f6fb; --card: #ffffff; --ink: #16151f; --sub: #4a4860; --muted: #7d7b93;
  --line: #e7e6f0; --soft: #f0effa; --brand: #4f46e5; --brand-soft: #ecebff;
  --right: #4f46e5; --left: #d9480f; --warn: #b45309; --warn-soft: #fff4e0; --ok: #047857;
  --display: "Space Grotesk", "Segoe UI", system-ui, sans-serif;
  --body: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --ground: #121119; --card: #1c1b26; --ink: #f2f1f8; --sub: #c4c2d6; --muted: #8e8ca6;
  --line: #2e2c3d; --soft: #24232f; --brand: #8b85ff; --brand-soft: #2a2850;
  --right: #7c75f0; --left: #e8692e; --warn: #f5b454; --warn-soft: #3a2a10; --ok: #4ade80; color-scheme: dark; } }
:root[data-theme="dark"] {
  --ground: #121119; --card: #1c1b26; --ink: #f2f1f8; --sub: #c4c2d6; --muted: #8e8ca6;
  --line: #2e2c3d; --soft: #24232f; --brand: #8b85ff; --brand-soft: #2a2850;
  --right: #7c75f0; --left: #e8692e; --warn: #f5b454; --warn-soft: #3a2a10; --ok: #4ade80; color-scheme: dark; }
body { background: var(--ground); color: var(--ink); font-family: var(--body); font-size: 15px; line-height: 1.55; }
.page { max-width: 880px; margin: 0 auto; padding-block: 32px 56px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: flex; flex-direction: column; gap: 22px; }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; margin: 0; letter-spacing: -0.01em; }
h1 { font-size: 34px; line-height: 1.1; }
h2 { font-size: 20px; display: flex; align-items: baseline; gap: 10px; }
h2 .n { font-family: var(--mono); font-size: 13px; color: var(--brand); font-weight: 600; }
h3 { font-size: 15px; }
p { margin: 0; max-width: 68ch; color: var(--sub); }
.kicker { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
header { display: flex; flex-direction: column; gap: 10px; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 13px; color: var(--sub); }
.facts b { color: var(--ink); font-weight: 600; }
.pill { align-self: flex-start; font-size: 13px; font-weight: 600; padding: 5px 12px; border-radius: 999px;
  background: var(--brand-soft); color: var(--brand); }
.demo { background: var(--warn-soft); color: var(--warn); border-radius: 14px; padding: 10px 14px; font-size: 14px; font-weight: 500; }
section { background: var(--card); border-radius: 20px; padding: 20px 22px; display: flex; flex-direction: column; gap: 14px;
  box-shadow: 0 1px 2px rgb(22 21 31 / 0.05), 0 8px 24px rgb(22 21 31 / 0.04); min-width: 0; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; font-variant-numeric: tabular-nums; }
th { text-align: left; font-size: 12px; font-weight: 600; color: var(--muted); padding: 6px 10px; border-bottom: 1px solid var(--line); }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.v { font-family: var(--mono); font-size: 13.5px; white-space: nowrap; }
td .u { color: var(--muted); font-family: var(--body); font-size: 12px; margin-left: 3px; }
td .id { display: block; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.na { color: var(--muted); font-family: var(--body); font-size: 12.5px; white-space: normal; }
.hint { font-size: 13px; color: var(--muted); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--sub); }
.key { display: inline-flex; align-items: center; gap: 6px; }
.key i { width: 18px; height: 3px; border-radius: 2px; display: inline-block; }
.key i.right { background: var(--right); } .key i.left { background: var(--left); } .key i.raw { background: var(--muted); opacity: .5; }
.key i.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ink); }
.charts { display: grid; gap: 14px; }
figure { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
figcaption { font-size: 13px; font-weight: 600; color: var(--ink); }
svg { width: 100%; height: auto; display: block; overflow: visible; }
svg .grid { stroke: var(--line); stroke-width: 1; }
svg .axis { stroke: var(--muted); stroke-width: 1; }
svg .tick, svg .axlabel { fill: var(--muted); font: 11px var(--body); font-variant-numeric: tabular-nums; }
svg .raw { fill: none; stroke: var(--muted); stroke-width: 1; opacity: .45; }
svg .line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
svg .line.right { stroke: var(--right); } svg .line.left { stroke: var(--left); }
svg .dot { stroke: var(--card); stroke-width: 2; } svg .dot.right { fill: var(--right); } svg .dot.left { fill: var(--left); }
svg .direct { font: 600 12px var(--body); fill: var(--ink); }
svg .band { fill: var(--soft); }
svg .note { stroke: var(--ink); stroke-width: 1.4; }
svg .notetext { fill: var(--ink); font: 600 12px var(--body); }
svg .ring { fill: none; stroke: var(--ink); stroke-width: 1.6; }
.steps { display: grid; gap: 6px; }
.calc { display: grid; gap: 10px; }
.calc .row { display: grid; gap: 2px; padding: 10px 12px; border-radius: 12px; background: var(--soft); min-width: 0; }
.calc .what { font-size: 13px; font-weight: 600; }
.calc .what .id { font-family: var(--mono); color: var(--brand); margin-right: 6px; }
.calc code { font-family: var(--mono); font-size: 12.5px; color: var(--ink); overflow-wrap: anywhere; }
.calc .rule { font-size: 12.5px; color: var(--muted); }
details summary { cursor: pointer; font-weight: 600; font-size: 14px; color: var(--brand); }
details summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; border-radius: 4px; }
footer { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--muted); }
footer p { color: var(--muted); }
@media (max-width: 560px) { h1 { font-size: 28px; } section { padding: 16px; } }
"""


def _value_cell(v: dict | None) -> str:
    if v is None:
        return '<td class="v">—</td>'
    if v["status"] != "COMPUTED":
        reason = v.get("reason", tr(f"status.{v['status']}"))
        return f'<td class="v"><span class="na">{escape(reason)}</span><span class="id">{v["id"]}</span></td>'
    unit = tr(f"units.{v.get('unit', 'ratio')}")
    u = f'<span class="u">{escape(unit)}</span>' if unit else ""
    return f'<td class="v">{num(v["value"])}{u}<span class="id">{v["id"]}</span></td>'


def _terms(vals: list[float]) -> str:
    if len(vals) <= 5:
        return " + ".join(num(x) for x in vals)
    return " + ".join(num(x) for x in vals[:3]) + " + … + " + num(vals[-1])


def render(
    result: dict,
    details: dict,
    *,
    ncid: str | None = None,
    recorded: str | None = None,
    demo: bool = False,
    standalone: bool = True,
) -> str:
    """The report as HTML. `standalone` adds the document shell (doctype, head, body)."""
    token = _TEST.set(result["testCode"])
    try:
        return _render(result, details, ncid=ncid, recorded=recorded, demo=demo, standalone=standalone)
    finally:
        _TEST.reset(token)


def lines_chart(t: np.ndarray, series: list[tuple[str, np.ndarray, str]], label: str) -> str:
    """Facial Activation: one or two signals over time, drawn to one scale (classes right / left)."""
    tops = [float(np.nanmax(v)) for _, v, _ in series if np.isfinite(v).any()]
    f = Frame(
        720,
        170,
        0.0,
        float(np.ceil(t[-1])) if t.size else 1.0,
        _nice_max(max(tops) * 1.05) if tops else 1.0,
        top=18,
    )
    parts = [
        f.axes(list(range(0, int(f.x1) + 1, 3)), lambda x: f"{x:g}", tr("step2.yAxis"), tr("step2.xAxis"))
    ]
    for _name, v, cls in series:
        parts.append(f'<path class="line {cls}" d="{_path(t, v, f.sx, f.sy)}"/>')
    return f'<svg viewBox="0 0 {f.w} {f.h}" role="img" aria-label="{escape(label)}">{"".join(parts)}</svg>'


def _fa_results(vals: dict) -> str:
    from .fa import LAYOUT as FA_LAYOUT

    groups: dict[str, list[str]] = {}
    for bid, kind, _names, _u in FA_LAYOUT:
        groups.setdefault(kind.replace("cc_speed", "cc"), []).append(bid)
    blocks = []
    for kind, ids in groups.items():
        rows = "".join(
            f"<tr><td>{escape(tr(f'measures.{bid}'))}</td>{_value_cell(vals.get(bid))}</tr>" for bid in ids
        )
        blocks.append(
            f"<h3>{escape(tr(f'groups.{kind}'))}</h3>"
            f'<div class="scroll"><table><thead><tr><th>{escape(tr("summary.measure"))}</th>'
            f"<th>{escape(tr('summary.value'))}</th></tr></thead><tbody>{rows}</tbody></table></div>"
        )
    return (
        f'<section aria-labelledby="results"><h2 id="results">{escape(tr("summary.title"))}</h2>'
        + "".join(blocks)
        + f'<p class="hint">{escape(tr("summary.hint"))}</p></section>'
    )


def _fa_sections(vals: dict, details: dict, cfg: dict, fps: float) -> list[str]:
    """Facial Activation: points found, the distances over time, and the calculations."""
    from .fa import LAYOUT as FA_LAYOUT

    t: np.ndarray = details["t"]
    sig: dict[str, np.ndarray] = details["face_signals"]
    out = [
        f'<section><h2><span class="n">1</span>{escape(tr("step1.title"))}</h2>'
        f'<p>{escape(tr("step1.body"))}</p><ul class="steps">'
        f"<li>{escape(tr('step1.faceFound', pct=round(details['found_frac'] * 100)))}</li>"
        f"<li>{escape(tr('step1.ied', n=details['ied_frames'], px=num(details['ied_px'])))}</li></ul></section>"
    ]
    p = cfg["preprocess"]
    sg = max(int(round(p["savgolWindowS"] * fps)) | 1, (p["savgolOrder"] + 2) | 1)
    charts = []
    for key, pair in (
        ("eyes", (("eye_r", "right"), ("eye_l", "left"))),
        ("brows", (("brow_r", "right"), ("brow_l", "left"))),
        ("mouth", (("mouth_r", "right"), ("mouth_l", "left"))),
        ("width", (("width", "right"),)),
        ("jaw", (("jaw", "right"),)),
    ):
        series = [(n, sig[n], c) for n, c in pair if np.isfinite(sig[n]).any()]
        if series and t.size:
            charts.append(
                f"<figure><figcaption>{escape(tr(f'signals.{key}'))}</figcaption>"
                f"{lines_chart(t, series, tr(f'signals.{key}'))}</figure>"
            )
    legend = (
        f'<div class="legend"><span class="key"><i class="right"></i>{escape(tr("signals.right"))}</span>'
        f'<span class="key"><i class="left"></i>{escape(tr("signals.left"))}</span></div>'
    )
    out.append(
        f'<section><h2><span class="n">2</span>{escape(tr("step2.title"))}</h2>'
        f"<p><code>{escape(tr('step2.formula'))}</code></p>"
        f"<p>{escape(tr('step2.pre', gap=p['maxGapS'], median=p['medianKernel'], sg=sg, sgs=p['savgolWindowS'], order=p['savgolOrder']))}</p>"
        f'{legend}<div class="charts">{"".join(charts)}</div></section>'
    )
    calc = []
    for bid, kind, _names, _u in FA_LAYOUT:
        v, c = vals[bid], details["calc"].get(bid, {})
        head = f'<span class="what"><span class="id">{bid}</span>{escape(tr(f"measures.{bid}"))}</span>'
        if v["status"] != "COMPUTED":
            body = f"<code>{escape(tr('step4.notComputed', reason=v.get('reason', '')))}</code>"
        elif kind == "niqr":
            body = (
                f'<span class="rule">{escape(tr("step4.rule.niqr"))}</span>'
                f"<code>{escape(tr('step4.niqr', p90=num(c['p90']), p10=num(c['p10']), value=num(v['value'])))}</code>"
            )
        elif kind in ("cc", "cc_speed"):
            body = (
                f'<span class="rule">{escape(tr(f"step4.rule.{kind}"))}</span>'
                f"<code>{escape(tr('step4.cc', n=c.get('n', 0), value=num(v['value'])))}</code>"
            )
        else:
            body = (
                f'<span class="rule">{escape(tr(f"step4.rule.{kind}"))}</span>'
                f"<code>{escape(tr('step4.std', n=c.get('n', 0), mean=num(c.get('mean')), value=num(v['value'])))}</code>"
            )
        calc.append(f'<div class="row">{head}{body}</div>')
    out.append(
        f'<section><h2><span class="n">3</span>{escape(tr("step4.title"))}</h2><div class="calc">{"".join(calc)}</div></section>'
    )
    return out


def _ftf_results(vals: dict) -> str:
    """Finger-to-Finger results: each measure for the left and the right hand, then both hands."""
    from .ftf import LAYOUT as FTF_LAYOUT
    from .ftf import PAIRS

    rows = "".join(
        f"<tr><td>{escape(tr(f'measures.{key}.{stat}'))}</td>{_value_cell(vals.get(lid))}{_value_cell(vals.get(rid))}</tr>"
        for lid, rid, key, stat, _u in FTF_LAYOUT
    )
    pairs = "".join(
        f"<tr><td>{escape(tr(f'measures.pair.{key}'))}</td>{_value_cell(vals.get(bid))}</tr>"
        for bid, key in PAIRS
    )
    return (
        f'<section aria-labelledby="results"><h2 id="results">{escape(tr("summary.title"))}</h2>'
        f'<div class="scroll"><table><thead><tr><th>{escape(tr("summary.measure"))}</th>'
        f"<th>{escape(tr('summary.left'))}</th><th>{escape(tr('summary.right'))}</th></tr></thead>"
        f"<tbody>{rows}</tbody></table></div>"
        f'<div class="scroll"><table><thead><tr><th>{escape(tr("summary.measure"))}</th>'
        f"<th>{escape(tr('summary.both'))}</th></tr></thead><tbody>{pairs}</tbody></table></div>"
        f'<p class="hint">{escape(tr("summary.hint"))}</p></section>'
    )


def _ftf_calc(vals: dict, hands: dict[str, HandDetail], pairs: dict[str, list[float]]) -> list[str]:
    """Each Finger-to-Finger value with its rule and its numbers put in."""
    from .ftf import LAYOUT as FTF_LAYOUT
    from .ftf import PAIRS

    out = []
    for lid, rid, key, stat, _u in FTF_LAYOUT:
        for s, bid in (("left", lid), ("right", rid)):
            h = hands[s]
            head = (
                f'<span class="what"><span class="id">{bid}</span>{escape(tr(f"measures.{key}.{stat}"))}'
                f" · {escape(tr(f'summary.{s}'))}</span>"
            )
            v = vals[bid]
            pc = h.per_cycle.get(key) or []
            if v["status"] != "COMPUTED" or not pc:
                body = (
                    f"<code>{escape(tr('step4.notComputed', reason=v.get('reason', h.reason or '')))}</code>"
                )
            elif stat == "mean":
                body = (
                    f'<span class="rule">{escape(tr(f"step4.perTap.{key}"))}</span>'
                    f"<code>{escape(tr('step4.mean', n=len(pc), terms=_terms(pc), sum=num(float(np.sum(pc))), value=num(v['value'])))}</code>"
                )
            else:
                body = f"<code>{escape(tr('step4.std', n=len(pc), mean=num(float(np.mean(pc))), value=num(v['value'])))}</code>"
            out.append(f'<div class="row">{head}{body}</div>')
    for bid, key in PAIRS:
        v = vals[bid]
        head = f'<span class="what"><span class="id">{bid}</span>{escape(tr(f"measures.pair.{key}"))}</span>'
        pc = pairs.get(key) or []
        if v["status"] != "COMPUTED" or not pc:
            body = f"<code>{escape(tr('step4.notComputed', reason=v.get('reason', '')))}</code>"
        else:
            body = (
                f'<span class="rule">{escape(tr(f"step4.pairRule.{key}"))}</span>'
                f"<code>{escape(tr('step4.mean', n=len(pc), terms=_terms(pc), sum=num(float(np.sum(pc))), value=num(v['value'])))}</code>"
            )
        out.append(f'<div class="row">{head}{body}</div>')
    return out


def _ftf_cycles_table(t: np.ndarray, h: HandDetail, side: str) -> str:
    head = "".join(f"<th>{escape(tr(f'step5.cols.{k}'))}</th>" for k in ("tap", "start", "period"))
    body = "".join(
        f"<tr><td>{i + 1}</td><td class='v'>{t[i0]:.2f}</td><td class='v'>{num(h.per_cycle['period'][i])}</td></tr>"
        for i, (i0, _i1) in enumerate(h.cycles)
    )
    return (
        f"<details><summary>{escape(tr('step5.show', n=len(h.cycles), hand=tr(f'hands.{side}').lower()))}</summary>"
        f'<div class="scroll"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div></details>'
    )


def _render(
    result: dict, details: dict, *, ncid: str | None, recorded: str | None, demo: bool, standalone: bool
) -> str:
    cfg = analysis_config()
    rows_layout = details.get("layout") or layout(result["testCode"])
    vals = {b["id"]: b for b in result["biomarkers"]}
    hands: dict[str, HandDetail] = details.get("hands", {})
    t: np.ndarray = details.get("t", np.zeros(0))
    fr = result["frames"]
    out: list[str] = ['<div class="page">']

    facts = []
    if ncid:
        facts.append(f"{escape(tr('take.ncid'))} <b>{escape(ncid)}</b>")
    if recorded:
        facts.append(f"{escape(tr('take.recorded'))} <b>{escape(recorded)}</b>")
    facts.append(f"{escape(tr('take.analysed'))} <b>{datetime.now(UTC).strftime('%d %b %Y, %H:%M UTC')}</b>")
    facts.append(
        f"{escape(tr('take.video'))} <b>"
        + escape(
            tr(
                "take.videoValue",
                count=fr["count"],
                fps=f"{fr['fps']:.0f}",
                duration=f"{fr['durationS']:.1f}",
            )
        )
        + "</b>"
    )
    out.append(
        f'<header><span class="kicker">{escape(tr("kicker"))}</span><h1>{escape(tr("title"))}</h1>'
        f'<div class="facts">{"".join(f"<span>{x}</span>" for x in facts)}</div>'
        f'<span class="pill">{escape(tr("decisionSupport"))}</span></header>'
    )
    if demo:
        out.append(f'<div class="demo" role="note">{escape(tr("demoBanner"))}</div>')

    is_ftf = result["testCode"] == "FTF"
    if result["testCode"] == "FA":
        out.append(_fa_results(vals))
        if details.get("face_signals"):
            out.extend(_fa_sections(vals, details, cfg, fr["fps"] or 60))
        hands = {}
        rows_layout = []
    # Results.
    rows = []
    if is_ftf:
        out.append(_ftf_results(vals))
    elif result["testCode"] == "FA":
        pass
    for rid, lid, aid, key, _unit in [] if is_ftf else rows_layout:
        rows.append(
            f"<tr><td>{escape(tr(f'measures.{key}'))}</td>"
            f"{_value_cell(vals.get(rid))}{_value_cell(vals.get(lid))}{_value_cell(vals.get(aid))}</tr>"
        )
    if not is_ftf and result["testCode"] != "FA":
        out.append(
            f'<section aria-labelledby="results"><h2 id="results">{escape(tr("summary.title"))}</h2>'
            f'<div class="scroll"><table><thead><tr><th>{escape(tr("summary.measure"))}</th>'
            f"<th>{escape(tr('summary.right'))}</th><th>{escape(tr('summary.left'))}</th>"
            f"<th>{escape(tr('summary.asym'))}</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>"
            f'<p class="hint">{escape(tr("summary.asymHint"))}</p></section>'
        )

    if hands:
        # 1. Points found.
        items = []
        for s in SIDES:
            h = hands[s]
            items.append(
                f"<li>{escape(tr('step1.found', hand=tr(f'hands.{s}'), pct=round(h.found_frac * 100)))}</li>"
            )
            items.append(
                "<li>"
                + escape(
                    tr(
                        "step1.forearm",
                        hand=tr(f"hands.{s}").lower(),
                        n=h.forearm_frames,
                        px=num(h.forearm_px),
                    )
                )
                + "</li>"
            )
        out.append(
            f'<section><h2><span class="n">1</span>{escape(tr("step1.title"))}</h2>'
            f'<p>{escape(tr("step1.body"))}</p><ul class="steps">{"".join(items)}</ul></section>'
        )

        # 2. The signal.
        p = cfg["preprocess"]
        fps = fr["fps"] or 60
        sg = max(int(round(p["savgolWindowS"] * fps)) | 1, (p["savgolOrder"] + 2) | 1)
        tops = [np.nanmax(h.raw) for h in hands.values() if h.raw is not None and np.isfinite(h.raw).any()]
        ytop = _nice_max(max(tops) * 1.05) if tops else 1.0
        charts = "".join(
            f"<figure><figcaption>{escape(tr(f'hands.{s}'))}</figcaption>{signal_chart(t, hands[s], ytop)}</figure>"
            for s in SIDES
            if hands[s].raw is not None and t.size
        )
        legend = (
            f'<div class="legend"><span class="key"><i class="raw"></i>{escape(tr("step2.raw"))}</span>'
            f'<span class="key"><i class="right"></i><i class="left"></i>{escape(tr("step2.smooth"))}</span>'
            f'<span class="key"><i class="dot"></i>{escape(tr("step2.closing"))}</span></div>'
        )
        out.append(
            f'<section><h2><span class="n">2</span>{escape(tr("step2.title"))}</h2>'
            f"<p><code>{escape(tr('step2.formula'))}</code></p>"
            f"<p>{escape(tr('step2.pre', gap=p['maxGapS'], median=p['medianKernel'], sg=sg, sgs=p['savgolWindowS'], order=p['savgolOrder']))}</p>"
            f'{legend}<div class="charts">{charts}</div></section>'
        )

        # 3. Taps, with one tap measured in detail.
        c = cfg["cycles"]
        counts = "".join(
            f"<li>{escape(tr('step3.count', hand=tr(f'hands.{s}'), n=len(hands[s].cycles)))}</li>"
            for s in SIDES
        )
        zoom = ""
        first = None if is_ftf else next((hands[s] for s in SIDES if hands[s].per_cycle), None)
        if first is not None:
            svg, cap = one_tap_chart(t, first)
            zoom = f'<figure><figcaption>{escape(tr("oneTap.title"))}</figcaption>{svg}<p class="hint">{escape(cap)}</p></figure>'
        out.append(
            f'<section><h2><span class="n">3</span>{escape(tr("step3.title"))}</h2>'
            f"<p>{escape(tr('step3.body', prom=round(c['minProminenceFrac'] * 100), gap=c['minPeriodS']))}</p>"
            f'<ul class="steps">{counts}</ul>{zoom}'
            + (
                ""
                if is_ftf
                else f"<figure><figcaption>{escape(tr('step3.chart'))}</figcaption>{per_tap_chart(hands)}</figure>"
            )
            + "</section>"
        )

        # 4. Calculations, with the numbers put in.
        calc = _ftf_calc(vals, hands, details.get("pairs") or {}) if is_ftf else []
        for rid, lid, aid, key, _u in [] if is_ftf else rows_layout:
            for s, bid in (("right", rid), ("left", lid)):
                h = hands[s]
                head = f'<span class="what"><span class="id">{bid}</span>{escape(tr(f"measures.{key}"))} · {escape(tr(f"summary.{s}"))}</span>'
                if h.reason:
                    body = f"<code>{escape(tr('step4.notComputed', reason=vals[bid].get('reason', h.reason)))}</code>"
                else:
                    pc = h.per_cycle[key]
                    body = (
                        f'<span class="rule">{escape(tr(f"step4.perTap.{key}"))}</span>'
                        f"<code>{escape(tr('step4.mean', n=len(pc), terms=_terms(pc), sum=num(float(np.sum(pc))), value=num(h.means[key])))}</code>"
                    )
                calc.append(f'<div class="row">{head}{body}</div>')
            r, left = hands["right"].means.get(key), hands["left"].means.get(key)
            head = f'<span class="what"><span class="id">{aid}</span>{escape(tr(f"measures.{key}"))} · {escape(tr("summary.asym"))}</span>'
            if r is None or left is None:
                body = f"<code>{escape(tr('step4.notComputed', reason=vals[aid].get('reason', '')))}</code>"
            else:
                body = f"<code>{escape(tr('step4.asym', r=num(r), l=num(left), diff=num(abs(r - left)), total=num(r + left), value=num(vals[aid]['value'])))}</code>"
            calc.append(f'<div class="row">{head}{body}</div>')
        out.append(
            f'<section><h2><span class="n">4</span>{escape(tr("step4.title"))}</h2><div class="calc">{"".join(calc)}</div></section>'
        )

        # 5. Every tap.
        tables = []
        for s in SIDES:
            h = hands[s]
            if not h.per_cycle:
                continue
            if is_ftf:
                tables.append(_ftf_cycles_table(t, h, s))
                continue
            cols = ("tap", "start", "period", *MEASURES[0:1], *MEASURES[2:])
            head = "".join(f"<th>{escape(tr(f'step5.cols.{k}'))}</th>" for k in cols)
            body = "".join(
                f"<tr><td>{i + 1}</td><td class='v'>{t[i0]:.2f}</td><td class='v'>{num(h.per_cycle['period'][i])}</td>"
                f"<td class='v'>{num(h.per_cycle['amplitude'][i])}</td><td class='v'>{num(h.per_cycle['speed'][i])}</td>"
                f"<td class='v'>{num(h.per_cycle['acceleration'][i])}</td></tr>"
                for i, (i0, _i1) in enumerate(h.cycles)
            )
            tables.append(
                f"<details><summary>{escape(tr('step5.show', n=len(h.cycles), hand=tr(f'hands.{s}').lower()))}</summary>"
                f'<div class="scroll"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div></details>'
            )
        out.append(
            f'<section><h2><span class="n">5</span>{escape(tr("step5.title"))}</h2>{"".join(tables)}</section>'
        )

    kp = result["keypoints"]
    out.append(
        "<footer>"
        f"<p>{escape(tr('footer.versions', analysis=result['analysisVersion'], registry=result['registryVersion'], library=kp['library'], version=kp['version'], models=', '.join(kp['models']) or '—'))}</p>"
        f"<p>{escape(tr('footer.sources'))}</p><p>{escape(tr('footer.privacy'))}</p></footer></div>"
    )
    head = (
        f"<title>{escape(tr('docTitle'))}</title>"
        '<meta name="claude:viewport-fit-sides" content="cover">'
        f"<style>{CSS}</style>"
    )
    page = head + "".join(out)
    if not standalone:
        return page
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
        f"{head}</head><body>{''.join(out)}</body></html>"
    )
