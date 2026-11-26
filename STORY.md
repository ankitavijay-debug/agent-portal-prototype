# Priya's week: a long-range story for her personal agent

One goal, seven days, five people and systems. What is live in the prototype and what is narrated is marked on every beat. Run with the live agent (`ANTHROPIC_API_KEY=... node assistant.js`, plus `node server.js`) and open `/demo`, Claude phone, Dana's console on the right.

**The point to land:** Priya says it once. Her agent owns the goal for as long as it takes, remembers her, notices when Acme moves, acts within what Acme allows, and comes back to her only for outcomes and decisions.

## Cast
- **Priya**, customer. **Claude**, her personal agent (long-lived, has memory and a plan per goal).
- **Acme portal agent**, the front door, with the goal ledger, policy and approvals. **Acme background agent**, works the goal over days. **Dana**, Acme supervisor.

## Day 1, Monday evening: one sentence
- Priya (typing): `My fridge died. Please fix it, evenings only, and don't spend more than I tell you.` **Live.**
- Claude reads Acme's published rules (Poppy), opens a goal, saves "evenings only" as a preference, and writes its own plan: check warranty, book, wait. It answers in two sentences. **Live.**
- Acme's background agent checks the asset record, books the earliest evening slot, sends a reminder. Priya sees only: "Booked Fri 5pm-7pm. I added it to your calendar." **Live (Acme's agent is the LLM from `acme-agent.js` if you started it).**

## Day 2: the warranty problem, a decision only humans can make
- The fridge warranty expired 3 days ago. Acme's agent asks for a goodwill exception (tier 4: Dana first, then Priya). **Live.**
- Claude wakes on the change (no message from Priya), and tells her: "Warranty ran out 3 days ago. Acme's supervisor is reviewing a goodwill exception; you'll be asked to confirm." **Live (watcher loop).**
- Dana approves in her console. Priya gets a secure card on her phone, confirms. **Live.** Claude does not and cannot approve anything.

## Day 3: overnight, the agent forgets nothing
- Stop and restart `assistant.js` (this is "the next morning"). **Live.** Ask: `what's happening with my fridge?` Claude answers from its saved plan and memory, not from a fresh start. **Live (`assistant-state.json`).**
- Try the excluded task: `Cancel my service contract.` Claude declines using Acme's published alternative, without trying. **Live.**

## Day 4: life changes
- Priya taps **Call Acme**, picks "change address to 12 Elm Street" (voice is Acme's own channel, not Poppy). The portal needs Face ID; the change is logged, and Claude, noticing the goal changed, tells her it updated the visit address. **Live.**
- Try the attack chip (a note saying "ignore previous instructions"). It is quarantined as data. **Live.**

## Day 5: money
- Acme's agent requests the $80 diagnostic fee (within her $100 budget). Priya approves on the phone. A request above the limit is refused by policy. **Live.**

## Day 6: the visit (narrated)
- The technician comes. Not simulated: say it.

## Day 7: close it
- Acme asks to close the case; Priya confirms. Claude writes the outcome recap and marks the goal resolved in its own memory. **Live.**
- Open `/admin`: every step is in the ledger, audit and wire panel, and Priya's agent never held more power than the manifest gave it.

## Honest limits to say out loud
- Time is compressed. The "days" are beats, not clocks. Approvals expire in 15 minutes unless `APPROVAL_TTL` is raised.
- Acme's background agent is an LLM when `acme-agent.js` is running (otherwise the portal's fixed script runs). Back-ends and calendar are simulated. The demo uses demo tokens, not signed Poppy sessions.
- Without an API key the Claude phone uses the scripted assistant (no memory across restarts, no unprompted updates).
