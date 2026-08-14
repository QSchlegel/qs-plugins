#!/usr/bin/env node
// Transactional email via Resend.
//
// Two rules shape this file:
//
// 1. NO CUSTOMER CONTENT IN AN EMAIL BODY. A notification says that something
//    happened and links to it; it does not carry the vault note, the task brief
//    or the prompt. Email is the least controlled channel we have — it lands in
//    inboxes we do not operate, gets forwarded, and is retained forever — so it
//    gets the same treatment as the operator console: metadata only. Templates
//    are checked against a deny-list at boot.
//
// 2. FAILING TO SEND MUST NOT FAIL THE ACTION. If Resend is down, a task handoff
//    still happens and the sign-in code is still valid; the send is recorded as
//    failed and the caller carries on. The one exception is the OTP itself,
//    where a silent failure would leave someone unable to sign in — that error
//    propagates.
//
// Without RESEND_API_KEY the service prints to the log instead, so a
// self-hosted install works on first boot and says plainly that it is doing so.

const RESEND_URL = 'https://api.resend.com/emails'

export const mailConfig = () => ({
  key: process.env.RESEND_API_KEY || '',
  from: process.env.MAIL_FROM || 'session-viz <noreply@session-viz.com>',
  replyTo: process.env.MAIL_REPLY_TO || '',
  appUrl: (process.env.APP_URL || 'https://session-viz.com').replace(/\/$/, ''),
  enabled: !!process.env.RESEND_API_KEY,
})

// Anything that could carry authored text. A template interpolating one of
// these is a bug, and boot treats it as one.
const FORBIDDEN = ['brief', 'body', 'note_text', 'prompt', 'content', 'noteBody', 'taskBrief']

export function assertNoContent(templates) {
  const bad = []
  for (const [name, fn] of Object.entries(templates)) {
    const src = fn.toString()
    for (const f of FORBIDDEN) {
      if (new RegExp(`[.\\[]['"]?${f}\\b`).test(src)) bad.push(`${name} interpolates ${f}`)
    }
  }
  if (bad.length) throw new Error(`mail templates must not carry customer content: ${bad.join('; ')}`)
  return true
}

// ---------------------------------------------------------------- shell

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Table-based, inline styles, light background with explicit colours: email
// clients strip <style>, ignore custom properties and force their own dark
// modes. Nothing here relies on CSS the way the web pages do.
const shell = (title, bodyHtml, footer) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f2ee;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e6e2db;border-radius:12px;">
    <tr><td style="padding:22px 26px 0 26px;">
      <span style="font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;color:#1c1b19;">SESSION<span style="color:#c2521a;">·</span>VIZ</span>
    </td></tr>
    <tr><td style="padding:18px 26px 4px 26px;">
      <h1 style="margin:0 0 10px 0;font:600 21px/1.25 -apple-system,Segoe UI,Inter,sans-serif;color:#1c1b19;">${esc(title)}</h1>
    </td></tr>
    <tr><td style="padding:0 26px 24px 26px;font:15px/1.6 -apple-system,Segoe UI,Inter,sans-serif;color:#4a4843;">
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:16px 26px 22px 26px;border-top:1px solid #e6e2db;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b6862;">
      ${footer || 'session-viz — observability for Claude Code sessions and agents.'}
    </td></tr>
  </table>
</td></tr></table></body></html>`

const button = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px 0;"><tr>
    <td style="background:#c2521a;border-radius:7px;">
      <a href="${esc(href)}" style="display:inline-block;padding:11px 20px;font:600 14px/1 -apple-system,Segoe UI,Inter,sans-serif;color:#ffffff;text-decoration:none;">${esc(label)}</a>
    </td></tr></table>`

const codeBlock = (code) =>
  `<div style="margin:18px 0;padding:16px;background:#f4f2ee;border:1px solid #e6e2db;border-radius:9px;text-align:center;
    font:700 30px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3em;color:#1c1b19;">${esc(code)}</div>`

// ---------------------------------------------------------------- templates

// Every trigger the application can fire. Each returns {subject, html, text};
// none takes a content field.
export const TEMPLATES = {
  'auth.otp': ({ code, minutes, appUrl }) => ({
    subject: `${code} is your session-viz sign-in code`,
    html: shell('Your sign-in code', `
      <p style="margin:0;">Enter this code to finish signing in. It expires in ${esc(minutes)} minutes and can be used once.</p>
      ${codeBlock(code)}
      <p style="margin:14px 0 0;color:#6b6862;font-size:13.5px;">If you did not ask for this, you can ignore it — nobody can sign in without the code.</p>`,
      `Sent by ${esc(appUrl)} because someone entered this address on the sign-in form.`),
    text: `Your session-viz sign-in code is ${code}. It expires in ${minutes} minutes and can be used once.\nIf you did not request it, ignore this email.`,
  }),

  'auth.new-device': ({ method, when, appUrl }) => ({
    subject: 'New sign-in to your session-viz account',
    html: shell('New sign-in', `
      <p style="margin:0;">Your account was signed in to using <b>${esc(method)}</b> at ${esc(when)}.</p>
      <p style="margin:14px 0 0;">If that was you, nothing to do. If it was not, sign in and revoke the session, or reply to this email.</p>`,
      `Sent by ${esc(appUrl)}. We notify on every new session — we cannot tell a new device from a returning one.`),
    text: `A new sign-in to session-viz using ${method} at ${when}. If this was not you, revoke the session.`,
  }),

  'auth.passkey-added': ({ when, appUrl }) => ({
    subject: 'A passkey was added to your session-viz account',
    html: shell('Passkey added', `
      <p style="margin:0;">A passkey was enrolled on your account at ${esc(when)}. It can now be used to sign in without a code.</p>
      <p style="margin:14px 0 0;">If you did not do this, remove it and contact us — a passkey you did not create is a serious signal.</p>`),
    text: `A passkey was added to your session-viz account at ${when}. If this was not you, remove it and contact us.`,
  }),

  'team.invited': ({ inviter, tenant, role, appUrl }) => ({
    subject: `You have been invited to the ${tenant} workspace`,
    html: shell('You have been invited', `
      <p style="margin:0;"><b>${esc(inviter)}</b> invited you to the <b>${esc(tenant)}</b> workspace on session-viz as a <b>${esc(role)}</b>.</p>
      <p style="margin:14px 0 0;">Sign in with this email address and you will join automatically. The invitation expires in 14 days.</p>
      ${button(appUrl, 'Sign in to accept')}`),
    text: `${inviter} invited you to the ${tenant} workspace on session-viz as a ${role}. Sign in with this address to accept; the invite expires in 14 days.\n${appUrl}`,
  }),

  'team.role-changed': ({ role, tenant, by, appUrl }) => ({
    subject: `Your role in ${tenant} is now ${role}`,
    html: shell('Your role changed', `
      <p style="margin:0;">${esc(by)} changed your role in <b>${esc(tenant)}</b> to <b>${esc(role)}</b>.</p>
      ${role === 'admin' ? '<p style="margin:14px 0 0;">As an admin you can invite members, change roles and suspend accounts in this workspace.</p>' : ''}`),
    text: `${by} changed your role in ${tenant} to ${role}.`,
  }),

  'team.suspended': ({ tenant, by }) => ({
    subject: `Your access to ${tenant} has been suspended`,
    html: shell('Access suspended', `
      <p style="margin:0;">${esc(by)} suspended your account in the <b>${esc(tenant)}</b> workspace. Existing sessions have been signed out.</p>
      <p style="margin:14px 0 0;">Your team admin can restore access.</p>`),
    text: `Your access to ${tenant} was suspended by ${by}. Existing sessions were signed out. Your team admin can restore access.`,
  }),

  'task.offered': ({ from, title, tenant, appUrl }) => ({
    subject: `${from} handed you a task`,
    html: shell('A task was handed to you', `
      <p style="margin:0;"><b>${esc(from)}</b> offered you a task in <b>${esc(tenant)}</b>:</p>
      <p style="margin:12px 0;padding:12px 14px;background:#f4f2ee;border-left:3px solid #c2521a;border-radius:0 7px 7px 0;font-weight:600;color:#1c1b19;">${esc(title)}</p>
      <p style="margin:0;">It is not yours until you accept it.</p>
      ${button(appUrl, 'Open session-viz')}`,
      'Only the title is included — the brief and any linked notes stay in the app.'),
    text: `${from} offered you a task in ${tenant}: "${title}". It is not yours until you accept it.\n${appUrl}`,
  }),

  'alert.no-delivery': ({ task, runs, days, appUrl }) => ({
    subject: `${task} has produced nothing in ${runs} runs`,
    html: shell('A scheduled task is failing silently', `
      <p style="margin:0;"><b>${esc(task)}</b> has run <b>${esc(runs)}</b> times over ${esc(days)} days and produced no verified artifact.</p>
      <p style="margin:14px 0 0;">Runs like this usually look healthy — coherent transcripts, correct plans, no errors — while shipping nothing. The most common cause is a permission the job was never granted.</p>
      ${button(appUrl + '/ops', 'Open the delivery ledger')}`),
    text: `${task} has run ${runs} times over ${days} days with no verified artifact. The usual cause is a missing permission.`,
  }),

  'alert.cost-drift': ({ task, factor, appUrl }) => ({
    subject: `${task} cost has drifted ${factor}x`,
    html: shell('Cost drift on a recurring task', `
      <p style="margin:0;"><b>${esc(task)}</b> is now costing about <b>${esc(factor)}×</b> its trailing median per run.</p>
      <p style="margin:14px 0 0;">A step change usually means the job is getting further before it fails, not that it is doing more useful work.</p>
      ${button(appUrl + '/ops', 'Open the control center')}`),
    text: `${task} is costing about ${factor}x its trailing median per run.`,
  }),

  'digest.weekly': ({ tenant, runs, delivered, denied, appUrl }) => ({
    subject: `session-viz weekly — ${tenant}`,
    html: shell('Your week', `
      <p style="margin:0 0 14px;">In <b>${esc(tenant)}</b> over the last seven days:</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#1c1b19;">
        <tr><td style="padding:6px 0;border-bottom:1px solid #e6e2db;">runs</td><td align="right" style="padding:6px 0;border-bottom:1px solid #e6e2db;"><b>${esc(runs)}</b></td></tr>
        <tr><td style="padding:6px 0;border-bottom:1px solid #e6e2db;">produced an artifact</td><td align="right" style="padding:6px 0;border-bottom:1px solid #e6e2db;"><b>${esc(delivered)}</b></td></tr>
        <tr><td style="padding:6px 0;">denied on a permission</td><td align="right" style="padding:6px 0;"><b>${esc(denied)}</b></td></tr>
      </table>
      ${button(appUrl, 'Open session-viz')}`,
      'Counts only. Nothing about any individual person appears in this email or in the product.'),
    text: `session-viz weekly for ${tenant}: ${runs} runs, ${delivered} produced an artifact, ${denied} denied on a permission.`,
  }),
}
assertNoContent(TEMPLATES)

// ---------------------------------------------------------------- delivery

export async function initMail(pool) {
  if (!pool) return
  // A record of what we sent to whom and whether it landed. Subject line only —
  // the body is reconstructible from the template and is not worth storing.
  await pool.query(`create table if not exists mail_log(
    id bigserial primary key,
    template text not null,
    recipient text not null,
    tenant text,
    subject text,
    status text not null,
    provider_id text,
    error text,
    at timestamptz not null default now()
  )`)
}

async function record(pool, row) {
  if (!pool) return
  try {
    await pool.query(
      `insert into mail_log(template,recipient,tenant,subject,status,provider_id,error)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [row.template, row.recipient, row.tenant || null, row.subject, row.status, row.providerId || null, row.error || null])
  } catch {}
}

export async function sendMail(pool, { template, to, tenant, vars = {}, critical = false }) {
  const cfg = mailConfig()
  const make = TEMPLATES[template]
  if (!make) throw new Error(`no such template: ${template}`)
  const msg = make({ ...vars, appUrl: cfg.appUrl })

  if (!cfg.enabled) {
    // Visible, greppable, and honest about why: a silent no-op here is how a
    // self-hosted install ends up wondering why nobody gets invited.
    console.log(`[mail:dry] ${template} -> ${to} :: ${msg.subject}`)
    if (template === 'auth.otp') console.log(`[mail:dry] code for ${to}: ${vars.code}`)
    await record(pool, { template, recipient: to, tenant, subject: msg.subject, status: 'dry-run' })
    return { sent: false, dryRun: true, reason: 'RESEND_API_KEY unset' }
  }

  try {
    const r = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: cfg.from, to: [to], subject: msg.subject, html: msg.html, text: msg.text,
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
        tags: [{ name: 'template', value: template.replace(/[^a-zA-Z0-9_-]/g, '_') }],
      }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body?.message || `resend ${r.status}`)
    await record(pool, { template, recipient: to, tenant, subject: msg.subject, status: 'sent', providerId: body.id })
    return { sent: true, id: body.id }
  } catch (e) {
    await record(pool, { template, recipient: to, tenant, subject: msg.subject, status: 'failed', error: e.message })
    // A failed notification must not roll back the thing it was notifying about.
    if (critical) throw e
    console.warn(`[mail] ${template} -> ${to} failed: ${e.message}`)
    return { sent: false, error: e.message }
  }
}

export const mailLog = async (pool, limit = 100) => {
  if (!pool) return []
  const { rows } = await pool.query(
    `select id,template,recipient,tenant,subject,status,error,at from mail_log order by id desc limit $1`,
    [Math.min(limit, 500)])
  return rows
}

export const mailHealth = async (pool) => {
  const cfg = mailConfig()
  if (!pool) return { enabled: cfg.enabled, from: cfg.from }
  const { rows } = await pool.query(
    `select status, count(*)::int as n from mail_log where at > now() - interval '7 days' group by status`)
  return { enabled: cfg.enabled, from: cfg.from, last7d: Object.fromEntries(rows.map((r) => [r.status, r.n])) }
}
