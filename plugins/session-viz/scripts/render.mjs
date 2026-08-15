#!/usr/bin/env node
// Renders an extracted session spine into a self-contained interactive HTML doc.
//
//   node render.mjs spine.json [--intent intent.json] [-o out.html] [--open]
//
// The spine is deterministic (from extract.mjs); the intent file is optional and
// carries the model-derived TLDR, intent breakdown and the /compact instruction.
// Keeping them separate means the visual layer never depends on inference.

import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))


const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n))
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d`
}

const FRICTION_LABEL = {
  interrupted: 'interrupted',
  repeated: 'repeat',
  correction: 'correction',
  'drew-correction': 'drew correction',
  roundtrip: 'round-trip',
}

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
  margin:34px 0 12px;font-weight:600}
.sub{color:var(--muted);font-size:13px;font-family:var(--mono)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}

/* copy-pasteable compact line */
.compact{border-color:var(--accent);background:var(--accent-soft);margin-top:18px}
.compact .row{display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.compact code{font-family:var(--mono);font-size:13px;white-space:pre-wrap;word-break:break-word;
  display:block;color:var(--ink)}
button.copy{background:var(--accent);color:#fff;border:0;border-radius:7px;padding:8px 15px;
  font-size:13px;font-weight:600;cursor:pointer;flex:none}
button.copy:hover{filter:brightness(1.08)}
button.copy.done{background:var(--ok)}

/* score hero */
.score{display:flex;gap:22px;align-items:center;margin-top:18px}
.score .dial{flex:none;width:96px;height:96px;border-radius:50%;display:grid;place-items:center;
  background:conic-gradient(var(--sc) calc(var(--pct)*1%),var(--bar) 0);position:relative}
.score .dial::after{content:'';position:absolute;inset:7px;border-radius:50%;background:var(--panel)}
.score .dial b{position:relative;z-index:1;font-size:27px;font-weight:600;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums}
.score .meaning{flex:1}
.score .meaning h3{margin:0 0 3px;font-size:17px;text-transform:capitalize}
.score .meaning p{margin:0;color:var(--muted);font-size:13.5px}
.score .caveat{margin-top:7px;font-size:12.5px;color:var(--warn)}
.sc-clean{--sc:var(--ok)} .sc-solid{--sc:var(--ok)} .sc-mixed{--sc:var(--warn)}
.sc-costly{--sc:var(--bad)} .sc-poor{--sc:var(--bad)}
.chip{font-family:var(--mono);font-size:11px;font-weight:600;padding:1px 6px;border-radius:5px;
  border:1px solid var(--line);color:var(--muted)}
.chip.low{color:var(--bad);border-color:var(--bad)}
.ded{margin:10px 0 0;padding-left:17px;font-size:13px;color:var(--muted)}
.ded li.out{color:var(--bad)} .ded li.add{color:var(--ok)}

/* stats */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.stat{background:var(--panel);padding:13px 15px}
.stat .n{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.stat.hot .n{color:var(--bad)}

/* intents */
.intent{border-left:3px solid var(--line);padding:2px 0 2px 15px;margin:0 0 18px}
.intent.done{border-color:var(--ok)} .intent.partial{border-color:var(--warn)}
.intent.abandoned{border-color:var(--bad)} .intent.ongoing{border-color:var(--accent)}
.intent h3{margin:0 0 4px;font-size:15px;font-weight:600}
.intent p{margin:0;color:var(--muted);font-size:14px}
.pill{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;
  padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);
  margin-left:8px;vertical-align:2px;font-weight:600}

/* turns */
.filters{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:12px}
.filters button{background:var(--panel);border:1px solid var(--line);color:var(--muted);
  border-radius:999px;padding:5px 13px;font-size:12px;cursor:pointer;font-weight:500}
.filters button.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.turn{border:1px solid var(--line);border-radius:9px;background:var(--panel);
  margin-bottom:7px;overflow:hidden}
.turn.friction{border-left:3px solid var(--bad)}
.turn > summary{padding:11px 15px;cursor:pointer;display:grid;
  grid-template-columns:34px 1fr auto;gap:12px;align-items:center;list-style:none}
.turn > summary::-webkit-details-marker{display:none}
.turn > summary:hover{background:var(--accent-soft)}
.idx{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right}
.txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.meta{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;
  display:flex;gap:9px;align-items:center}
.bar{height:4px;background:var(--bar);border-radius:2px;width:54px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent)}
.tag{font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bad);color:#fff;
  font-weight:600;letter-spacing:.03em}
.body{padding:2px 15px 16px 61px;border-top:1px solid var(--line)}
.body pre{font-family:var(--mono);font-size:12.5px;white-space:pre-wrap;word-break:break-word;
  background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:11px;margin:12px 0}
.tools{display:flex;gap:6px;flex-wrap:wrap}
.tool{font-family:var(--mono);font-size:11px;background:var(--bg);border:1px solid var(--line);
  border-radius:5px;padding:2px 7px;color:var(--muted)}
.empty{color:var(--muted);font-style:italic;padding:20px;text-align:center}
footer{margin-top:44px;color:var(--muted);font-size:12px;font-family:var(--mono);
  border-top:1px solid var(--line);padding-top:14px}
`
}

function renderIntents(intent) {
  if (!intent?.intents?.length) return ''
  const items = intent.intents
    .map(
      (i) => `<div class="intent ${esc(i.status || 'ongoing')}">
  <h3>${esc(i.title)}<span class="pill">${esc(i.status || '')}</span></h3>
  <p>${esc(i.summary || '')}</p>
</div>`
    )
    .join('\n')
  return `<h2>Intent breakdown</h2>\n${items}`
}

function renderQuality(intent) {
  const q = intent?.quality
  if (!q) return ''
  const list = (label, arr) =>
    arr?.length ? `<p style="margin:10px 0 0"><strong>${label}</strong></p><ul style="margin:5px 0 0;padding-left:19px;color:var(--muted);font-size:14px">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''
  return `<h2>Prompting quality</h2><div class="card">
  <p style="margin:0">${esc(q.verdict || '')}</p>
  ${list('What worked', q.strengths)}
  ${list('What cost you', q.weaknesses)}
  ${list('Do differently', q.recommendations)}
</div>`
}

const BAND_MEANING = {
  clean: 'Prompts landed the first time. Little rework visible in the transcript.',
  solid: 'Mostly landed, with a few turns that needed a second pass.',
  mixed: 'A noticeable share of turns had to be repeated, corrected or interrupted.',
  costly: 'Rework dominated. A large fraction of turns did not land as written.',
  poor: 'Most turns required correction or were abandoned mid-flight.',
}

function renderScore(session) {
  const s = session.score
  if (!s || s.value === null) return ''
  const caveat =
    s.confidence !== 'high'
      ? `<div class="caveat">Confidence ${esc(s.confidence)} — only ${s.turnsScored} turns, so the outcome signals have little to witness. Treat this as weak evidence, not a verdict.</div>`
      : ''
  return `<div class="score card sc-${esc(s.band)}" style="--pct:${s.value}">
  <div class="dial"><b>${s.value}</b></div>
  <div class="meaning">
    <h3>${esc(s.band)}</h3>
    <p>${esc(BAND_MEANING[s.band] || '')}</p>
    <p style="margin-top:6px">${Math.round(s.frictionRate * 100)}% of turns showed friction · ${Math.round(s.craftRate * 100)}% named a file, criteria or code · ${fmtTokens(s.wastedTokens)} output tokens spent on turns that needed rework</p>
    ${caveat}
  </div>
</div>`
}

export function render(session, intent) {
  const t = session.totals
  const maxDur = Math.max(1, ...session.turns.map((x) => x.durationMs))
  const compactLine = intent?.compactInstruction ? `/compact ${intent.compactInstruction}` : null

  const stats = [
    ['turns', t.humanTurns],
    ['tool calls', t.toolCalls],
    ['output tok', fmtTokens(t.tokens.output)],
    ['cache read', fmtTokens(t.tokens.cacheRead)],
    ['friction', `${t.frictionTurns}`, t.frictionTurns > 0],
    ['repeats', `${t.repeats}`, t.repeats > 0],
    ['interrupts', `${t.interruptions}`, t.interruptions > 0],
    ['span', fmtDur(session.durationMs)],
  ]
    .map(([l, n, hot]) => `<div class="stat${hot ? ' hot' : ''}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`)
    .join('')

  const turns = session.turns
    .map((turn) => {
      const fr = turn.friction.length
      const tags = turn.friction.map((f) => `<span class="tag">${esc(FRICTION_LABEL[f] || f)}</span>`).join(' ')
      const flags = [
        turn.signals.hasAcceptanceCriteria && 'criteria',
        turn.signals.hasFileRef && 'file-ref',
        turn.signals.terse && 'terse',
        turn.signals.hasCodeBlock && 'code',
      ].filter(Boolean)
      const tools = turn.toolCalls.map((x) => `<span class="tool">${esc(x.name)}·${x.count}</span>`).join('')
      const pct = Math.round((turn.durationMs / maxDur) * 100)
      const repeat = turn.derived.repeatOf !== null ? `<p style="color:var(--bad);font-size:13px;margin:0 0 8px">Identical to turn #${turn.derived.repeatOf} — the first attempt did not land.</p>` : ''
      const sc = turn.score
      const why = [
        ...sc.deductions.map((d) => `<li class="out">${d.points} — ${esc(d.why)}</li>`),
        ...sc.additions.map((a) => `<li class="add">+${a.points} — ${esc(a.why)}</li>`),
      ].join('')
      const steer = turn.steering ? '<span class="tool">steering</span>' : ''
      return `<details class="turn${fr ? ' friction' : ''}" data-friction="${fr ? 1 : 0}" data-terse="${turn.signals.terse ? 1 : 0}" data-criteria="${turn.signals.hasAcceptanceCriteria ? 1 : 0}" data-steering="${turn.steering ? 1 : 0}">
  <summary>
    <span class="idx">#${turn.index}</span>
    <span class="txt">${esc(turn.text.replace(/\s+/g, ' ').slice(0, 150))}</span>
    <span class="meta">${tags}<span class="chip${sc.value < 62 ? ' low' : ''}">${sc.value}</span><span class="bar"><i style="width:${pct}%"></i></span>${esc(fmtDur(turn.durationMs))} · ${esc(String(turn.toolCallCount))}t · ${esc(fmtTokens(turn.tokens.output))}</span>
  </summary>
  <div class="body">
    ${repeat}
    <pre>${esc(turn.text)}</pre>
    <div class="tools">${tools || '<span class="tool">no tools</span>'}${steer}${flags.map((f) => `<span class="tool">${esc(f)}</span>`).join('')}</div>
    ${why ? `<ul class="ded">${why}</ul>` : '<p class="ded" style="list-style:none;padding:0">Scored at the ${72} baseline — nothing counted for or against it.</p>'}
  </div>
</details>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>qpact — ${esc(session.title || session.sessionId?.slice(0, 8))}</title>
<style>${css()}</style></head><body><div class="wrap">

<h1>${esc(session.title || 'Session analysis')}</h1>
<div class="sub">${esc(session.sessionId)} · ${esc(session.cwd || '')} · ${esc(session.gitBranch || '')}</div>

${
  compactLine
    ? `<div class="card compact"><div class="row">
  <code id="cl">${esc(compactLine)}</code>
  <button class="copy" id="cp">Copy</button>
</div></div>`
    : ''
}

${renderScore(session)}

${intent?.tldr ? `<h2>TL;DR</h2><div class="card">${esc(intent.tldr)}</div>` : ''}

<h2>Session shape</h2>
<div class="stats">${stats}</div>

${renderIntents(intent)}
${renderQuality(intent)}

<h2>Turns</h2>
<div class="filters">
  <button class="on" data-f="all">All ${session.turns.length}</button>
  <button data-f="friction">Friction ${t.frictionTurns}</button>
  <button data-f="steering">Steering ${t.steeringTurns}</button>
  <button data-f="terse">Terse</button>
  <button data-f="criteria">With criteria</button>
</div>
${turns || '<div class="empty">No human turns found.</div>'}

<footer>generated by /qpact · ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} · ${esc(String(t.records))} records analysed · prompts redacted for secrets</footer>
</div>
<script>
const cp=document.getElementById('cp');
if(cp)cp.onclick=async()=>{
  try{await navigator.clipboard.writeText(document.getElementById('cl').textContent);}
  catch{const r=document.createRange();r.selectNode(document.getElementById('cl'));
    getSelection().removeAllRanges();getSelection().addRange(r);document.execCommand('copy');}
  cp.textContent='Copied';cp.classList.add('done');
  setTimeout(()=>{cp.textContent='Copy';cp.classList.remove('done')},1600);
};
document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');
  const f=b.dataset.f;
  document.querySelectorAll('.turn').forEach(t=>{
    t.style.display = f==='all' || t.dataset[f]==='1' ? '' : 'none';
  });
});
</script></body></html>`
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n, d = null) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : d
  }
  const spinePath = argv.find((a) => !a.startsWith('--') && a.endsWith('.json'))
  if (!spinePath) {
    console.error('usage: render.mjs spine.json [--intent intent.json] [-o out.html] [--open]')
    process.exit(1)
  }
  const session = JSON.parse(readFileSync(spinePath, 'utf8'))
  const intentPath = opt('--intent')
  const intent = intentPath ? JSON.parse(readFileSync(intentPath, 'utf8')) : null
  const out = opt('-o') || opt('--out') || `/tmp/qpact-${(session.sessionId || 'session').slice(0, 8)}.html`

  // 0600: the page embeds verbatim prompt text and lands in a shared /tmp.
  writeFileSync(out, render(session, intent), { mode: 0o600 })
  chmodSync(out, 0o600) // writeFileSync honours mode only when it creates the file
  console.log(out)

  if (argv.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    execFile(cmd, [out], (err) => {
      if (err) console.error(`could not open a window: ${err.message}\nfile is at ${out}`)
    })
  }
}
