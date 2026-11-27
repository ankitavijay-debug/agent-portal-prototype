// Agent Portal prototype: personal agents (Claude, ChatGPT) talk ONLY to the portal agent.
// Portal owns the ledger, capability manifest, approvals and monitoring. Zero dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const poppy = require('./poppy');

const PORT = +process.env.PORT || 4310;
const TICK = +process.env.TICK || 2000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const POPPY_AUDIENCE = process.env.POPPY_AUDIENCE || PUBLIC_URL; // the Company identifier agents must put in `aud`
const POPPY_REQUIRED = process.env.POPPY_REQUIRED === '1';       // 1 = surface agents must use Poppy sessions, demo tokens refused
const POPPY_ALLOW_HTTP = process.env.POPPY_ALLOW_HTTP === '1';   // dev only: allow http client metadata
const FEEDBACK = [];

const now = () => Date.now();
const uid = (p) => p + '-' + crypto.randomBytes(3).toString('hex');
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 12);
const canon = (goalId, action, params = {}) => ({
  goalId, action,
  params: Object.keys(params).sort().reduce((a, k) => ((a[k] = params[k]), a), {}),
});
const r = (status, body) => ({ status, body });

// ---- Admin-editable policy: capability manifest, who may do what, thresholds ----
// Tier 0 read | 1 act + notify | 2 approval | 3 approval (+ step-up) | 4 human enterprise agent (+ Priya consent)
const DEFAULT_CONFIG = () => ({
  actions: {
    read_status:        { desc: 'Read case status',              tier: 0, approvers: [],                      stepup: false, reversible: true,  enabled: true },
    check_warranty:     { desc: 'Check warranty entitlement',    tier: 0, approvers: [],                      stepup: false, reversible: true,  enabled: true },
    book_technician:    { desc: 'Book or reschedule technician', tier: 1, approvers: [],                      stepup: false, reversible: true,  enabled: true },
    send_reminder:      { desc: 'Send reminder to Priya',        tier: 1, approvers: [],                      stepup: false, reversible: true,  enabled: true },
    pay_diagnostic_fee: { desc: 'Charge diagnostic fee',         tier: 2, approvers: ['priya'],               stepup: false, reversible: false, enabled: true, money: true, limit: 100, autoUpTo: 0 },
    close_case:         { desc: 'Mark case resolved',            tier: 2, approvers: ['priya'],               stepup: false, reversible: false, enabled: true },
    change_address:     { desc: 'Change service address',        tier: 3, approvers: ['priya'],               stepup: true,  reversible: false, enabled: true, personalData: true },
    warranty_exception: { desc: 'Goodwill warranty exception',   tier: 4, approvers: ['supervisor'], stepup: false, reversible: false, enabled: true },
  },
  // Tasks this company does not offer through ANY interface (Poppy excluded tasks). Account-based limits are errors, not exclusions.
  excluded: [
    { task: 'Cancel a service contract', alternative: 'Call the contracts team on the number in your agreement' },
    { task: 'Change the payment method on file', alternative: 'Sign in to the billing page in a browser' },
  ],
  // Poppy: registered personal agents (allowlist of client_id URLs) and linked users (opaque Poppy user ID -> account)
  poppy: { clients: [], users: {} },
  scopes: {
    claude:     ['read_status', 'check_warranty', 'send_reminder', 'pay_diagnostic_fee', 'close_case', 'change_address'],
    chatgpt:    ['read_status', 'check_warranty', 'send_reminder', 'pay_diagnostic_fee', 'close_case', 'change_address'],
    voice:      ['read_status', 'send_reminder', 'change_address', 'close_case'], // Acme phone line: no payments by voice
    'bg-agent': ['check_warranty', 'book_technician', 'send_reminder', 'pay_diagnostic_fee', 'warranty_exception', 'close_case'],
  },
  t: {
    approvalTtlMin: (+process.env.APPROVAL_TTL || 900000) / 60000,
    goalBudget: 100,
    budgetWarnPct: 80,
    stallSec: (+process.env.STALL_MS || 25000) / 1000,
    slowApprovalSec: (+process.env.SLOW_APPROVAL_MS || 180000) / 1000,
    loopGuardCalls: 14,
    autoRevokeAfter: 0,
    undoMin: 5,
  },
});
let CFG = DEFAULT_CONFIG();
const CHANGES = [];
const ttl = () => CFG.t.approvalTtlMin * 60000;
const effTier = (m, params) => (m.autoUpTo > 0 && params && params.amount !== undefined && params.amount <= m.autoUpTo && m.tier >= 2 ? 1 : m.tier);

const AGENTS = {
  'tok-claude':     { id: 'claude',     kind: 'surface' },
  'tok-chatgpt':    { id: 'chatgpt',    kind: 'surface' },
  'tok-voice':      { id: 'voice',      kind: 'surface' }, // Acme's own phone line (not a Poppy personal agent)
  'tok-bg':         { id: 'bg-agent',   kind: 'background' },
  'tok-priya':      { id: 'priya',      kind: 'human' },
  'tok-supervisor': { id: 'supervisor', kind: 'human' },
};

let S;
function fresh() {
  S = { goals: {}, approvals: {}, grants: {}, audit: [], alerts: [], idem: {}, notifications: [], revoked: {}, violations: {}, seq: 0,
        bgEnabled: true, metrics: { calls: 0, conflicts: 0, denied: 0, injections: 0, selfApprove: 0, tampers: 0, expired: 0 } };
}
fresh();

const authAgent = (tok) => (AGENTS[tok] ? { ...AGENTS[tok], actions: CFG.scopes[AGENTS[tok].id] || [], revoked: !!S.revoked[AGENTS[tok].id] } : null);
function violation(agentId, kind) { // repeated violations can auto-revoke an agent's delegated grant
  S.violations[agentId] = (S.violations[agentId] || 0) + 1;
  const n = CFG.t.autoRevokeAfter;
  if (n > 0 && S.violations[agentId] >= n && !S.revoked[agentId]) {
    S.revoked[agentId] = true; audit('portal', 'revoke', `${agentId} auto-revoked after ${n} violations (${kind})`);
    raise(`autorevoke-${agentId}`, 'high', `${agentId} auto-revoked after ${n} policy violations`, 'Grant revoked, admin notified');
  }
}

function audit(actor, type, detail, goalId, extra = {}) {
  S.audit.push({ seq: ++S.seq, ts: now(), actor, type, detail, goalId, ...extra });
  if (S.audit.length > 400) S.audit.shift();
}
function logEvent(g, actor, type, detail, extra = {}) {
  g.events.push({ seq: ++S.seq, ts: now(), actor, type, detail, version: g.version, ...extra });
}
function raise(key, severity, msg, response) {
  if (S.alerts.some((a) => a.key === key && !a.cleared)) return;
  S.alerts.push({ key, ts: now(), severity, msg, response, cleared: false });
}
function refreshStatus(g) {
  if (g.status === 'resolved' || g.status === 'paused') return;
  const pending = Object.values(S.approvals).some((a) => a.goalId === g.id && a.status === 'pending');
  g.status = pending ? 'waiting_approval' : 'active';
}

function brief(g) {
  const f = g.facts, p = [];
  p.push(`Goal: ${g.objective} (status ${g.status}, v${g.version}, spent $${g.spent} of $${g.constraints.budget})`);
  if (f.warranty) p.push(`Warranty: ${f.warranty.status}${f.warranty.expiredDaysAgo ? ` (expired ${f.warranty.expiredDaysAgo} days ago)` : ''}`);
  if (f.tech) p.push(`Technician: ${f.tech.slot} (${f.tech.basis})`);
  if (f.exception) p.push(`Exception: ${f.exception}`);
  if (f.feePaid) p.push(`Diagnostic fee paid: $${f.feePaid}`);
  const pend = Object.values(S.approvals).filter((a) => a.goalId === g.id && a.status === 'pending');
  if (pend.length) p.push(`Waiting on: ${pend.map((a) => a.action + ' (' + a.stages[a.stage] + ')').join(', ')}`);
  return p.join('. ');
}

// ---- Simulated Acme back-end systems (stand-ins for the real integrations) ----
const DAY = 86400000, DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ASSETS = [ // Acme asset and entitlement records for Priya (simulated)
  { item: 'fridge', product: 'CoolMax 500 French-door refrigerator', serial: 'CM5-220817', warrantyDaysLeft: -3, plan: 'Standard 2-year' },
  { item: 'washer', product: 'AquaWash 7 front-load washer', serial: 'AW7-190402', warrantyDaysLeft: 210, plan: 'Standard 2-year' },
];
function lookupAsset(objective) { const t = objective.toLowerCase(); return ASSETS.find((a) => t.includes(a.item)) || ASSETS[0]; }
function fmtHour(h) { return (h % 12 || 12) + (h < 12 ? 'am' : 'pm'); }
function scheduleSlots() { // field-service availability for the next business days (simulated, deterministic)
  const out = [], d = new Date(); d.setHours(0, 0, 0, 0);
  for (let i = 1; out.length < 14 && i < 14; i++) {
    const x = new Date(d.getTime() + i * DAY), dow = x.getDay(); if (dow === 0) continue;
    const label = `${DOW[dow]} ${x.getDate()}/${x.getMonth() + 1}`;
    for (const [from, to, open] of [[8, 10, i % 3 !== 1], [12, 14, i % 2 === 0], [17, 19, i % 2 === 1], [18, 20, dow !== 6]]) if (open && !(dow === 6 && from >= 17)) out.push({ day: label, dow, from, to, text: `${label} ${fmtHour(from)}-${fmtHour(to)}` });
  }
  return out;
}
function parseConstraints(text) { // what the personal agent said the customer wants; kept on the goal
  const t = text.toLowerCase();
  if (/evening|after work|after 5/.test(t)) return { window: 'evenings (after 5pm)', after: 17, before: 24, note: 'from "evenings only"' };
  if (/morning/.test(t)) return { window: 'mornings (before noon)', after: 0, before: 12, note: 'from "mornings"' };
  if (/weekend|saturday/.test(t)) return { window: 'Saturday', saturdayOnly: true, after: 0, before: 24, note: 'from "weekend"' };
  return { window: 'any weekday time', after: 0, before: 24, note: 'no preference given' };
}
function pickSlot(g) {
  const c = g.constraints, all = scheduleSlots();
  const ok = all.filter((s) => (c.saturdayOnly ? s.dow === 6 : true) && s.from >= (c.after || 0) && s.to <= (c.before || 24));
  return { slot: ok[0] || all[0], matched: !!ok[0], total: all.length, fit: ok.length };
}

// ---- Effects (simulated back-end systems) ----
function execute(g, ag, action, params) {
  const f = g.facts;
  switch (action) {
    case 'check_warranty': {
      const a = lookupAsset(g.objective), left = a.warrantyDaysLeft;
      f.warranty = left >= 0 ? { status: 'active', daysLeft: left, product: a.product, serial: a.serial } : { status: 'expired', expiredDaysAgo: -left, product: a.product, serial: a.serial };
      logEvent(g, 'bg-agent', 'lookup', `Asset record found: ${a.product} (${a.serial}), ${a.plan} plan. ${left >= 0 ? 'Warranty active, ' + left + ' days left' : 'Warranty expired ' + (-left) + ' days ago'}`); break; }
    case 'book_technician': {
      const p = pickSlot(g); f.tech = { slot: p.slot.text, basis: p.matched ? `matches ${g.constraints.window} (${g.constraints.note}); earliest of ${p.fit} fitting slots out of ${p.total} open` : `no slot fits ${g.constraints.window}; took earliest open slot, flagged to Priya` };
      logEvent(g, 'bg-agent', 'lookup', `Scheduling system: ${p.total} open slots. Booked ${f.tech.slot}, ${f.tech.basis}`); break; }
    case 'send_reminder': f.reminder = true; S.notifications.push({ ts: now(), text: `Reminder to Priya: ${f.tech ? 'technician ' + f.tech.slot : 'visit pending'}` }); break;
    case 'pay_diagnostic_fee': g.spent += params.amount; f.feePaid = params.amount; break;
    case 'change_address': f.address = params.address; break;
    case 'warranty_exception': f.exception = 'granted'; f.warranty = { ...f.warranty, status: 'goodwill-covered' }; break;
    case 'close_case': g.status = 'resolved'; f.closed = true; break;
  }
  if (action !== 'read_status') { g.version++; g.lastProgress = now(); }
}

// ---- The single entry point for every action by any agent ----
function act(tok, b) {
  S.metrics.calls++;
  const ag = authAgent(tok);
  if (!ag || ag.kind === 'human') return r(401, { error: 'invalid agent token' });
  const { goalId, action, params = {}, version, idemKey, grantId, why } = b || {};
  if (ag.revoked) { audit(ag.id, 'denied', `${action}: grant revoked`, goalId); S.metrics.denied++; return r(403, { error: 'grant revoked' }); }
  const g = S.goals[goalId];
  if (!g) return r(404, { error: 'unknown goal' });
  const m = CFG.actions[action];
  if (!m) return r(400, { error: 'unknown action' });
  if (!m.enabled) { S.metrics.denied++; audit(ag.id, 'denied', `${action}: disabled by admin`, goalId); return r(403, { error: `${action} is disabled by the portal admin`, code: 'task_excluded', see: PUBLIC_URL + '/poppy/tasks' }); }
  if (!ag.actions.includes(action)) {
    S.metrics.denied++; audit(ag.id, 'denied', `${action}: outside agent scope`, goalId);
    raise(`scope-${ag.id}-${action}`, 'high', `${ag.id} attempted ${action} outside its scope`, 'Request denied and logged'); violation(ag.id, 'scope');
    return r(403, { error: `${action} is outside ${ag.id}'s scope` });
  }
  if (idemKey && S.idem[idemKey]) return S.idem[idemKey];
  if (g.status === 'paused') return r(423, { error: 'goal paused by monitoring' });
  if (g.status === 'resolved') return r(409, { error: 'goal already resolved' });

  if (ag.kind === 'background') { // loop guard
    g.bgCalls = (g.bgCalls || []).filter((t) => now() - t < 10000); g.bgCalls.push(now());
    if (g.bgCalls.length > CFG.t.loopGuardCalls) {
      g.status = 'paused'; logEvent(g, 'monitor', 'paused', 'Loop guard: too many background calls');
      raise(`loop-${g.id}`, 'high', 'Background agent looping', 'Goal paused, escalated to human');
      return r(423, { error: 'loop guard' });
    }
  }
  if (m.limit && params.amount > m.limit) {
    S.metrics.denied++; audit(ag.id, 'denied', `${action}: $${params.amount} exceeds limit $${m.limit}`, goalId, { tier: m.tier });
    logEvent(g, ag.id, 'denied', `${action} $${params.amount} exceeds per-action limit $${m.limit}`, { tier: m.tier });
    return r(422, { error: `amount exceeds limit of $${m.limit}` });
  }
  if (action === 'pay_diagnostic_fee' && g.spent + params.amount > g.constraints.budget) {
    S.metrics.denied++; logEvent(g, ag.id, 'denied', `${action} would exceed goal budget $${g.constraints.budget}`, { tier: m.tier });
    return r(422, { error: 'would exceed goal budget' });
  }

  const tier = effTier(m, params);
  const res = (() => {
    if (tier === 0) { // read: no version check
      execute(g, ag, action, params);
      logEvent(g, ag.id, 'action', `${action}`, { tier: 0, via: ag.id });
      audit(ag.id, 'action', action, goalId, { tier: 0 });
      return r(200, { ok: true, version: g.version, brief: brief(g) });
    }
    if (version !== undefined && version !== g.version) { // optimistic concurrency: stale writer rejected
      S.metrics.conflicts++; audit(ag.id, 'conflict', `${action}: v${version} != v${g.version}`, goalId);
      logEvent(g, ag.id, 'conflict', `Stale write rejected for ${action} (had v${version}, current v${g.version})`);
      raise(`conflict-${g.id}`, 'medium', `Version conflict on ${g.id}: ${ag.id} acted on stale state`, 'Write rejected, agent told to re-read');
      return r(409, { error: 'stale version', current: g.version });
    }
    if (grantId) { // redeem a signed approval grant
      const gr = S.grants[grantId];
      const h = sha(canon(goalId, action, params));
      if (!gr || gr.used || gr.exp < now() || gr.requester !== ag.id) return r(403, { error: 'grant invalid, used or expired' });
      if (gr.hash !== h) {
        S.metrics.tampers++; audit(ag.id, 'tamper', `${action}: params differ from approved action`, goalId);
        logEvent(g, ag.id, 'tamper', `Grant ${gr.id} refused: parameters differ from what was approved`);
        raise(`tamper-${gr.id}`, 'high', `${ag.id} tried to redeem grant ${gr.id} with altered parameters`, 'Grant refused, kept unused'); violation(ag.id, 'tamper');
        return r(403, { error: 'action does not match approved hash' });
      }
      gr.used = true; S.approvals[gr.approvalId].status = 'redeemed';
      execute(g, ag, action, params);
      logEvent(g, ag.id, 'action', `${action} executed under grant ${gr.id}`, { tier: m.tier, approval: gr.approvalId });
      audit(ag.id, 'action', `${action} (grant ${gr.id})`, goalId, { tier: m.tier });
      refreshStatus(g);
      return r(200, { ok: true, version: g.version });
    }
    if (tier === 1) {
      execute(g, ag, action, params);
      logEvent(g, ag.id, 'action', `${action}${params.slot ? ' ' + params.slot : ''} (Priya notified, ${CFG.t.undoMin} min undo)`, { tier: 1 });
      audit(ag.id, 'action', action, goalId, { tier: 1 });
      return r(200, { ok: true, version: g.version });
    }
    // Tier 2-4: needs human approval. Agents cannot execute these on their own.
    const h = sha(canon(goalId, action, params));
    let ap = Object.values(S.approvals).find((a) => a.hash === h && a.status === 'pending');
    if (!ap) {
      ap = { id: uid('apr'), goalId, action, params, hash: h, tier: m.tier, requester: ag.id, stages: (m.approvers && m.approvers.length ? m.approvers : ['priya']).slice(), stepup: !!m.stepup, stage: 0,
             status: 'pending', created: now(), expiresAt: now() + ttl(), why: why || `${ag.id} proposes: ${m.desc}`,
             cost: params.amount || 0, reversible: m.reversible, stepupDone: false, history: [] };
      S.approvals[ap.id] = ap;
      logEvent(g, ag.id, 'approval_requested', `${action} needs ${ap.stages.join(' then ')}${m.stepup ? ' (step-up)' : ''}`, { tier: m.tier, approval: ap.id });
      audit(ag.id, 'approval_requested', `${action} tier ${m.tier}`, goalId, { tier: m.tier });
    }
    refreshStatus(g);
    return r(202, { pending: true, approvalId: ap.id, tier: m.tier, waitingOn: ap.stages[ap.stage] });
  })();
  if (idemKey && res.status === 200) S.idem[idemKey] = res;
  return res;
}

// ---- Approval service: humans only, never the requesting agent ----
function decide(tok, id, { decision, stepup }) {
  const ag = authAgent(tok);
  const ap = S.approvals[id];
  if (!ag) return r(401, { error: 'invalid token' });
  if (!ap) return r(404, { error: 'unknown approval' });
  if (ag.kind !== 'human') {
    S.metrics.selfApprove++; audit(ag.id, 'denied', `attempted to decide approval ${id}`, ap.goalId);
    raise(`selfapprove-${ag.id}`, 'high', `${ag.id} attempted to approve an action (agents cannot approve)`, 'Rejected, logged'); violation(ag.id, 'self-approve');
    return r(403, { error: 'agents cannot approve actions' });
  }
  if (ap.status !== 'pending') return r(409, { error: `approval is ${ap.status}` });
  const need = ap.stages[ap.stage];
  if (ag.id !== need) return r(403, { error: `this step needs ${need}` });
  const g = S.goals[ap.goalId];
  if (decision === 'deny') {
    ap.status = 'denied'; ap.decidedAt = now(); S.metrics.denied++;
    logEvent(g, ag.id, 'denied', `${ag.id} denied ${ap.action}`, { tier: ap.tier, approval: id });
    audit(ag.id, 'decision', `deny ${ap.action}`, ap.goalId, { tier: ap.tier });
    refreshStatus(g); return r(200, { status: 'denied' });
  }
  if (ap.stepup && need === 'priya' && !stepup) return r(401, { error: 'step-up verification (passkey) required' });
  ap.history.push({ by: ag.id, ts: now(), stepup: !!stepup });
  ap.stage++;
  logEvent(g, ag.id, 'decision', `${ag.id} approved ${ap.action}${stepup ? ' with passkey' : ''}`, { tier: ap.tier, approval: id });
  audit(ag.id, 'decision', `approve ${ap.action}`, ap.goalId, { tier: ap.tier });
  if (ap.stage >= ap.stages.length) {
    ap.status = 'approved'; ap.decidedAt = now();
    const gr = { id: uid('grt'), approvalId: id, hash: ap.hash, requester: ap.requester, exp: now() + ttl(), used: false };
    S.grants[gr.id] = gr; ap.grantId = gr.id;
    logEvent(g, 'portal', 'grant', `Grant ${gr.id} issued: single use, bound to ${ap.action} ${JSON.stringify(ap.params)}`, { tier: ap.tier });
  }
  refreshStatus(g);
  return r(200, { status: ap.status, waitingOn: ap.stages[ap.stage] || null });
}

// ---- Background long-running agent: wakes on a timer, acts only through the portal ----
function withApproval(g, action, params, why) {
  const h = sha(canon(g.id, action, params));
  const ap = Object.values(S.approvals).filter((a) => a.hash === h && a.requester === 'bg-agent').sort((a, b) => a.created - b.created).pop();
  if (ap && ap.status === 'pending') return 'wait';
  if (ap && ap.status === 'denied') return 'blocked';
  if (ap && ap.status === 'approved') {
    const x = act('tok-bg', { goalId: g.id, action, params, version: g.version, grantId: ap.grantId });
    return x.status === 200 ? 'done' : 'wait';
  }
  const x = act('tok-bg', { goalId: g.id, action, params, version: g.version, why });
  return x.status === 200 ? 'done' : 'wait';
}
function bgStep(g) {
  const f = g.facts, call = (action, params) => act('tok-bg', { goalId: g.id, action, params, version: g.version });
  if (g.blocked) return;
  if (!f.warranty) return void call('check_warranty');
  if (!f.tech) return void call('book_technician', {});
  if (!f.reminder) return void call('send_reminder');
  if (f.warranty.status === 'expired') {
    const s = withApproval(g, 'warranty_exception', {}, `Warranty on your ${f.warranty.product} expired ${f.warranty.expiredDaysAgo} days ago. Requesting goodwill exception so repair is covered.`);
    if (s === 'blocked') { g.blocked = true; logEvent(g, 'bg-agent', 'escalated', 'Exception denied; handing goal to a human'); raise(`blocked-${g.id}`, 'medium', 'Exception denied, goal needs a human', 'Escalated to enterprise agent'); }
    return;
  }
  if (!f.feePaid) {
    const s = withApproval(g, 'pay_diagnostic_fee', { amount: 80 }, 'Technician diagnostic fee of $80 (within your $100 budget).');
    if (s === 'blocked') { g.blocked = true; logEvent(g, 'bg-agent', 'escalated', 'Fee denied; waiting for Priya direction'); }
    return;
  }
  if (!f.closed) {
    const s = withApproval(g, 'close_case', {}, 'Repair complete. Please confirm the case can be closed.');
    if (s === 'blocked') { g.blocked = true; logEvent(g, 'bg-agent', 'escalated', 'Close denied; case stays open'); }
  }
}

function bgContext(g) {
  const aps = Object.values(S.approvals).filter((a) => a.goalId === g.id && a.requester === 'bg-agent').map((a) => ({ action: a.action, params: a.params, status: a.status, waitingOn: a.status === 'pending' ? a.stages[a.stage] : undefined }));
  return { id: g.id, objective: g.objective, status: g.status, blocked: !!g.blocked, constraints: g.constraints, spent: g.spent, facts: g.facts, approvals: aps, recent: g.events.slice(-12).map((e) => `${e.actor}: ${e.type} ${e.detail}`) };
}
function sweep() {
  for (const a of Object.values(S.approvals)) {
    if (a.status === 'pending' && a.expiresAt < now()) { a.status = 'expired'; S.metrics.expired++; logEvent(S.goals[a.goalId], 'portal', 'expired', `Approval ${a.id} expired`); }
    if (a.status === 'approved' && S.grants[a.grantId].exp < now()) { a.status = 'expired'; S.metrics.expired++; }
  }
  for (const g of Object.values(S.goals)) {
    refreshStatus(g);
    if (g.status === 'resolved') continue;
    const pend = Object.values(S.approvals).filter((a) => a.goalId === g.id && a.status === 'pending');
    if (g.agentOn && S.bgEnabled && !pend.length && !g.blocked && g.status === 'active' && now() - g.lastProgress > CFG.t.stallSec * 1000 && !S.revoked['bg-agent']) {
      raise(`stall-${g.id}`, 'medium', `Goal ${g.id} has made no progress for ${Math.round((now() - g.lastProgress) / 1000)}s`, 'Notified Priya, flagged for human review');
    }
    for (const a of pend) if (now() - a.created > CFG.t.slowApprovalSec * 1000) {
      raise(`slow-${a.id}`, 'low', `Approval ${a.id} (${a.action}) pending over ${Math.round(CFG.t.slowApprovalSec)}s`, `Reminder sent to ${a.stages[a.stage]}`);
    }
    if (g.spent >= g.constraints.budget * CFG.t.budgetWarnPct / 100 && g.spent <= g.constraints.budget && g.spent > 0) raise(`budgetwarn-${g.id}`, 'low', `Goal ${g.id} has used ${Math.round(100 * g.spent / g.constraints.budget)}% of its budget`, 'Priya notified');
    if (g.spent > g.constraints.budget) { g.status = 'paused'; raise(`budget-${g.id}`, 'high', 'Goal exceeded budget', 'Goal paused'); }
  }
}
function tick() {
  sweep();
  if (S.bgEnabled && !S.revoked['bg-agent'] && !(S.bgBrainSeen && now() - S.bgBrainSeen < 20000)) for (const g of Object.values(S.goals)) if (g.agentOn && !['resolved', 'paused'].includes(g.status)) bgStep(g);
}
if (!process.env.MANUAL_TICK) setInterval(tick, TICK); // MANUAL_TICK=1: deterministic capture, ticks only via POST /api/admin/tick

// ---- Portal API handlers ----
function createGoal(tok, b) {
  const ag = authAgent(tok);
  if (!ag || ag.kind !== 'surface') return r(401, { error: 'surface token required' });
  if (ag.revoked) return r(403, { error: 'grant revoked' });
  const objective = (b.objective || '').trim();
  if (!objective) return r(400, { error: 'objective required' });
  const dup = Object.values(S.goals).find((g) => g.objective.toLowerCase() === objective.toLowerCase() && g.status !== 'resolved');
  if (dup) { audit(ag.id, 'dedupe', `joined existing goal ${dup.id}`, dup.id); logEvent(dup, ag.id, 'joined', `${ag.id} attached to this goal (no duplicate created)`); return r(200, { goal: pub(dup), existing: true, brief: brief(dup) }); }
  const g = { id: uid('goal'), owner: 'priya', objective, constraints: { budget: CFG.t.goalBudget, ...parseConstraints(objective) }, status: 'active', version: 1,
              createdVia: ag.id, spent: 0, facts: {}, events: [], lastProgress: now(), agentOn: true };
  S.goals[g.id] = g;
  logEvent(g, ag.id, 'goal_created', `Goal created from ${ag.id}: "${objective}". Budget $${CFG.t.goalBudget}, preferred time: ${g.constraints.window}`);
  audit(ag.id, 'goal_created', objective, g.id);
  return r(201, { goal: pub(g), brief: brief(g) });
}
function getGoal(tok, id) { const g = S.goals[id]; return g ? r(200, { goal: pub(g), facts: g.facts, brief: brief(g) }) : r(404, { error: 'unknown goal' }); }
const pub = (g) => ({ id: g.id, objective: g.objective, status: g.status, version: g.version, constraints: g.constraints, spent: g.spent });
const INJECTION = /(ignore|disregard|forget)[^.]{0,30}(previous|prior|above|all)[^.]{0,30}(instruction|rule|polic)|you are now|system prompt|reveal .*(token|key)/i;

function message(tok, goalId, b) {
  const ag = authAgent(tok); const g = S.goals[goalId];
  if (!ag || ag.kind !== 'surface') return r(401, { error: 'surface token required' });
  if (ag.revoked) return r(403, { error: 'grant revoked' });
  if (!g) return r(404, { error: 'unknown goal' });
  const text = String(b.text || '').slice(0, 500);
  if (INJECTION.test(text)) {
    S.metrics.injections++;
    logEvent(g, ag.id, 'quarantined', `Instruction-like content quarantined as data: "${text.slice(0, 80)}"`);
    audit(ag.id, 'injection', text.slice(0, 80), goalId);
    raise(`inj-${S.seq}`, 'high', `Instruction-like content from ${ag.id} treated as data, not obeyed`, 'Message quarantined, Priya notified'); violation(ag.id, 'injection');
    return r(200, { stored: true, flagged: true, note: 'Treated as data. No action taken.' });
  }
  logEvent(g, ag.id, 'note', `Note from ${ag.id}: ${text}`);
  g.lastProgress = now();
  return r(200, { stored: true });
}


// ---- Admin: configure policy, presets, simulate, change log ----
const PRESETS = {
  conservative: { label: 'Conservative', note: 'Humans approve everything that changes state. Start here.', tiers: { book_technician: 2, send_reminder: 1, pay_diagnostic_fee: 2, close_case: 2, change_address: 3, warranty_exception: 4 }, autoUpTo: 0, t: { goalBudget: 50, approvalTtlMin: 10, autoRevokeAfter: 3, loopGuardCalls: 8 } },
  balanced:     { label: 'Balanced', note: 'Reversible actions run on their own, money and irreversible actions need a human.', tiers: { book_technician: 1, send_reminder: 1, pay_diagnostic_fee: 2, close_case: 2, change_address: 3, warranty_exception: 4 }, autoUpTo: 0, t: { goalBudget: 100, approvalTtlMin: 15, autoRevokeAfter: 5, loopGuardCalls: 14 } },
  autonomous:   { label: 'Autonomous', note: 'Small spend auto-approved within limits. Use only after weeks of clean data.', tiers: { book_technician: 1, send_reminder: 1, pay_diagnostic_fee: 2, close_case: 1, change_address: 3, warranty_exception: 4 }, autoUpTo: 25, t: { goalBudget: 250, approvalTtlMin: 30, autoRevokeAfter: 0, loopGuardCalls: 20 } },
};
const defaultApprovers = (t) => (t >= 4 ? ['supervisor'] : t >= 2 ? ['priya'] : []);
function validate(c) {
  const errs = [];
  for (const [k, a] of Object.entries(c.actions || {})) {
    if (![0, 1, 2, 3, 4].includes(a.tier)) errs.push(`${k}: tier must be 0-4`);
    if (a.tier >= 2 && !(a.approvers || []).length) errs.push(`${k}: tier ${a.tier} needs at least one approver`);
    if (a.tier === 4 && !(a.approvers || []).includes('supervisor')) errs.push(`${k}: tier 4 needs the supervisor stage`);
    if (a.tier === 0 && !a.reversible) errs.push(`${k}: tier 0 must be a read-only or reversible action`);
    if (a.money && !(a.limit > 0)) errs.push(`${k}: money actions need a per-action limit`);
    if (a.money && a.autoUpTo > a.limit) errs.push(`${k}: auto-approve amount cannot exceed the limit`);
    if (a.autoUpTo > 0 && !a.money) errs.push(`${k}: auto-approve amount only applies to money actions`);
  }
  const t = c.t || {};
  if (!(t.goalBudget >= 0)) errs.push('goal budget must be >= 0');
  if (!(t.approvalTtlMin >= 1 && t.approvalTtlMin <= 1440)) errs.push('approval expiry must be 1-1440 minutes');
  if (!(t.loopGuardCalls >= 3)) errs.push('loop guard must allow at least 3 calls');
  if (!(t.budgetWarnPct > 0 && t.budgetWarnPct <= 100)) errs.push('budget warning must be 1-100%');
  for (const [ag, list] of Object.entries(c.scopes || {})) for (const x of list) if (!c.actions[x]) errs.push(`${ag}: unknown action ${x}`);
  const ex = c.excluded;
  if (!Array.isArray(ex)) errs.push('excluded must be a list');
  else ex.forEach((e, i) => {
    if (!e || typeof e.task !== 'string' || !e.task.trim() || e.task.length > 80) errs.push(`excluded task ${i + 1}: needs a short task phrase (max 80 chars)`);
    if (e && e.alternative !== undefined && (typeof e.alternative !== 'string' || e.alternative.length > 200)) errs.push(`excluded task ${i + 1}: alternative must be text up to 200 chars`);
    if (e && c.actions && Object.entries(c.actions).some(([k, a]) => a.enabled && k.replace(/_/g, ' ') === String(e.task).toLowerCase())) errs.push(`excluded task "${e.task}" is still an enabled action`);
  });
  const px = c.poppy || {};
  if (!Array.isArray(px.clients)) errs.push('poppy.clients must be a list');
  else px.clients.forEach((cl) => {
    if (!/^https:\/\/[^\s]+$/.test(cl.clientId || '') && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(cl.clientId || '')) errs.push(`poppy client ${cl.clientId || '?'}: client_id must be an https URL`);
    if (!c.scopes || !c.scopes[cl.agent] || !['claude', 'chatgpt'].includes(cl.agent)) errs.push(`poppy client ${cl.clientId}: agent must be claude or chatgpt`);
  });
  if (!px.users || typeof px.users !== 'object') errs.push('poppy.users must be a map');
  else for (const [sub, acct] of Object.entries(px.users)) if (!/^[\w.-]{6,}$/.test(sub) || acct !== 'priya') errs.push(`poppy user ${sub}: must be an opaque ID (6+ chars, no personal data) linked to a known account`);
  return errs;
}
function diffCfg(a, b) {
  const out = [];
  for (const k of Object.keys(b.actions)) for (const f of ['tier', 'enabled', 'stepup', 'limit', 'autoUpTo']) if (JSON.stringify(a.actions[k] && a.actions[k][f]) !== JSON.stringify(b.actions[k][f])) out.push(`${k}.${f}: ${a.actions[k] ? a.actions[k][f] : '-'} -> ${b.actions[k][f]}`);
  for (const k of Object.keys(b.actions)) if (JSON.stringify(a.actions[k] && a.actions[k].approvers) !== JSON.stringify(b.actions[k].approvers)) out.push(`${k}.approvers: ${(a.actions[k] || {}).approvers} -> ${b.actions[k].approvers}`);
  for (const k of Object.keys(b.t)) if (a.t[k] !== b.t[k]) out.push(`threshold ${k}: ${a.t[k]} -> ${b.t[k]}`);
  for (const k of Object.keys(b.scopes)) if (JSON.stringify([...(a.scopes[k] || [])].sort()) !== JSON.stringify([...b.scopes[k]].sort())) out.push(`scope ${k}: ${(a.scopes[k] || []).length} -> ${b.scopes[k].length} actions`);
  for (const k of Object.keys(b.actions)) if ((a.actions[k] || {}).personalData !== b.actions[k].personalData) out.push(`${k}.personalData: ${(a.actions[k] || {}).personalData} -> ${b.actions[k].personalData}`);
  if (JSON.stringify(a.excluded) !== JSON.stringify(b.excluded)) out.push(`excluded tasks: ${a.excluded.length} -> ${b.excluded.length} (${b.excluded.map((e) => e.task).join('; ')})`);
  if (JSON.stringify(a.poppy.clients) !== JSON.stringify(b.poppy.clients)) out.push(`poppy registered agents: ${a.poppy.clients.length} -> ${b.poppy.clients.length}`);
  if (JSON.stringify(a.poppy.users) !== JSON.stringify(b.poppy.users)) out.push(`poppy linked users: ${Object.keys(a.poppy.users).length} -> ${Object.keys(b.poppy.users).length}`);
  return out;
}
function applyConfig(next, why) {
  if (!next || !next.actions || !next.t || !next.scopes) return r(422, { errors: ['config must include actions, scopes and thresholds'] });
  const errs = validate(next);
  if (errs.length) return r(422, { errors: errs });
  const d = diffCfg(CFG, next);
  CFG = next;
  if (d.length) { CHANGES.unshift({ ts: now(), by: 'admin', why: why || 'manual edit', changes: d }); audit('admin', 'config', `${why || 'edit'}: ${d.length} change(s)`); }
  return r(200, { ok: true, changes: d });
}
function simulate(b) {
  const m = CFG.actions[b.action];
  if (!m) return r(400, { error: 'unknown action' });
  const agent = b.agent || 'claude', amount = b.amount;
  const steps = [];
  if (!m.enabled) return r(200, { verdict: 'blocked', steps: ['Action is disabled by the admin'] });
  if (!(CFG.scopes[agent] || []).includes(b.action)) return r(200, { verdict: 'blocked', steps: [`${agent} has no scope for ${b.action}`] });
  if (m.limit && amount > m.limit) return r(200, { verdict: 'blocked', steps: [`$${amount} is over the $${m.limit} per-action limit`] });
  const tier = effTier(m, { amount });
  if (tier !== m.tier) steps.push(`$${amount} is within the $${m.autoUpTo} auto-approve amount, so it runs at tier 1`);
  if (tier === 0) steps.push('Runs immediately, read only');
  else if (tier === 1) steps.push(`Runs on its own, Priya is notified, ${CFG.t.undoMin} min undo window`);
  else { steps.push(`Approval request created, valid ${CFG.t.approvalTtlMin} min`); for (const a of m.approvers) steps.push(`${a} must approve${m.stepup && a === 'priya' ? ' with step-up (passkey)' : ''}`); steps.push('Portal issues a single-use grant bound to the exact action and parameters'); }
  return r(200, { verdict: tier <= 1 ? 'autonomous' : 'human-in-loop', tier, steps });
}
function suggestions() {
  const out = [], ap = Object.values(S.approvals);
  for (const [k, m] of Object.entries(CFG.actions)) {
    const mine = ap.filter((a) => a.action === k && ['approved', 'redeemed', 'denied'].includes(a.status));
    const denied = mine.filter((a) => a.status === 'denied').length;
    if (m.tier >= 2 && mine.length >= 5 && denied === 0 && m.reversible) out.push({ action: k, kind: 'loosen', text: `${k}: ${mine.length} approvals, 0 denials, reversible. Consider tier ${m.tier - 1}.` });
    if (denied >= 2) out.push({ action: k, kind: 'tighten', text: `${k}: ${denied} denials. Check whether agents are proposing the wrong things, or raise the tier.` });
  }
  for (const [ag, n] of Object.entries(S.violations)) if (n >= 2) out.push({ action: ag, kind: 'tighten', text: `${ag} has ${n} policy violations. Narrow its scope or enable auto-revoke.` });
  if (S.metrics.expired >= 2) out.push({ kind: 'tune', text: `${S.metrics.expired} approvals expired. Lengthen the expiry or add a backup approver.` });
  return out;
}

// ---- Poppy documents published by the portal (derived from the admin policy) ----
function scopeHints() {
  const scopes = {}, hints = {};
  for (const [k, a] of Object.entries(CFG.actions)) {
    if (!a.enabled) continue;
    scopes[k] = a.desc + (a.tier >= 2 ? ` (needs ${a.approvers.join(' then ')} approval${a.stepup ? ' with step-up' : ''})` : '');
    hints[k] = { changes: a.tier === 0 ? 'none' : a.reversible ? 'reversible' : 'irreversible', personal_data: !!a.personalData };
  }
  return { scopes, hints };
}
function poppyDoc() {
  const { scopes, hints } = scopeHints();
  return {
    protocol_version: '1.0',
    organization: { name: 'Acme Service', domain: new URL(PUBLIC_URL).host, logo_uri: PUBLIC_URL + '/logo.png' },
    auth: { issuer: POPPY_AUDIENCE, scopes, scope_hints: hints },
    tasks: { endpoint: PUBLIC_URL + '/poppy/tasks' },
    apis: [{ type: 'openapi', url: PUBLIC_URL + '/openapi.json', description: 'Service goals, actions and approvals' }],
  };
}
function openapiDoc() {
  const sec = [{ poppySession: [] }];
  const op = (summary) => ({ summary, security: sec, responses: { 200: { description: 'OK' }, 202: { description: 'Waiting for human approval' } } });
  return { openapi: '3.0.3', info: { title: 'Acme Service portal agent API', version: '1.0' }, servers: [{ url: PUBLIC_URL }],
    components: { securitySchemes: { poppySession: { type: 'apiKey', in: 'header', name: 'Poppy-Session' } } },
    paths: { '/api/portal/goals': { get: op('List goals'), post: op('Create a goal, or join the existing one') },
      '/api/portal/goals/{id}': { get: op('Read a goal and its handoff brief') },
      '/api/portal/goals/{id}/messages': { post: op('Add a note (treated as data)') },
      '/api/portal/actions': { post: op('Request an action. Tier 2+ returns 202 until a human approves.') } } };
}
const tasksDoc = () => ({ excluded_tasks: CFG.excluded, skills: [], feedback: { endpoint: PUBLIC_URL + '/poppy/feedback' } });

// ---- HTTP plumbing ----
const MCP_TOOLS = [
  { name: 'acme_discover', description: 'What this agent may do with Acme and which tasks Acme excludes (with alternatives).', inputSchema: { type: 'object', properties: {} } },
  { name: 'acme_create_goal', description: 'Hand Acme a service goal for the signed-in customer. Acme\'s enterprise agent works it over days.', inputSchema: { type: 'object', properties: { objective: { type: 'string' } }, required: ['objective'] } },
  { name: 'acme_get_goal', description: 'Current state of a goal, handoff brief and pending approvals.', inputSchema: { type: 'object', properties: { goal_id: { type: 'string' } }, required: ['goal_id'] } },
  { name: 'acme_add_note', description: 'Add a note from the customer to a goal (treated as data).', inputSchema: { type: 'object', properties: { goal_id: { type: 'string' }, text: { type: 'string' } }, required: ['goal_id', 'text'] } },
  { name: 'acme_request_action', description: 'Ask Acme to perform an action on a goal. Actions needing a human return pending; the agent cannot approve.', inputSchema: { type: 'object', properties: { goal_id: { type: 'string' }, action: { type: 'string' }, params: { type: 'object' }, version: { type: 'number' }, idem_key: { type: 'string' }, grant_id: { type: 'string' }, why: { type: 'string' } }, required: ['goal_id', 'action'] } },
];
const send = (res, { status, body }) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
function readBody(req) { return new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } }); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let tok = (req.headers.authorization || '').replace('Bearer ', '');
  const p = url.pathname;
  try {
    // Acme's MCP server: the brand-facing front door that a customer's personal agent calls (stateless Streamable HTTP, JSON-RPC).
    // It is a thin layer over the same portal handlers, so tiers, grants and approvals apply unchanged.
    if (p === '/mcp/acme') {
      const hdr = { 'Content-Type': 'application/json' }; const m = req.method === 'POST' ? await readBody(req) : null;
      if (!m) { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
      if (!authAgent(tok)) { res.writeHead(401, hdr); return res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'OAuth access token required' } })); }
      const rep = (result) => { res.writeHead(200, hdr); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
      if (m.method === 'initialize') return rep({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'acme-service-mcp', version: '1.0' } });
      if (m.method === 'tools/list') return rep({ tools: MCP_TOOLS });
      if (m.method === 'tools/call') {
        const a = (m.params && m.params.arguments) || {}, name = m.params && m.params.name; let out;
        if (name === 'acme_discover') out = r(200, { allowed: authAgent(tok).actions, excluded_tasks: CFG.excluded });
        else if (name === 'acme_create_goal') out = createGoal(tok, { objective: a.objective });
        else if (name === 'acme_get_goal') out = getGoal(tok, a.goal_id);
        else if (name === 'acme_add_note') out = message(tok, a.goal_id, { text: a.text });
        else if (name === 'acme_request_action') out = act(tok, { goalId: a.goal_id, action: a.action, params: a.params || {}, version: a.version, idemKey: a.idem_key, grantId: a.grant_id, why: a.why });
        else out = r(400, { error: 'unknown tool' });
        return rep({ content: [{ type: 'text', text: JSON.stringify(out) }], isError: out.status >= 400 });
      }
      return rep({});
    }
    // Public Poppy discovery documents
    if (req.method === 'GET' && p === '/.well-known/poppy.json') return send(res, r(200, poppyDoc()));
    if (req.method === 'GET' && p === '/poppy/tasks') return send(res, r(200, tasksDoc()));
    if (req.method === 'GET' && p === '/openapi.json') return send(res, r(200, openapiDoc()));
    if (req.method === 'POST' && p === '/poppy/feedback') { const f = await readBody(req); FEEDBACK.push({ ts: now(), task: String(f.task || '').slice(0, 200), note: String(f.note || '').slice(0, 500) }); audit('poppy', 'feedback', String(f.task || '').slice(0, 80)); return send(res, r(202, { received: true })); }
    // Poppy session: verified before any claim is trusted, then mapped to a registered agent's token
    if (p.startsWith('/api/portal/') || p === '/poppy/session/end') {
      const hdr = req.headers['poppy-session'];
      if (hdr) {
        const v = await poppy.verifySession(hdr, { cfg: CFG, audience: POPPY_AUDIENCE, publicUrl: PUBLIC_URL, method: req.method, path: p, allowHttp: POPPY_ALLOW_HTTP });
        if (!v.ok) {
          S.metrics.denied++; audit('poppy', 'denied', `session rejected: ${v.detail}`);
          raise(`poppy-${v.error}-${S.seq}`, 'medium', `Poppy session rejected: ${v.detail}`, 'Request refused');
          return send(res, r(v.status, { error: v.error }));
        }
        tok = Object.keys(AGENTS).find((t) => AGENTS[t].id === v.agent && AGENTS[t].kind === 'surface');
        if (v.isNew) audit(v.agent, 'poppy', `verified Poppy session ${v.sid} for user ${v.sub.slice(0, 10)}`);
        if (p === '/poppy/session/end') { poppy.endSession(v.key); return send(res, r(200, { ended: true })); }
      } else if (POPPY_REQUIRED) return send(res, r(401, { error: 'poppy_session_required' }));
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'index.html'))); }
    if (req.method === 'GET' && p === '/demo') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'demo.html'))); }
    if (req.method === 'GET' && p === '/api/state') {
      sweep();
      const ap = Object.values(S.approvals);
      const decided = ap.filter((a) => a.decidedAt);
      const tiers = [0, 1, 2, 3, 4].map((t) => S.audit.filter((e) => e.type === 'action' && e.tier === t).length);
      return send(res, r(200, { goals: Object.values(S.goals).map((g) => ({ ...g, brief: brief(g) })), approvals: ap, alerts: S.alerts, notifications: S.notifications.slice(-5),
        manifest: CFG.actions, thresholds: CFG.t, poppyRequired: POPPY_REQUIRED, feedback: FEEDBACK.slice(-10), scopes: CFG.scopes, violations: S.violations, revoked: S.revoked, bgEnabled: S.bgEnabled, metrics: { ...S.metrics, tiers, avgApprovalSec: decided.length ? Math.round(decided.reduce((s, a) => s + (a.decidedAt - a.created), 0) / decided.length / 1000) : 0,
        pendingApprovals: ap.filter((a) => a.status === 'pending').length, spent: Object.values(S.goals).reduce((s, g) => s + g.spent, 0) }, audit: S.audit.slice(-30), now: now() }));
    }
    if (p === '/admin' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(__dirname, 'admin.html'))); }
    if (p.startsWith('/api/admin/') && ['config', 'preset', 'simulate', 'config-reset'].some((x) => p === '/api/admin/' + x)) {
      if (tok !== 'tok-admin') return send(res, r(401, { error: 'admin token required' }));
      if (req.method === 'GET' && p === '/api/admin/config') return send(res, r(200, { config: CFG, defaults: DEFAULT_CONFIG(), presets: PRESETS, changes: CHANGES.slice(0, 30), suggestions: suggestions(), violations: S.violations }));
      const bb = (await readBody(req)) || {};
      if (p === '/api/admin/config') return send(res, applyConfig(bb.config, bb.why));
      if (p === '/api/admin/config-reset') return send(res, applyConfig(DEFAULT_CONFIG(), 'reset to defaults'));
      if (p === '/api/admin/simulate') return send(res, simulate(bb));
      if (p === '/api/admin/preset') {
        const pr = PRESETS[bb.name]; if (!pr) return send(res, r(400, { error: 'unknown preset' }));
        const next = JSON.parse(JSON.stringify(CFG));
        for (const [k, t] of Object.entries(pr.tiers)) { const a = next.actions[k]; a.tier = t; a.approvers = defaultApprovers(t); a.stepup = t === 3; }
        next.actions.pay_diagnostic_fee.autoUpTo = pr.autoUpTo;
        Object.assign(next.t, pr.t);
        return send(res, applyConfig(next, `preset: ${pr.label}`));
      }
    }
    const b = req.method === 'POST' ? await readBody(req) : {};
    if (p.startsWith('/api/bg/')) { // Acme's background agent brain (LLM) lives outside the portal; the policy gate stays here
      const ag = authAgent(tok);
      if (!ag || ag.kind !== 'background') return send(res, r(401, { error: 'background agent token required' }));
      if (ag.revoked) return send(res, r(403, { error: 'grant revoked' }));
      S.bgBrainSeen = now();
      if (req.method === 'GET' && p === '/api/bg/goals') return send(res, r(200, { goals: Object.values(S.goals).filter((g) => g.agentOn && !['resolved', 'paused'].includes(g.status)).map(bgContext), actions: Object.fromEntries(Object.entries(CFG.actions).filter(([k, v]) => v.enabled && CFG.scopes['bg-agent'].includes(k)).map(([k, v]) => [k, { tier: v.tier, approvers: v.approvers, limit: v.limit, desc: v.desc }])) }));
      if (req.method === 'POST' && p === '/api/bg/step') {
        const g = S.goals[b.goalId]; if (!g) return send(res, r(404, { error: 'unknown goal' }));
        if (!CFG.scopes['bg-agent'].includes(b.action)) { act('tok-bg', { goalId: g.id, action: String(b.action), params: {}, version: g.version }); return send(res, r(403, { error: 'outside scope, logged' })); }
        const params = b.params && typeof b.params === 'object' ? b.params : {};
        const s = withApproval(g, b.action, params, String(b.why || '').slice(0, 300) || `Background agent proposes ${b.action}`);
        if (s === 'blocked') { g.blocked = true; logEvent(g, 'bg-agent', 'escalated', `${b.action} denied; handing goal to a human`); raise(`blocked-${g.id}`, 'medium', `${b.action} denied, goal needs a human`, 'Escalated to enterprise agent'); }
        return send(res, r(200, { result: s, goal: bgContext(g) })); // done | wait (human decision pending) | blocked
      }
      return send(res, r(404, { error: 'not found' }));
    }
    if (req.method === 'GET' && p.startsWith('/api/portal/')) { // reads also require a live, non-revoked delegated token
      const ag = authAgent(tok);
      if (!ag || ag.kind !== 'surface') return send(res, r(401, { error: 'surface token required' }));
      if (ag.revoked) return send(res, r(403, { error: 'grant revoked' }));
    }
    if (req.method === 'GET' && p === '/api/portal/goals') { const gs = Object.values(S.goals).map(pub); return send(res, r(200, { goals: gs })); }
    let m;
    if (req.method === 'GET' && (m = p.match(/^\/api\/portal\/goals\/([\w-]+)$/))) {
      const g = S.goals[m[1]]; if (!g) return send(res, r(404, { error: 'unknown goal' }));
      return send(res, r(200, { goal: pub(g), facts: g.facts, brief: brief(g) })); // handoff brief: a new surface starts from this
    }
    if (req.method === 'POST' && p === '/api/portal/goals') return send(res, createGoal(tok, b));
    if (req.method === 'POST' && (m = p.match(/^\/api\/portal\/goals\/([\w-]+)\/messages$/))) return send(res, message(tok, m[1], b));
    if (req.method === 'POST' && p === '/api/portal/actions') return send(res, act(tok, b));
    if (req.method === 'POST' && (m = p.match(/^\/api\/approvals\/([\w-]+)\/decide$/))) return send(res, decide(tok, m[1], b));
    if (req.method === 'POST' && p === '/api/admin/revoke') { S.revoked[b.agent] = !!b.revoked; audit('admin', 'revoke', `${b.agent} ${b.revoked ? 'revoked' : 'restored'}`); return send(res, r(200, { ok: true })); }
    if (req.method === 'POST' && p === '/api/admin/bg') { S.bgEnabled = !!b.enabled; return send(res, r(200, { ok: true })); }
    if (req.method === 'POST' && p === '/api/admin/clear-alert') { S.alerts.forEach((a) => (a.cleared = true)); return send(res, r(200, { ok: true })); }
    if (req.method === 'POST' && p === '/api/admin/tick' && process.env.MANUAL_TICK) { tick(); return send(res, r(200, { ok: true })); }
    if (req.method === 'POST' && p === '/api/admin/reset') { fresh(); return send(res, r(200, { ok: true })); }
    send(res, r(404, { error: 'not found' }));
  } catch (e) { console.error(e); send(res, r(500, { error: String(e) })); }
}).listen(PORT, () => console.log(`Agent portal prototype on http://localhost:${PORT}`));
