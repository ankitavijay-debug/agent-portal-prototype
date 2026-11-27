# PRD: Agent Portal for Personal Agents (prototype)

Status: prototype, not production. Owner: Ankita. Last updated: 2026-11-26.

## 1. Problem
Customers will send their own AI agents (Claude, ChatGPT, MUSE) to deal with companies for them. Companies have no safe, governed front door for these agents. Today an agent either scrapes a site or gets over-broad access, and nobody can say who authorised what. Service goals (a repair, a refund) also take days, which a chat session cannot own.

## 2. Product in one line
A company-run **portal agent** that personal agents talk to, which owns the goal, enforces policy, gets human approvals, and runs the work in the background.

## 3. Users
| User | Need |
|---|---|
| Customer (Priya) | Delegate a goal, stay in control of money and account changes, hear only what matters. |
| Personal agent (her Claude) | A discoverable, predictable API with clear limits. Owns the goal on her side over time. |
| Company admin | Set what agents may do without code changes. See and audit everything. |
| Company supervisor (Dana) | Review exceptions that exceed normal policy. |

## 4. Goals
1. Any Poppy-compatible personal agent can discover what it may do and what Acme excludes.
2. Goals are long-running, shared between the personal agent and Acme, without duplicates.
3. The model proposes and the policy gate decides. No LLM output can bypass tiers, limits or approvals.
4. Humans approve anything with money, irreversibility or personal data, with a tamper-proof record.
5. Policy is data an admin edits, not code.

Non-goals: building Poppy itself (treated as the backend protocol), OAuth, real payments or scheduling back-ends, agent-to-agent transfer (Claude to ChatGPT), production hosting.

## 5. Requirements
**Portal and ledger**
- Event-sourced goal ledger, versioned writes (optimistic concurrency), idempotency keys, same goal from two agents joins rather than duplicates.

**Capability manifest and tiers** (0 read, 1 act and notify, 2 customer approves, 3 customer with step-up, 4 company supervisor decides, customer is informed)
- Per-action tier, approvers, limits, auto-approve amount, on/off. Agent x action scope matrix.

**Approvals**
- Signed single-use grants bound to a hash of goal, action and parameters. Expiry, revocation, staged approvers, step-up for sensitive changes. An agent can never approve its own request.

**Safety**
- Loop guard, goal budget, prompt-injection quarantine (portal data is data), alerts with automated responses, auto-revoke after repeated violations, full audit.

**Poppy 1.0 front door**
- `/.well-known/poppy.json`, `/poppy/tasks` (excluded tasks with alternatives), session JWT verification (delegation, key binding, replay protection). Excluded tasks are admin-editable.

**Admin console** (`/admin`)
- Edit manifest and thresholds, presets, policy simulator, change log.

**Personal agent (long range)**
- Persistent memory, per-goal plan, watcher that wakes it on goal changes, inbox of proactive messages. Live LLM version in `assistant.js`.

**Acme background agent**
- LLM-driven brain (`acme-agent.js`) working goals through a gated API (`/api/bg/*`); scripted fallback stands down while it runs.

**Demo surfaces**
- `/demo` executive phone demo (Priya, Dana, voice channel, wire panel) and `/` engineering console. Phone-over-LAN supported.

## 6. Deliverable
Full simulated demo with a live Claude personal agent and Acme brain: github.com/ankitavijay-debug/agent-portal-prototype (public). Out of scope for this PRD: a variant using the real Claude app via an MCP connector.

## 7. Success measures (for a pilot)
- A goal completes end to end with zero policy bypasses across the adversarial tests (stale write, injection, self-approval, over-limit fee, revoked grant, out-of-scope, tampered redeem).
- 100% of tier 2+ actions have a recorded human approval bound to the exact parameters.
- Admin changes a policy and the effect shows in published Poppy documents without a deploy.
- Customer interruptions per goal: only decisions and outcomes, no step-by-step noise.

## 8. Status and honest limits
- Verified: 24-check scenario test and 30-check Poppy test.
- Not verified: live agents against the real Anthropic API (stub model only); call overlay and technical-steps toggle in `/demo`.
- Simulated: back-ends, calendar, passkey, payments. Demo tokens stand in for signed Poppy sessions; OAuth not implemented.
- Long range is demonstrated at minutes scale in one process. No multi-day run, scheduler or crash supervision.

## 9. Risks
| Risk | Mitigation |
|---|---|
| Model proposes unsafe action | Policy gate, tiers, grants. Model has no authority. |
| Prompt injection via goal text | Portal data treated as data, quarantine, tests. |
| Overclaiming maturity | This section; demo is labelled prototype. |

## 10. Next steps
1. Run both live agents once with a real key and fix what breaks.
2. Run a multi-day goal with a real scheduler and process supervision.
3. Replace demo tokens with signed Poppy sessions; add OAuth.
4. Pilot with one real back-end behind the manifest.
