# Agent Portal prototype

Working prototype of the hub-and-spoke design: Priya's Claude and ChatGPT agents talk only to the portal agent. The portal owns the goal ledger, capability manifest, approvals and monitoring. A background agent works the goal over time.

```bash
node server.js          # http://localhost:4310 (engineering console) and /demo (executive demo)
node test.js            # 24-check end-to-end scenario against a running server
```

Env knobs: `PORT`, `TICK` (background agent interval ms), `APPROVAL_TTL`, `STALL_MS`, `SLOW_APPROVAL_MS`.

## What is real vs simulated
- Real: token auth and scopes, versioned ledger (optimistic concurrency), idempotency keys, tiered capability manifest, approval service with staged approvers, step-up, signed single-use grants bound to an action hash, expiry, revocation, loop guard, budget and limit checks, injection quarantine, alerts with automated responses.
- Simulated: the LLM personas (buttons stand in for what Claude or ChatGPT would decide), back-end systems (warranty, scheduling, payments), the passkey (a flag), and in-memory state (reset on restart).
- The UI holds every token because it is a single-page demo console. In production each token lives only with its own agent or human session.

## Flow
1. Claude creates a goal. ChatGPT creating the same goal joins it (no duplicate).
2. Background agent: check warranty (T0), book technician (T1), remind (T1), warranty expired, so it requests a goodwill exception (T4: the supervisor decides; Priya is informed, not asked).
3. After approval it redeems the grant, requests the $80 fee (T2), then asks Priya to confirm closing (T2).
4. Surfaces can propose T2/T3 actions (fee, address change, close) and must redeem their own grants.

Adversarial tests in the UI: stale write, prompt injection, self-approval, over-limit fee, grant revocation, out-of-scope request, tampered redeem.

## Admin setup: /admin
Policy is data, not code. The admin console (token `tok-admin`) edits the capability manifest (tier, approvers, step-up, reversible, per-action limit, auto-approve amount, on/off), the agent x action scope matrix, and thresholds (goal budget, expiry, slow-approval and stall alerts, loop guard, auto-revoke after N violations). Includes presets (Conservative, Balanced, Autonomous), a policy simulator, data-driven loosen/tighten suggestions, a go-live checklist and a change log. Saves are validated server-side (e.g. tier 2+ needs an approver, tier 4 needs the supervisor stage). API: `GET/POST /api/admin/config`, `POST /api/admin/preset|simulate|config-reset`.

## Poppy (Personal Agent Protocol 1.0)
Spec: https://personalagentprotocol.org/docs/1.0/spec. The portal plays the Company side.
- Published: `/.well-known/poppy.json` (scopes and `scope_hints` derived from the manifest), `/poppy/tasks` (excluded tasks with alternatives, feedback endpoint), `/openapi.json`, `POST /poppy/feedback`.
- Excluded tasks are edited in `/admin`. Account-based limits (fee limit, goal budget) stay errors, not exclusions, per the spec. A disabled action returns `403 task_excluded`.
- Session verification (`poppy.js`): `Poppy-Session` JWT with delegation JWT (max 24h, no user or company claims), key binding, `aud`, `htm`/`htu`, `iat` window, `jti` replay, session end. Only registered `client_id` URLs are ever fetched. A verified session maps to the registered agent (Claude or ChatGPT) and a linked opaque user ID, then the normal tiers, scopes and approvals apply.
- Not implemented: OAuth sign-in and access tokens (sessions with `ath` are refused), browser join, Company Agent conversations, DPoP. `poppy.json` member shapes follow the spec example; the exact excluded-task entry shape (`{task, alternative}`) was inferred from section 9.1 and should be checked.
- Env: `PUBLIC_URL`, `POPPY_AUDIENCE`, `POPPY_REQUIRED=1`, `POPPY_ALLOW_HTTP=1` (dev only).
- Tests: `PORT=4398 POPPY_ALLOW_HTTP=1 node server.js` then `node test_poppy.js http://localhost:4398` (30 checks).

## Executive demo: /demo
Open http://localhost:4310/demo. A phone shows Priya in Claude or ChatGPT (pick one before starting; there is no hand-off between them), talking to the portal agent. Human steps are real: Dana (supervisor console on the right) and Priya (secure approval cards on the phone, Face ID for sensitive changes). The left rail narrates the story and tells you whose turn it is. Chips in the composer include a prompt-injection attack.

The demo frames Poppy as the backend protocol: before acting, the personal agent reads `/.well-known/poppy.json` and `/poppy/tasks` (live endpoints), declines excluded tasks with Acme's published alternative (chip: cancel my service contract), and approval cards show the Poppy scope hint. A right-hand wire panel labels each step POPPY (open protocol), ACME (policy) or HUMAN. Honest limit: the demo page still authenticates with demo tokens instead of signed Poppy-Session headers (verification itself is in `test_poppy.js`). Any Poppy-compatible agent (Claude, ChatGPT, MUSE) would use the same front door; only Claude and ChatGPT are wired as demo personas.

## Live Claude agent (optional): assistant.js
A real LLM-powered personal agent for Priya, standing in for the vendor harness. It runs as its own process, calls the Anthropic Messages API with a tool loop, and reaches Acme only through the portal as the Claude surface (Poppy discovery, goals, actions, notes) plus a simulated calendar. It cannot approve anything; the portal's tiers and human approvals still apply.

```bash
ANTHROPIC_API_KEY=your-key node assistant.js   # port 4311; CLAUDE_MODEL overrides claude-opus-5-5
```
Open `/demo` and pick Claude: when the assistant reports a key, the Claude phone uses the live agent; otherwise it falls back to the scripted assistant. The key stays in your environment, never in the browser. Raw fetch is used only to keep the prototype zero-dependency. The demo still uses demo tokens, and the calendar is simulated.

Also in the demo: Priya can phone Acme (voice channel, no payments by voice), the phone stays quiet (outcome recap, technical steps behind a toggle). The call overlay and toggle were not click-verified in a browser.

### Long-range behaviour (assistant.js)
The live agent keeps `assistant-state.json` (what it knows about Priya, the goals it owns, its own plan per goal) so it survives restarts. A watcher polls those goals every `WATCH_MS` (4s); when Acme changes one, the agent is woken, decides whether Priya needs to hear it and whether to act, and any message lands in its inbox (`GET /inbox`) which the demo shows on the phone. `ANTHROPIC_BASE_URL` points it at another endpoint (used here to test the loop with a stub). The full week-long scenario is in `STORY.md`. Tested with a stub model: tool loop, goal tracking, memory, restart persistence, wake-ups. Not tested against the real API.

### LLM-driven Acme background agent (acme-agent.js)
`ANTHROPIC_API_KEY=... node acme-agent.js` runs Acme's background agent as an LLM. It reads each goal's state from the ledger (`GET /api/bg/goals`), decides the next step and asks the portal with `POST /api/bg/step`. The portal's gate still decides everything: scopes, tiers, limits, loop guard, human approvals and grants (the portal redeems approved grants itself). While the process runs, the scripted background agent stands down; if it stops for 20s the script takes over again. It only calls the model when a goal's state changes. Tested with a stub model through the full flow (warranty, booking, reminder, exception approved by supervisor then Priya, fee, close); not tested against the real API.


## B2B companion
Business (background) agents arriving at the portal, with organisation identity, contract limits and role-based approvers on both sides: https://github.com/ankitavijay-debug/agent-portal-b2b-prototype
