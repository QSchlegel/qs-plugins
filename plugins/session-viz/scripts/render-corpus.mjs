#!/usr/bin/env node
// Renders a corpus model (from corpus.mjs) into a self-contained HTML report.
//
//   node render-corpus.mjs corpus.json [--advice advice.json] [-o out.html] [--open]
//
// Same split as render.mjs: the model is deterministic, the advice file is
// optional and carries the model-written reading of it. The visual layer never
// depends on inference, so the charts stay true even with no advice attached.

import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const fmtTok = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n)
const pct = (n) => Math.round((n || 0) * 100) + '%'
const fmtDur = (ms) => {
  const m = Math.round(ms / 60000)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}
const day = (iso) => String(iso || '').slice(0, 10)

function css() {
  return `
:root{
  --bg:#fbfaf8; --panel:#fff; --ink:#1c1b19; --muted:#6b6862; --line:#e6e2db;
  --accent:#c2521a; --accent-soft:#fdf0e8; --ok:#2f6b46; --warn:#9a6a12; --bad:#b3261e;
  --bar:#d9d4cb; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742;
}}
:root[data-theme=dark]{
  --bg:#16151a; --panel:#1e1d23; --ink:#ece9e4; --muted:#9b968d; --line:#302e37;
  --accent:#ff8a4c; --accent-soft:#2a1d16; --ok:#6fbf8e; --warn:#e0b055; --bad:#ff6b5e;
  --bar:#3a3742;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;
  padding:28px 20px 60px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
  margin:36px 0 12px;font-weight:600}
.sub{color:var(--muted);font-size:13px;font-family:var(--mono)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}

/* trend hero */
.hero{display:flex;gap:22px;align-items:center;margin-top:18px}
.hero .dir{flex:none;min-width:132px;text-align:center;padding:14px 16px;border-radius:10px;
  border:1px solid var(--line);background:var(--bg)}
.hero .dir b{display:block;font-size:19px;letter-spacing:-.02em;text-transform:capitalize}
.hero .dir span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em}
.hero.improving .dir{border-color:var(--ok)} .hero.improving .dir b{color:var(--ok)}
.hero.worsening .dir{border-color:var(--bad)} .hero.worsening .dir b{color:var(--bad)}
.hero.flat .dir{border-color:var(--warn)} .hero.flat .dir b{color:var(--warn)}
.hero p{margin:0;color:var(--muted);font-size:13.5px}
.hero .big{color:var(--ink);font-size:15px;margin-bottom:5px}

/* chart */
.chart{margin-top:16px}
.chart svg{display:block;width:100%;height:auto}
.legend{display:flex;gap:16px;font-size:12px;color:var(--muted);margin-top:9px;flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}

/* stats */
/* Separators are drawn per-cell rather than as a 1px grid gap over a coloured
   background: with ten cells the last row is usually short, and a gap-based grid
   paints that remainder as one large slab of line colour. */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));
  background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.stat{background:var(--panel);padding:13px 15px;
  border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat .n{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.stat.hot .n{color:var(--bad)}

/* tables */
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);
  font-weight:600;padding:0 10px 7px;border-bottom:1px solid var(--line)}
th.r,td.r{text-align:right}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.num{font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px}
.name{font-weight:500}
.dim{color:var(--muted)}
.trk{display:inline-block;width:60px;height:5px;background:var(--bar);border-radius:3px;overflow:hidden;
  vertical-align:middle;margin-right:7px}
.trk i{display:block;height:100%;background:var(--bad)}
.trk.good i{background:var(--ok)}

/* signals */
.sig{border:1px solid var(--line);border-radius:9px;background:var(--panel);padding:14px 16px;margin-bottom:8px}
.sig h3{margin:0 0 3px;font-size:14px;font-family:var(--mono);font-weight:600;display:flex;
  align-items:center;gap:9px;flex-wrap:wrap}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.07em;padding:2px 7px;border-radius:999px;
  font-weight:600;border:1px solid var(--line);color:var(--muted)}
.badge.no{color:var(--muted)} .badge.yes{color:var(--ok);border-color:var(--ok)}
.badge.trap{color:var(--bad);border-color:var(--bad)}
.sig p{margin:4px 0 0;font-size:13px;color:var(--muted)}
.strata{display:flex;gap:7px;margin-top:10px;flex-wrap:wrap}
.stratum{font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-radius:6px;
  padding:5px 8px;color:var(--muted);background:var(--bg)}
.stratum.off{opacity:.45}
.stratum b{color:var(--ink);font-weight:600}

/* exemplars */
.pair{border:1px solid var(--line);border-radius:9px;background:var(--panel);margin-bottom:8px;overflow:hidden}
.pair > summary{padding:11px 15px;cursor:pointer;list-style:none;display:flex;gap:11px;align-items:center}
.pair > summary::-webkit-details-marker{display:none}
.pair > summary:hover{background:var(--accent-soft)}
.pair .txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13.5px}
.pair .body{padding:4px 15px 15px;border-top:1px solid var(--line)}
.pair pre{font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;word-break:break-word;
  background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:10px;margin:9px 0 0}
.pair .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-top:11px}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bad);color:#fff;font-weight:600}

/* drill-down cards */
.dd{border:1px solid var(--line);border-radius:9px;background:var(--panel);margin-bottom:7px;overflow:hidden}
.dd > summary{padding:12px 15px;cursor:pointer;list-style:none;display:grid;
  grid-template-columns:1fr auto;gap:14px;align-items:center}
.dd > summary::-webkit-details-marker{display:none}
.dd > summary:hover{background:var(--accent-soft)}
.dd[open] > summary{border-bottom:1px solid var(--line)}
.dd .hd{min-width:0}
.dd .hd b{font-weight:600;font-size:14.5px}
.dd .hd .sub2{font-size:11.5px;color:var(--muted);font-family:var(--mono);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;margin-top:2px}
.dd .glance{display:flex;gap:14px;align-items:center;font-family:var(--mono);font-size:12px;
  color:var(--muted);white-space:nowrap}
.dd .glance b{color:var(--ink);font-weight:600}
.dd .glance .hot{color:var(--bad)}
.dd .inner{padding:14px 15px 16px}
.mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(94px,1fr));
  background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:12px}
.mcell{padding:9px 11px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.mcell .n{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.mcell .l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:1px}
.mcell.hot .n{color:var(--bad)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:11px}
.chip2{font-family:var(--mono);font-size:11px;background:var(--bg);border:1px solid var(--line);
  border-radius:5px;padding:2px 7px;color:var(--muted)}
.chip2 b{color:var(--ink);font-weight:600}
.sublist{border:1px solid var(--line);border-radius:8px;overflow:hidden}
.sublist .row{display:grid;grid-template-columns:78px 1fr auto;gap:11px;padding:8px 11px;
  border-bottom:1px solid var(--line);font-size:13px;align-items:center}
.sublist .row:last-child{border-bottom:0}
.sublist .row .m{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap}
.inc{display:grid;grid-template-columns:auto 1fr auto;gap:10px;padding:7px 0;
  border-bottom:1px solid var(--line);font-size:13px;align-items:baseline}
.inc:last-child{border-bottom:0}
.inc .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inc .m{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap}
.lbl2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:13px 0 6px}

/* knowledge graph — Obsidian graph-view idiom: its own dark canvas, hairline
   links, small dots labelled underneath, and everything unrelated fading away
   the moment one node is touched. */
:root{
  --kg-bg:#f4f2ee; --kg-link:#d3cec5; --kg-text:#8a857c; --kg-text-strong:#3a3733;
}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
  --kg-bg:#131217; --kg-link:#37343f; --kg-text:#8b8794; --kg-text-strong:#e6e2ec;
}}
:root[data-theme=dark]{
  --kg-bg:#131217; --kg-link:#37343f; --kg-text:#8b8794; --kg-text-strong:#e6e2ec;
}
.graphwrap{overflow-x:auto;background:var(--kg-bg);border:1px solid var(--line);
  border-radius:9px;margin:-4px 0 2px}
#kg{display:block;width:100%;height:auto;min-width:660px;touch-action:pan-x}
#kg .ge{stroke:var(--kg-link);stroke-width:1;opacity:.75;transition:opacity .14s,stroke .14s}
#kg .gn{cursor:pointer}
#kg .gn circle{transition:opacity .14s,r .14s;stroke:none}
#kg .gn text{fill:var(--kg-text);pointer-events:none;
  font-family:ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;
  transition:opacity .14s,fill .14s}
#kg .gn.repo text{fill:var(--kg-text-strong);font-weight:600}
/* Sixty topic labels at once is unreadable, so they hold at a whisper and come
   up together as soon as the graph is engaged with. */
#kg .gn.topic text{opacity:.34}
#kg:hover .gn.topic text{opacity:.72}
#kg.focus .ge{opacity:.07}
#kg.focus .gn circle{opacity:.12}
#kg.focus .gn text{opacity:0}
#kg.focus .ge.on{opacity:1;stroke:var(--accent);stroke-width:1.6}
#kg.focus .gn.on circle{opacity:1}
#kg.focus .gn.on text{opacity:1;fill:var(--kg-text-strong)}
#kg.focus .gn.hit circle{stroke:var(--accent);stroke-width:2.5}

/* model adoption */
.adopt{display:flex;height:22px;border-radius:5px;overflow:hidden;border:1px solid var(--line)}
.adopt span{display:block;height:100%}
.adoptwk{display:grid;grid-template-columns:64px 1fr;gap:10px;align-items:center;margin-bottom:4px}
.adoptwk .w{font-family:var(--mono);font-size:11px;color:var(--muted)}
.mkey{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:10px}
.mkey i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}

.note{border-left:3px solid var(--warn);padding:2px 0 2px 14px;margin:0 0 11px;font-size:13.5px;color:var(--muted)}
.advice ul{margin:6px 0 0;padding-left:19px;color:var(--muted);font-size:14px}
.advice p.h{margin:12px 0 0;font-weight:600;color:var(--ink);font-size:13.5px}
.empty{color:var(--muted);font-style:italic;padding:16px;text-align:center}
footer{margin-top:44px;color:var(--muted);font-size:12px;font-family:var(--mono);
  border-top:1px solid var(--line);padding-top:14px}
`
}

// ---------------------------------------------------------------- chart

// Volume as bars behind two rate lines. Rates share one axis because both are
// percentages of turns; volume gets its own scale and sits behind deliberately,
// since it is context for how much a week's rate can be trusted, not a series
// to read against the others.
function chart(timeline) {
  if (timeline.length < 2) return '<div class="empty">Not enough weeks to plot a trend.</div>'
  const W = 1040
  const H = 210
  const pad = { l: 38, r: 12, t: 14, b: 26 }
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const n = timeline.length
  const maxRate = Math.max(0.1, ...timeline.map((b) => Math.max(b.frictionRate, b.craftRate)))
  const maxTurns = Math.max(1, ...timeline.map((b) => b.turns))
  const x = (i) => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw)
  const y = (v) => pad.t + ih - (v / maxRate) * ih
  const bw = Math.max(6, (iw / n) * 0.5)

  const bars = timeline
    .map((b, i) => {
      const h = (b.turns / maxTurns) * ih * 0.9
      return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(pad.t + ih - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="var(--bar)" opacity=".55"><title>${esc(b.week)}: ${b.turns} turns</title></rect>`
    })
    .join('')

  const line = (key, color) => {
    const pts = timeline.map((b, i) => `${x(i).toFixed(1)},${y(b[key]).toFixed(1)}`).join(' ')
    const dots = timeline
      .map(
        (b, i) =>
          `<circle cx="${x(i).toFixed(1)}" cy="${y(b[key]).toFixed(1)}" r="3.2" fill="${color}"><title>${esc(b.week)}: ${pct(b[key])} ${key.replace('Rate', '')} (${b.turns} turns)</title></circle>`
      )
      .join('')
    return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>${dots}`
  }

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = maxRate * f
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>
<text x="${pad.l - 7}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)" font-family="var(--mono)">${pct(v)}</text>`
    })
    .join('')

  // Label every other week when the axis would otherwise collide with itself.
  const step = n > 14 ? Math.ceil(n / 12) : 1
  const ticks = timeline
    .map((b, i) =>
      i % step === 0
        ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)" font-family="var(--mono)">${esc(b.week.slice(5))}</text>`
        : ''
    )
    .join('')

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Weekly friction and craft rates">
${grid}${bars}
${line('frictionRate', 'var(--bad)')}
${line('craftRate', 'var(--ok)')}
${ticks}
</svg>
<div class="legend">
  <span><i style="background:var(--bad)"></i>friction rate</span>
  <span><i style="background:var(--ok)"></i>craft rate</span>
  <span><i style="background:var(--bar)"></i>turns that week</span>
  <span class="dim">hover any point for the week</span>
</div></div>`
}

// ---------------------------------------------------------------- sections

function heroSection(m) {
  const t = m.trend
  if (!t.measurable) return `<div class="card"><p class="dim">Trend not measurable — ${esc(t.why)}.</p></div>`
  const dirWord = { improving: 'improving', worsening: 'worsening', flat: 'flat' }[t.direction]
  const delta = t.reworkRate.delta
  const arrow = delta < 0 ? '↓' : delta > 0 ? '↑' : '→'
  return `<div class="hero card ${esc(t.direction)}">
  <div class="dir"><b>${esc(dirWord)}</b><span>rework trend</span></div>
  <div>
    <p class="big">Rework ran at <strong>${pct(t.reworkRate.from)}</strong> of turns across ${esc(t.earlyWeeks[0])}–${esc(t.earlyWeeks[1])} and <strong>${pct(t.reworkRate.to)}</strong> across ${esc(t.lateWeeks[0])}–${esc(t.lateWeeks[1])} ${arrow} ${Math.abs(Math.round(delta * 100))} points.</p>
    <p>Measured on repeats, interruptions and corrections only — the round-trip tag is excluded because it tracks how tool-heavy the work was, not how the prompt was written. ${t.reworkRate.turnsCompared} turns compared over ${t.weeksCompared} weeks at each end.</p>
  </div>
</div>`
}

function statsSection(m) {
  const t = m.totals
  return [
    ['sessions', m.meta.sessionCount],
    ['turns', m.meta.turnCount],
    ['projects', m.meta.projectCount],
    ['friction', pct(t.frictionRate), t.frictionRate > 0.15],
    ['rework', pct(t.reworkRate), t.reworkRate > 0.1],
    ['craft', pct(t.craftRate)],
    ['repeats', t.repeats, t.repeats > 0],
    ['interrupts', t.interruptions, t.interruptions > 0],
    ['output tok', fmtTok(t.tokens.output)],
    ['cache read', fmtTok(t.tokens.cacheRead)],
  ]
    .map(([l, n, hot]) => `<div class="stat${hot ? ' hot' : ''}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`)
    .join('')
}

function taxonomySection(m) {
  const rows = Object.entries(m.taxonomy)
    .filter(([, v]) => v.count)
    .sort((a, b) => b[1].count - a[1].count)
  if (!rows.length) return '<div class="empty">No friction recorded anywhere in the corpus.</div>'
  const max = Math.max(...rows.map(([, v]) => v.count))
  return `<div class="card"><table>
<thead><tr><th>Incident</th><th class="r">Count</th><th class="r">Of turns</th><th class="r">Sessions</th><th class="r">Output tok</th></tr></thead>
<tbody>${rows
    .map(
      ([tag, v]) => `<tr>
  <td><span class="trk"><i style="width:${Math.round((v.count / max) * 100)}%"></i></span><span class="name">${esc(v.label)}</span>${v.isRework ? '' : ' <span class="dim">(not rework)</span>'}</td>
  <td class="r num">${v.count}</td><td class="r num">${pct(v.turnRate)}</td>
  <td class="r num">${v.sessions}</td><td class="r num">${fmtTok(v.outputTokens)}</td>
</tr>`
    )
    .join('')}</tbody></table></div>`
}

function signalsSection(m) {
  const anyReliable = m.signals.some((s) => s.reliable)
  const intro = anyReliable
    ? ''
    : `<div class="note">No prompt-form signal survived the workload control. Every apparent effect below is either inconsistent across workload strata or built on too few incidents to separate from chance — so nothing here supports advice of the form &ldquo;phrase prompts like X&rdquo;. The trend and incident sections are where the evidence is.</div>`
  const cards = m.signals
    .map((s) => {
      const badge = s.reliable ? '<span class="badge yes">holds up</span>' : '<span class="badge no">not supported</span>'
      const trap = s.rawMisleading ? '<span class="badge trap">raw figure misleads</span>' : ''
      const strata = s.strata
        .map(
          (st) =>
            `<span class="stratum${st.counts ? '' : ' off'}">${esc(st.label)} · <b>${pct(st.on.rework)}</b> <span class="dim">(n=${st.on.n})</span> vs ${pct(st.off.rework)} <span class="dim">(n=${st.off.n})</span></span>`
        )
        .join('')
      return `<div class="sig">
  <h3>${esc(s.signal)} ${badge}${trap}</h3>
  <p>${esc(s.verdict)}.</p>
  <p>Raw: ${s.raw.delta > 0 ? '+' : ''}${pct(s.raw.delta)} rework · controlled: ${s.strataUsed >= 2 ? `${s.pooledDelta > 0 ? '+' : ''}${pct(s.pooledDelta)} (z=${s.z}, ${s.onEvents} incidents)` : 'not testable'}</p>
  <div class="strata">${strata}</div>
</div>`
    })
    .join('')
  return intro + cards
}

// ---------------------------------------------------------------- drill-downs

const cell = (label, value, hot) =>
  `<div class="mcell${hot ? ' hot' : ''}"><div class="n">${esc(value)}</div><div class="l">${esc(label)}</div></div>`

const mgrid = (cells) => `<div class="mgrid">${cells.filter(Boolean).join('')}</div>`

const modelChips = (models) =>
  Object.entries(models || {})
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<span class="chip2">${esc(name)} <b>${n}</b></span>`)
    .join('')

// Incidents are joined from the flat corpus list rather than nested per group,
// so a turn appears once in the JSON and is reachable from both the project and
// the session view.
function incidentList(incidents, cap = 8) {
  if (!incidents.length) return '<p class="dim" style="font-size:13px;margin:0">No rework incidents.</p>'
  const shown = incidents.slice(0, cap)
  const rest = incidents.length - shown.length
  return (
    shown
      .map(
        (i) => `<div class="inc">
  <span>${i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</span>
  <span class="t" title="${esc(i.text)}">${esc(i.text)}</span>
  <span class="m">#${i.turn} · ${fmtTok(i.outputTokens)} · ${i.toolCalls}t</span>
</div>`
      )
      .join('') + (rest > 0 ? `<p class="dim" style="font-size:12px;margin:8px 0 0">+${rest} more not shown.</p>` : '')
  )
}

function projectsSection(m) {
  const bySession = new Map()
  for (const s of m.sessions) bySession.set(s.sessionId, s)
  return m.projects
    .map((p) => {
      const inc = m.incidents.filter((i) => i.project === p.name)
      const sessions = p.sessionIds
        .map((id) => bySession.get(id))
        .filter(Boolean)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      return `<details class="dd">
  <summary>
    <span class="hd"><b>${esc(p.name)}</b><span class="sub2">${esc(p.cwd)}</span></span>
    <span class="glance">
      <span><b>${p.sessions}</b> sess</span>
      <span><b>${p.turns}</b> turns</span>
      <span class="${p.reworkRate > 0.1 ? 'hot' : ''}"><b>${pct(p.reworkRate)}</b> rework</span>
      <span><b>${fmtTok(p.outputTokens)}</b> out</span>
    </span>
  </summary>
  <div class="inner">
    ${mgrid([
      cell('turns', p.turns),
      cell('sessions', p.sessions),
      cell('friction', pct(p.frictionRate), p.frictionRate > 0.15),
      cell('rework', pct(p.reworkRate), p.reworkRate > 0.1),
      cell('craft', pct(p.craftRate)),
      cell('repeats', p.repeats || '–', p.repeats > 0),
      cell('interrupts', p.interruptions || '–', p.interruptions > 0),
      cell('corrections', p.corrections || '–', p.corrections > 0),
      cell('tool calls', fmtTok(p.toolCalls)),
      cell('subagents', p.subagents || '–'),
      cell('output', fmtTok(p.outputTokens)),
      cell('cache read', fmtTok(p.cacheReadTokens)),
      cell('med prompt', p.medianPromptChars + 'c'),
      cell('worktrees', p.worktrees.length),
      cell('mean score', p.meanScore),
    ])}
    <div class="chips">${modelChips(p.models)}<span class="chip2">${esc(day(p.firstSeen))} → ${esc(day(p.lastSeen))}</span></div>
    ${
      p.worktrees.length > 1
        ? `<div class="lbl2">Worktrees (${p.worktrees.length})</div><div class="chips">${p.worktrees
            .map(
              (w) =>
                `<span class="chip2">${esc(w.name)} <b>${w.turns}</b>t${w.frictionTurns ? ` · ${w.frictionTurns}f` : ''}</span>`
            )
            .join('')}</div>`
        : ''
    }
    <div class="lbl2">Sessions</div>
    <div class="sublist">${sessions
      .map(
        (s) => `<div class="row">
  <span class="m">${esc(day(s.startedAt))}</span>
  <span class="t" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title || s.sessionId.slice(0, 8))}${s.worktree ? ` <span class="dim">· ${esc(s.worktree)}</span>` : ''}</span>
  <span class="m">${s.turns}t · ${s.frictionTurns || 0}f · ${fmtTok(s.tokens.output)} · score ${s.score}</span>
</div>`
      )
      .join('')}</div>
    <div class="lbl2">Rework incidents (${inc.length})</div>
    ${incidentList(inc)}
  </div>
</details>`
    })
    .join('')
}

function exemplarsSection(m) {
  const e = m.exemplars
  const out = []

  if (e.repeats.length) {
    out.push(`<h2>Prompts re-sent verbatim (${e.repeats.length})</h2>
<div class="note">The clearest evidence in the corpus: the same prompt sent twice means the first attempt produced nothing usable. Worth reading as a set — what they have in common is what to change.</div>`)
    out.push(
      e.repeats
        .map(
          (r) => `<details class="pair">
  <summary><span class="tag">repeat</span><span class="txt">${esc(r.text)}</span><span class="dim num" style="font-size:11px">${esc(r.project || '')} · #${r.firstTurn}→#${r.repeatTurn}</span></summary>
  <div class="body">
    <div class="lbl">Sent again at turn ${r.repeatTurn}, after turn ${r.firstTurn} ran ${r.firstToolCalls ?? '?'} tool calls</div>
    <pre>${esc(r.text)}</pre>
    <div class="lbl">${esc(day(r.at))} · session ${esc(String(r.sessionId).slice(0, 8))}</div>
  </div>
</details>`
        )
        .join('')
    )
  }

  if (e.corrections.length) {
    out.push(`<h2>Corrections and what drew them (${e.corrections.length})</h2>`)
    out.push(
      e.corrections
        .map(
          (c) => `<details class="pair">
  <summary><span class="tag">correction</span><span class="txt">${esc(c.correction.text)}</span><span class="dim num" style="font-size:11px">${esc(c.project || '')} · #${c.drewIt.turn}→#${c.correction.turn}</span></summary>
  <div class="body">
    <div class="lbl">Turn ${c.drewIt.turn} — ${c.drewIt.toolCalls} tool calls, ${fmtTok(c.drewIt.outputTokens)} output</div>
    <pre>${esc(c.drewIt.text)}</pre>
    <div class="lbl">Turn ${c.correction.turn} — the correction</div>
    <pre>${esc(c.correction.text)}</pre>
    <div class="lbl">${esc(day(c.at))} · session ${esc(String(c.sessionId).slice(0, 8))}</div>
  </div>
</details>`
        )
        .join('')
    )
  }

  if (e.worst.length) {
    out.push(`<h2>Most expensive turns that needed rework</h2>`)
    out.push(
      e.worst
        .map(
          (w) => `<details class="pair">
  <summary>${w.friction.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ')}<span class="txt">${esc(w.text)}</span><span class="dim num" style="font-size:11px">${fmtTok(w.outputTokens)} · ${w.toolCalls}t</span></summary>
  <div class="body">
    <pre>${esc(w.text)}</pre>
    <div class="lbl">${esc(day(w.at))} · ${esc(w.project || '')} · turn ${w.turn} · score ${w.score} · ${fmtTok(w.outputTokens)} output over ${fmtDur(w.durationMs)}</div>
  </div>
</details>`
        )
        .join('')
    )
  }

  return out.length ? out.join('\n') : '<h2>Exemplars</h2><div class="empty">No rework incidents to show.</div>'
}

const FRICTION_LABEL = {
  interrupted: 'interrupted',
  repeated: 'repeat',
  correction: 'correction',
  'drew-correction': 'drew correction',
  roundtrip: 'round-trip',
}

function sessionsSection(m) {
  const cards = m.sessions
    .slice()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .map((s) => {
      const inc = m.incidents.filter((i) => i.sessionId === s.sessionId)
      const tags = Object.entries(s.frictionTags || {})
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `<span class="chip2">${esc(FRICTION_LABEL[t] || t)} <b>${n}</b></span>`)
        .join('')
      return `<details class="dd">
  <summary>
    <span class="hd"><b>${esc(s.title || s.sessionId.slice(0, 8))}</b><span class="sub2">${esc(day(s.startedAt))} · ${esc(s.project)}${s.worktree ? ' ⑂ ' + esc(s.worktree) : ''}${s.gitBranch ? ' · ' + esc(s.gitBranch) : ''}</span></span>
    <span class="glance">
      <span><b>${s.turns}</b> turns</span>
      <span class="${s.frictionTurns ? 'hot' : ''}"><b>${s.frictionTurns || 0}</b> friction</span>
      <span><b>${fmtTok(s.tokens.output)}</b> out</span>
      <span><b>${s.score}</b>${s.confidence !== 'high' ? '?' : ''}</span>
    </span>
  </summary>
  <div class="inner">
    ${mgrid([
      cell('turns', s.turns),
      cell('friction', s.frictionTurns || '–', s.frictionTurns > 0),
      cell('repeats', s.repeats || '–', s.repeats > 0),
      cell('interrupts', s.interruptions || '–', s.interruptions > 0),
      cell('corrections', s.corrections || '–', s.corrections > 0),
      cell('compactions', s.compactions || '–'),
      cell('tool calls', fmtTok(s.toolCalls)),
      cell('subagents', s.subagents || '–'),
      cell('output', fmtTok(s.tokens.output)),
      cell('cache read', fmtTok(s.tokens.cacheRead)),
      cell('wasted', fmtTok(s.wastedTokens), s.wastedTokens > 0),
      cell('med prompt', (s.medianPromptChars || 0) + 'c'),
      cell('craft turns', s.craftTurns),
      cell('span', fmtDur(s.durationMs)),
      cell('score', `${s.score}`, s.score < 62),
    ])}
    <div class="chips">${modelChips(s.models)}</div>
    ${tags ? `<div class="lbl2">Friction</div><div class="chips">${tags}</div>` : ''}
    ${
      s.topTools?.length
        ? `<div class="lbl2">Tools</div><div class="chips">${s.topTools.map((t) => `<span class="chip2">${esc(t.name)} <b>${t.count}</b></span>`).join('')}</div>`
        : ''
    }
    <div class="lbl2">Rework incidents (${inc.length})</div>
    ${incidentList(inc)}
    <p class="dim" style="font-size:11.5px;margin:12px 0 0;font-family:var(--mono)">${esc(s.sessionId)}${s.confidence !== 'high' ? ` · score confidence ${esc(s.confidence)}` : ''}</p>
  </div>
</details>`
    })
    .join('')
  return `${cards}<p class="dim" style="font-size:12px;margin:12px 0 0">A <span class="num">?</span> marks a score built on fewer than 20 turns — low confidence on its own.</p>`
}

// ---------------------------------------------------------------- knowledge graph

// Obsidian's graph palette: one warm accent for the anchors, desaturated hues
// for the groups, all readable against the near-black canvas.
const KIND_COLOR = {
  repo: '#e0894a',
  package: '#6a9fd4',
  tool: '#8fbc6b',
  stack: '#c47ab0',
  skill: '#d9b45c',
  mcp: '#68b3b3',
}
const KIND_LABEL = { package: 'package', tool: 'CLI tool', stack: 'stack file', skill: 'skill', mcp: 'MCP server' }

function graphSection(m) {
  const g = m.graph
  if (!g || !g.nodes.length) return '<div class="empty">No shared topics found across projects.</div>'

  const { width, height, positions } = g.layout
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  // Sized by link count, as Obsidian does — a node's importance in a graph view
  // is how much it connects. Repos get a floor so the anchors stay findable.
  const maxDeg = Math.max(1, ...g.nodes.map((n) => n.degree))
  const radius = (n) =>
    (n.kind === 'repo' ? 6 : 3.2) + Math.sqrt(n.degree / maxDeg) * (n.kind === 'repo' ? 13 : 8)

  // Adjacency is emitted for the hover behaviour so the page can dim everything
  // that is not a neighbour — the whole point of the picture is "what connects
  // to what", which a static hairball cannot answer on its own.
  const adj = {}
  for (const e of g.edges) {
    ;(adj[e.source] ||= []).push(e.target)
    ;(adj[e.target] ||= []).push(e.source)
  }

  const edges = g.edges
    .map((e, i) => {
      const a = positions[e.source]
      const b = positions[e.target]
      if (!a || !b) return ''
      return `<line class="ge" data-a="${esc(e.source)}" data-b="${esc(e.target)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`
    })
    .join('')

  const nodes = g.nodes
    .map((n) => {
      const p = positions[n.id]
      if (!p) return ''
      const r = radius(n)
      const isRepo = n.kind === 'repo'
      const title = isRepo
        ? `${n.label} — ${n.turns} turns, ${n.degree} shared topics`
        : `${n.label} — ${KIND_LABEL[n.kind] || n.kind}, shared by ${n.degree} repositories`
      return `<g class="gn ${isRepo ? 'repo' : 'topic'}" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}">
  <circle cx="${p.x}" cy="${p.y}" r="${r.toFixed(1)}" fill="${KIND_COLOR[n.kind] || 'var(--bar)'}"><title>${esc(title)}</title></circle>
  <text x="${p.x}" y="${(p.y + r + 11).toFixed(1)}" text-anchor="middle" font-size="${isRepo ? 11.5 : 9.5}">${esc(n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label)}</text>
</g>`
    })
    .join('')

  const legend = ['repo', ...Object.keys(KIND_LABEL)]
    .map((k) => `<span><i style="background:${KIND_COLOR[k]}"></i>${esc(k === 'repo' ? 'repository' : KIND_LABEL[k])}</span>`)
    .join('')

  const relRows = g.related
    .slice(0, 15)
    .map(
      (r) => `<tr>
  <td><span class="name">${esc(r.a)}</span> <span class="dim">↔</span> <span class="name">${esc(r.b)}</span></td>
  <td class="r num">${r.score}</td>
  <td>${r.shared
    .slice(0, 9)
    .map((s) => `<span class="chip2">${esc(s)}</span>`)
    .join('')}${r.shared.length > 9 ? `<span class="chip2 dim">+${r.shared.length - 9}</span>` : ''}</td>
</tr>`
    )
    .join('')

  const bridgeRows = g.bridges
    .slice(0, 12)
    .map(
      (b) => `<tr>
  <td><span class="chip2" style="border-color:${KIND_COLOR[b.kind]}">${esc(b.topic)}</span> <span class="dim">${esc(KIND_LABEL[b.kind] || b.kind)}</span></td>
  <td class="r num">${b.repos.length}</td>
  <td class="dim" style="font-size:12.5px">${esc(b.repos.join(', '))}</td>
</tr>`
    )
    .join('')

  return `<div class="note">Built from what sessions <em>did</em> — packages imported, CLIs run, stack files edited, skills and MCP servers invoked — never from prompt wording. A topic is drawn only if it appears in ${g.gate.minRepos}–${g.gate.universalAt - 1} of your ${g.gate.repoCount} repositories: one repository is not a connection, and half of them is your default toolchain rather than a relationship.</div>

<div class="card" style="margin-bottom:14px">
  <div class="graphwrap"><svg viewBox="0 0 ${width} ${height}" id="kg" role="img" aria-label="Cross-project knowledge graph">
    <g class="edges">${edges}</g>
    <g class="nodes">${nodes}</g>
  </svg></div>
  <div class="mkey">${legend}<span class="dim">hover a node to isolate its connections</span></div>
</div>

<div class="lbl2">Most related repositories</div>
<div class="card" style="margin-bottom:14px"><table>
<thead><tr><th>Pair</th><th class="r">Score</th><th>Shared, most distinctive first</th></tr></thead>
<tbody>${relRows}</tbody></table>
<p class="dim" style="font-size:12px;margin:12px 0 0">Score is Jaccard overlap weighted by inverse document frequency, so a shared <span class="num">@prisma/client</span> counts for more than a shared <span class="num">docker</span>. It measures overlapping tooling, not that the code is related.</p></div>

<div class="lbl2">Topics bridging the most repositories</div>
<div class="card"><table>
<thead><tr><th>Topic</th><th class="r">Repos</th><th>Where</th></tr></thead>
<tbody>${bridgeRows}</tbody></table></div>

<script>window.__kgAdj=${JSON.stringify(adj)};</script>`
}

// ---------------------------------------------------------------- models

// Distinct hues rather than a sequential ramp: models are categories, and a
// ramp would imply an ordering the data does not support.
const MODEL_COLORS = ['var(--accent)', '#4a7fb5', '#7a9b4f', '#a8628f', '#c99a3d', 'var(--bar)']
const colorFor = (name, names) => MODEL_COLORS[Math.min(names.indexOf(name), MODEL_COLORS.length - 1)]

function modelsSection(m) {
  const mo = m.models
  const names = mo.rollup.map((x) => x.name)

  const adoption = m.timeline
    .map((b) => {
      const total = Object.values(b.models).reduce((a, n) => a + n, 0) || 1
      const segs = Object.entries(b.models)
        .sort((a, b2) => names.indexOf(a[0]) - names.indexOf(b2[0]))
        .map(
          ([name, n]) =>
            `<span style="width:${((n / total) * 100).toFixed(1)}%;background:${colorFor(name, names)}" title="${esc(b.week)} · ${esc(name)}: ${n} turns"></span>`
        )
        .join('')
      return `<div class="adoptwk"><span class="w">${esc(b.week.slice(5))}</span><div class="adopt">${segs}</div></div>`
    })
    .join('')

  const key = names
    .map((n) => `<span><i style="background:${colorFor(n, names)}"></i>${esc(n)}</span>`)
    .join('')

  const rows = mo.rollup
    .map(
      (x) => `<tr>
  <td><span class="name">${esc(x.name)}</span>${x.comparable ? '' : ' <span class="badge no">not compared</span>'}<br>
      <span class="dim num" style="font-size:11px">${x.firstAppeared ? 'appeared ' + esc(day(x.firstAppeared)) + ' · ' : ''}led ${esc(day(x.firstLed))} → ${esc(day(x.lastLed))} · ${x.weeks}w</span></td>
  <td class="r num">${x.turns}</td>
  <td class="r num">${x.sessions}</td>
  <td class="r num">${pct(x.reworkRate)} <span class="dim">(${x.reworkEvents})</span></td>
  <td class="r num">${x.toolsPerTurn}</td>
  <td class="r num">${fmtTok(x.outputPerTurn)}</td>
  <td class="r num">${fmtDur(x.medianDurationMs)}</td>
</tr>`
    )
    .join('')

  const pairs = mo.pairs
    .map(
      (p) => `<div class="sig">
  <h3>${esc(p.a)} vs ${esc(p.b)} ${p.comparable && p.significant ? '<span class="badge yes">separable</span>' : '<span class="badge no">not separable</span>'}${!p.sharedWeeks.length ? '<span class="badge trap">no overlap</span>' : ''}</h3>
  <p>${esc(p.why)}.</p>
  ${
    p.comparable
      ? `<p>Within the ${p.sharedWeeks.length} shared week(s): ${esc(p.a)} ${pct(p.aRework)} rework over ${p.aTurns} turns · ${esc(p.b)} ${pct(p.bRework)} over ${p.bTurns} turns.</p>
  <div class="strata"><span class="stratum">shared weeks · <b>${p.sharedWeeks.map(esc).join(', ')}</b></span></div>`
      : ''
  }
</div>`
    )
    .join('')

  return `<div class="note">Rework rates per model are <strong>not</strong> a benchmark. You adopt a new model and stop using the old one, so "newer model, less rework" and "you got better over those same weeks" are the same data. Only models that ran at volume <em>in the same weeks</em> can be separated, and each pair below states whether that was possible.</div>
<div class="card" style="margin-bottom:14px">
  <div class="lbl2" style="margin-top:0">Weekly share of turns</div>
  ${adoption}
  <div class="mkey">${key}</div>
</div>
<div class="card" style="margin-bottom:14px"><table>
<thead><tr><th>Model</th><th class="r">Turns</th><th class="r">Sessions</th><th class="r">Rework</th><th class="r">Tools/turn</th><th class="r">Out/turn</th><th class="r">Median turn</th></tr></thead>
<tbody>${rows}</tbody></table></div>
${pairs}`
}

function adviceSection(a) {
  if (!a) return ''
  const list = (label, arr) =>
    arr?.length
      ? `<p class="h">${esc(label)}</p><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : ''
  return `<h2>Reading</h2><div class="card advice">
  ${a.tldr ? `<p style="margin:0">${esc(a.tldr)}</p>` : ''}
  ${list('What the data supports', a.supported)}
  ${list('What changed over the span', a.changes)}
  ${list('Where projects connect', a.connections)}
  ${list('Do differently', a.recommendations)}
  ${list('Not supported by this corpus', a.unsupported)}
</div>`
}

// ---------------------------------------------------------------- render

export function render(m, advice) {
  const span = `${day(m.meta.span.from)} → ${day(m.meta.span.to)}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>qtrends — ${esc(m.meta.sessionCount)} sessions</title>
<style>${css()}</style></head><body><div class="wrap">

<h1>Session trends</h1>
<div class="sub">${esc(m.meta.sessionCount)} sessions · ${esc(m.meta.turnCount)} turns · ${esc(m.meta.projectCount)} projects · ${esc(span)}${m.meta.filter.project ? ' · filter: ' + esc(m.meta.filter.project) : ''}</div>

${heroSection(m)}
${chart(m.timeline)}

<h2>Corpus</h2>
<div class="stats">${statsSection(m)}</div>

${adviceSection(advice)}

<h2>Incident taxonomy</h2>
${taxonomySection(m)}

<h2>Cross-project knowledge graph</h2>
${graphSection(m)}

<h2>Models</h2>
${modelsSection(m)}

<h2>Prompt-form signals</h2>
${signalsSection(m)}

${exemplarsSection(m)}

<h2>Projects <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">— click any row to drill in</span></h2>
${projectsSection(m)}

<h2>Sessions <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">— click any row to drill in</span></h2>
${sessionsSection(m)}

<h2>What this cannot tell you</h2>
<div class="card"><ul style="margin:0;padding-left:19px;color:var(--muted);font-size:14px">
${m.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}
${m.meta.failures.length ? `<li>${m.meta.failures.length} transcript(s) failed to parse and are excluded.</li>` : ''}
${m.meta.excluded?.outOfWindow ? `<li>${m.meta.excluded.outOfWindow} session(s) fall outside the requested time window.</li>` : ''}
</ul></div>

<script>
(()=>{
  const svg=document.getElementById('kg'); if(!svg) return;
  const adj=window.__kgAdj||{};
  const nodes=[...svg.querySelectorAll('.gn')], edges=[...svg.querySelectorAll('.ge')];
  let pinned=null;
  const clear=()=>{svg.classList.remove('focus');
    nodes.forEach(n=>{n.classList.remove('on');n.classList.remove('hit');}); edges.forEach(e=>e.classList.remove('on'));};
  const focus=id=>{
    const keep=new Set([id,...(adj[id]||[])]);
    svg.classList.add('focus');
    nodes.forEach(n=>{n.classList.toggle('on',keep.has(n.dataset.id));
      n.classList.toggle('hit',n.dataset.id===id);});
    edges.forEach(e=>e.classList.toggle('on',e.dataset.a===id||e.dataset.b===id));
  };
  nodes.forEach(n=>{
    n.addEventListener('mouseenter',()=>{if(!pinned)focus(n.dataset.id)});
    n.addEventListener('mouseleave',()=>{if(!pinned)clear()});
    // Click pins, so a graph can be read without holding the pointer still.
    n.addEventListener('click',e=>{e.stopPropagation();
      if(pinned===n.dataset.id){pinned=null;clear();} else {pinned=n.dataset.id;focus(pinned);}});
  });
  svg.addEventListener('click',()=>{pinned=null;clear();});
})();
</script>

<footer>generated by /qtrends · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} · ${(m.meta.transcriptBytes / 1048576).toFixed(0)} MB of transcript across ${esc(m.meta.sessionCount)} sessions · ${esc(m.meta.subagents.files)} subagent transcripts not parsed · prompts redacted for secrets</footer>
</div></body></html>`
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n, d = null) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : d
  }
  const modelPath = argv.find((a) => !a.startsWith('--') && a.endsWith('.json') && a !== opt('--advice'))
  if (!modelPath) {
    console.error('usage: render-corpus.mjs corpus.json [--advice advice.json] [-o out.html] [--open]')
    process.exit(1)
  }
  const model = JSON.parse(readFileSync(modelPath, 'utf8'))
  const advicePath = opt('--advice')
  const advice = advicePath ? JSON.parse(readFileSync(advicePath, 'utf8')) : null
  const out = opt('-o') || opt('--out') || '/tmp/qtrends.html'

  // 0600: the page embeds verbatim prompt text and lands in a shared /tmp.
  writeFileSync(out, render(model, advice), { mode: 0o600 })
  chmodSync(out, 0o600) // writeFileSync honours mode only when it creates the file
  console.log(out)

  if (argv.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execFile(cmd, [out], (err) => {
      if (err) console.error(`could not open a window: ${err.message}\nfile is at ${out}`)
    })
  }
}
