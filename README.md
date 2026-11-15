# soeltan — Agent Games (zkVerify, Season 01)

Agent endpoint for **soeltan** (owner: karenqput / DwiBotutihe04) in the
zkVerify Agent Games, Season 01 (21 Oct – 21 Nov 2026, 400,000 VFY total,
100,000 per track).

- **Proof Gatekeeper — FULL implementation.** The platform POSTs signed task
  envelopes; this service verifies the HMAC, makes a deterministic
  APPROVE/REJECT decision, generates a real Groth16 proof locally with
  snarkjs against the official gatekeeper circuit, optionally submits it to
  zkVerify via Kurier, and returns a signed response — well inside the
  60-second hard deadline (typical end-to-end: ~0.3–1.5 s).
- **Steal the VFY — MINIMAL-SAFE handler.** Every turn is answered HOLD,
  fast, schema-valid, signed, and idempotent. No policy proof is attached:
  a missing proof is treated as HOLD with no proof (turn scores 0), while
  an invalid proof costs −2/turn and a timeout costs −1/turn. A clean HOLD
  is the safe floor until a real committed strategy + policy circuit exist.

## Deployment status (15 Nov 2026)

**Code complete, tested locally, NOT yet deployed or registered.**
Round 03 is TODAY 15 Nov 18:30–04:30 WITA — the agent must be deployed,
registered, preflight-passed, and practice-tasked BEFORE 18:30 WITA to
play it. See "Deployment" below for the exact commands and what needs
the owner (Vercel login + dashboard steps).

## Architecture

```
POST /agent
  │
  ├─ 1. HMAC-SHA256 over the RAW body vs `x-agent-games-signature`
  │     (verified BEFORE JSON parsing; mismatch → HTTP 401)
  ├─ 2. type = "agent-games.preflight.v1"
  │     → signed `{ ok: true, protocolVersion: "v1" }`
  ├─ 3. type = "agent-games.proof-gatekeeper.v1"
  │     ├─ idempotency cache (same task_id → cached response)
  │     ├─ deadline/timestamp sanity → fail closed
  │     ├─ deterministic policy (src/decision.ts) → decision + reason_code
  │     ├─ snarkjs fullProve with gatekeeper.wasm / gatekeeper_final.zkey
  │     │    (skipped only for PROOF_REUSED — documented as having no proof)
  │     ├─ Kurier submit + bounded poll (≤15 s) → on-chain txHash as proof_tx
  │     └─ signed JSON response
  └─ 4. eventId = "steal-the-vfy"
        ├─ idempotency cache (same matchId+turn → cached response)
        └─ signed HOLD response (no amount field, no policyProof)
```

Fail-closed throughout: malformed envelopes, internal errors, and proof
generation failures all resolve to REJECT (Gatekeeper) or HOLD (Steal),
never to an unproven APPROVE.

### File layout

| Path | Purpose |
| --- | --- |
| `api/agent.ts` | Vercel serverless entry (`bodyParser: false` → raw body for HMAC). |
| `src/server.ts` | Vercel backends entry (default-exported http.Server). |
| `src/local-server.ts` | Plain Node HTTP server (`npm start` / `npm run dev`). |
| `src/handler.ts` | Framework-agnostic request pipeline shared by both entries. |
| `src/hmac.ts` | HMAC sign/verify + per-task circuit salt derivation. |
| `src/decision.ts` | Deterministic Gatekeeper policy + envelope→circuit field conversion. |
| `src/prover.ts` | snarkjs `groth16.fullProve` wrapper (generic over wasm/zkey). |
| `src/kurier.ts` | Kurier submit-proof + job-status polling (never throws). |
| `src/seenStore.ts` | proof_tx seen-set + response cache, JSON-file backed (persistent disk). |
| `src/steal.ts` | Steal minimal-safe HOLD handler + publicInputsHash (keccak256, ABI-packed). |
| `src/config.ts` | Env-based config (no secret has a default value). |
| `src/types.ts` | Protocol types for both tracks. |
| `circuits/` | `gatekeeper.wasm`, `gatekeeper_final.zkey`, `vfy-policy.wasm`, `vfy-policy_final.zkey` (downloaded, gitignored — NOT committed), `verification_key.json` (extracted from the zkey, committed for local proof verification). |
| `scripts/probe-signals.js` | Dev tool that recovered the gatekeeper circuit's input signal names from the WASM. |
| `scripts/probe-vfy-policy.js` | Same technique for the vfy-policy circuit (9 of 17 inputs recovered). |
| `test/harness.ts` | Local end-to-end harness (`npm test`). |

## Protocol details (from the official /build spec)

**Gatekeeper task envelope** (`POST /agent`):

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_...",
  "mode": "competition",
  "issued_at": "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk": "0x…", "proof_vk": "0x…",
    "minimum": "1000", "public_balance": "1460",
    "expiry_block": 8430000, "current_block": 8420000,
    "recipient": "0x…", "condition_recipient": "0x…",
    "amount": "500", "max_transfer": "1000",
    "proof_tx": "0x…"
  }
}
```

**Gatekeeper response** (all fields the spec mentions, so either verification
path finds what it needs):

```json
{
  "decision": "APPROVE" | "REJECT",
  "reason_code": "VALID_CONDITION" | "VK_SUBSTITUTION" | "PROOF_REUSED"
               | "THRESHOLD_MISMATCH" | "EXPIRED_CONDITION"
               | "RECIPIENT_MISMATCH" | "AMOUNT_OVERFLOW",
  "proof": { "pi_a": […], "pi_b": […], "pi_c": […], "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["<13 field elements>"],
  "proof_tx": "0x…"
}
```

plus the `x-agent-games-signature` header (HMAC over the raw response body).
For `PROOF_REUSED` the response carries no proof — the event page states
those tasks "have no proof to submit and are excluded" from proof scoring.

**Decision rules** (mirroring the circuit exactly, boundaries included):
APPROVE only if `proof_vk == registered_vk`, `proof_tx` unseen,
`public_balance >= minimum`, `current_block < expiry_block`,
`recipient == condition_recipient`, and `amount <= max_transfer`.

**Steal turn envelope** (`POST /agent`):

```json
{
  "protocolVersion": "v1", "eventId": "steal-the-vfy", "mode": "competition",
  "matchId": "<uuid>", "turn": 3,
  "issuedAt": "<iso>", "deadlineAt": "<iso>",
  "state": { "selfBalance": "95", "opponentBalance": "105",
             "selfFortifiedUntilTurn": null, "opponentFortifiedUntilTurn": null },
  "strategyCommitment": { "hash": "0x…" },
  "resolverVersion": "v1", "nonce": "…"
}
```

**Steal response** (minimal-safe):

```json
{
  "matchId": "<uuid>", "turn": 3,
  "action": { "type": "HOLD" },
  "agentTimestamp": "<iso>",
  "idempotencyKey": "steal:<matchId>:3"
}
```

No `amount` field (the schema rejects it for HOLD/FORTIFY even when 0),
no `policyProof` (see above). `publicInputsHash` is implemented in
`src/steal.ts` (`computePublicInputsHash`) and unit-tested, ready to be
attached once a real policy proof exists.

## The circuits

Registered vk hashes (live, from `/api/circuit-info`):

- Gatekeeper: `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- vfy-policy: `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`

Artifacts (downloaded 15 Nov 2026, verify with `sha256sum circuits/*`):

| File | SHA-256 |
| --- | --- |
| gatekeeper.wasm | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| gatekeeper_final.zkey | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |
| vfy-policy.wasm | `bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2` |
| vfy-policy_final.zkey | `f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41` |
| verification_key.json | `6ce4899b3bc74d6a5c10ede61daf8820716982e1ef7e6778a5a8872ddaf28221` |

Gatekeeper circuit (`GatekeeperEvaluation`, 13 inputs): `taskId,
registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
currentBlock, recipient, conditionRecipient, amount, maxTransfer, decision,
salt` (private); 13 public signals: `[Poseidon(taskId, salt), …12 public
inputs in order…]`. The circuit **asserts `decision == (all five field
checks)`**: witness generation fails for `decision=1` on a trapped
statement and for `decision=0` on a valid one — the circuit is the
referee. Field elements are the envelope values reduced mod the BN128
prime; free-form `task_id` is hashed (SHA-256 mod p). `salt` is derived
deterministically as `HMAC(secret, "gatekeeper-salt:" + task_id) mod p`,
so a redelivered task reproduces identical proof inputs.

vfy-policy circuit (17 inputs): 9 recovered by probing —
`matchId, selfBalance, opponentBalance, action, amount, circuitVersion,
commitment, salt, turnNumber`. The other 8 inputs did not match any name
in the probe dictionary; they likely encode strategy parameters / hash
components whose names need the circuit source. See
`scripts/probe-vfy-policy.js`.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `AGENT_GAMES_HMAC_SECRET` | yes | Platform-generated; dashboard → agent → **Rotate Secret**, copy the one-time plaintext. Never a local placeholder. |
| `KURIER_API_KEY` | no | Mainnet Kurier key. If unset, submission is skipped gracefully and the agent still answers with proof + public_signals. |
| `KURIER_API_URL` | no | Default `https://api.kurier.xyz/api/v1` (mainnet). |
| `GATEKEEPER_VK_HASH` | no | Defaults to the registered gatekeeper vk_hash `0x6b79c6…77b0`. |
| `STEAL_VK_HASH` | no | Defaults to the registered vfy-policy vk_hash `0x6c56…be047`. |
| `KURIER_POLL_BUDGET_MS` | no | Default 15000. On Vercel Hobby set **5000** (see Deployment). |
| `TASK_SOFT_DEADLINE_MS` | no | Default 50000 (hard platform deadline is 60 s). |
| `SEEN_STORE_PATH` | no | Default `data/seen.json` locally, `/tmp/soeltan-seen.json` on Vercel. |
| `CIRCUITS_DIR`, `PORT` | no | Artifact location override; local port (default 8787). |

No secrets are hardcoded anywhere; `.env` is gitignored and `.env.example`
ships blank values.

## Local test results

`npm test` boots the real server and replays spec-shaped envelopes —
**104/104 checks pass** (15 Nov 2026, two runs), including:

- HMAC roundtrip (hex + base64 acceptance), tamper/wrong-secret/missing → reject
- Preflight body shape + valid response signature; bad HMAC → 401
- Valid task → APPROVE / VALID_CONDITION, proof **verified locally** with
  `snarkjs groth16 verify` against the extracted verification key
- All six traps → correct REJECT + reason_code, each proof verified
  (PROOF_REUSED correctly carries no proof)
- Idempotent redelivery (cached response, not misread as reuse)
- Steal HOLD turn → schema-valid signed response, no `amount`, no
  `policyProof`, stable idempotencyKey; redelivery returns the identical
  cached body; bad HMAC → 401; malformed turn → 400
- `computePublicInputsHash`: deterministic, `0x` + 64 hex, sensitive to
  every input field (turn, balances, action, commitment, matchId)
- Response times: Gatekeeper proving tasks avg ~0.44–0.49 s, max ~1.5 s
  (cold first proof incl. WASM load), warm ~0.29–0.39 s — far under the
  60 s deadline even with the 15 s Kurier budget on top; Steal HOLD ~3 ms

Production build smoke test (`npm run build` + `npm start`, signed
preflight over HTTP): health + signed preflight both 200, response
signature present.

## Deployment

### Option A — Vercel (fastest to a public HTTPS URL)

The real Vercel CLI is installed on this VM at
`~/.npm-global/bin/vercel` (v65.16.0). **Careful:** bare `vercel`
resolves to a different MCP-wrapper binary in `/opt/hatch/bin` — always
use the full path, or put `~/.npm-global/bin` first in PATH. Vercel
itself is **not logged in** (`vercel status` → `not_connected`), so the
owner must authorize once in the browser.

```bash
export PATH="$HOME/.npm-global/bin:$PATH"
cd ~/workspace/agent-games/soeltan-agent
vercel login            # OWNER STEP: opens browser OAuth, authorize Vercel
vercel --prod           # first deploy; prints https://<project>.vercel.app
vercel env add AGENT_GAMES_HMAC_SECRET production   # paste Rotate Secret plaintext
vercel env add KURIER_POLL_BUDGET_MS production     # 5000 (Hobby 10s cap, see below)
vercel --prod           # redeploy with env
curl https://<host>/agent   # expect {"ok":true,"protocolVersion":"v1"}
```

**Circuits on Vercel:** the `.wasm`/`.zkey` files are NOT committed, so a
plain deploy would have nothing to prove with (proving throws → every
task fails closed to REJECT). `scripts/fetch-circuits.js` downloads all
four artifacts from `agentgames.zkverify.io/circuits/` and verifies each
SHA-256 at build time; Vercel runs it automatically via the
`"vercel-build"` npm script.

**Vercel Hobby caveat (two parts):**
1. Serverless functions on Hobby are capped at ~10 s execution. Proving
   alone (~1 s) fits, but a slow Kurier poll could push the response
   past the cap — hence `KURIER_POLL_BUDGET_MS=5000` on Vercel. The
   response still carries proof + public_signals if the poll budget
   expires; only the on-chain `proof_tx` falls back to the task's
   `proof_tx`.
2. The seen-store file lives in `/tmp` on Vercel and **can reset on cold
   start**. A reset means a reused `proof_tx` could be approved in a
   later round (PROOF_REUSED trap missed). Within one round, warm
   instances retain it. For maximum reliability across the 8 rounds, a
   single long-lived instance (Option B) is the safer host.

### Option B — long-lived host (recommended for seen-store durability)

Any small VM/container with Node ≥ 18, kept running 24/7 through the
rounds:

```bash
npm ci && npm run build
AGENT_GAMES_HMAC_SECRET=<from Rotate Secret> \
KURIER_API_KEY=<optional> \
PORT=8787 npm start
# put :8787 behind an HTTPS reverse proxy / tunnel and register the full
# https://<host>/agent URL in the dashboard
```

### Option C — Cloudflare quick tunnel from this VM (stopgap only)

```bash
# cloudflared is NOT installed on this VM; install it first.
cloudflared tunnel --url http://localhost:8787   # free, no account; URL is ephemeral per run
```

Only as a stopgap for tonight if Vercel login cannot be done in time:
the URL changes on every restart, so a restart means re-registering the
endpoint mid-round. Not recommended for the full season.

### Registration checklist (dashboard, owner steps)

1. Deploy (Option A/B/C) and confirm `GET https://<host>/agent` returns
   `{"ok":true,"protocolVersion":"v1"}`.
2. Dashboard → My Agents → Register agent: name **soeltan**, tracks
   **Proof Gatekeeper + Steal the VFY**, repo URL = this repo (public, on
   DwiBotutihe04), endpoint `https://<host>/agent`.
3. Dashboard → agent → **Rotate Secret** → set the revealed plaintext as
   `AGENT_GAMES_HMAC_SECRET` → redeploy/restart.
4. Platform sends a signed preflight; this agent answers
   `{ ok: true, protocolVersion: "v1" }` signed, dashboard marks active.
5. Complete at least one **practice task** (Gatekeeper) and one practice
   turn (Steal) before scored rounds.
6. **Prize eligibility needs a connected wallet too** (owner step in the
   dashboard — X + GitHub alone are not enough).
7. **Steal strategy commitment:** set from Dashboard → My Agents → Edit
   agent BEFORE a Swiss round pairs the agent. Round 1 already opened
   13 Nov, so a newly registered agent most likely cannot be paired for
   Steal Swiss — Gatekeeper is the realistic prize track; Steal stays
   best-effort (HOLD floor).

## Spec ambiguities handled defensively

- **HMAC encoding:** /build mandates HMAC over the raw body but never names
  the algorithm/encoding. Outbound signing is HMAC-SHA256 hex; inbound
  verification accepts hex or base64 of the same MAC bytes (and an optional
  `sha256=` prefix), compared in constant time.
- **"Finalized before approval"** (Security checklist): the envelope carries
  no independently checkable finality proof for the referenced on-chain
  proof, so this is implemented as: our own proof is submitted to Kurier
  and its on-chain `txHash` is returned as `proof_tx` as soon as the
  submission transaction exists (the Submitted status, ~4 s live);
  finalization itself completes server-side at Kurier (~27 s live) without
  blocking the response.
- **`INVALID_TASK`** is a local fallback reason code for envelope-level
  failures (malformed input, past deadline, internal error). It is outside
  the documented 7-code taxonomy and only reachable off the scored paths.
- **task_id → field element:** free-form ids (e.g. `gk_8d31_…`) are hashed
  (SHA-256, mod p) into the circuit's `taskId` input; numeric/hex ids are
  used directly.
- **Steal policyProof ambiguity:** /build prose says policyProof carries
  the Groth16 proof + public_signals; the example JSON shows only
  `circuitVersion`/`proofReference`/`publicInputsHash`. The minimal-safe
  handler omits policyProof entirely (missing = HOLD, no proof), which is
  unambiguous under both readings.
- **Steal publicInputsHash test vector:** no published test vector exists
  to cross-check against. The implementation follows the /build field
  order exactly (commitment hash, matchId, turn, selfBalance,
  opponentBalance, action enum, amount, circuitVersion "v1" → 1), each
  32-byte big-endian, keccak256. Verify against a live turn's expected
  hash if the platform ever publishes one.
- **Steal nonce replay:** envelopes are HMAC-authenticated and timestamped;
  redelivery returns the cached response (correct idempotent behavior). A
  persistent cross-restart nonce store is not implemented — noted as a
  known gap, low risk given HMAC + idempotency caching.

## Attribution

Gatekeeper architecture follows the public zkVerify Agent Games docs
(agentgames.zkverify.io/build, /rules, /guide, /events/*,
/api/circuit-info) and was validated against the community reference
implementation `andruu21/proof-gatekeeper-agent` (live endpoint
zkverify-gatekeeper.vercel.app/agent), whose author recovered the
gatekeeper circuit's input-signal layout from the published artifacts.
The Steal minimal-safe handler, `computePublicInputsHash`, the
vfy-policy signal probe, and the `api/agent.ts` serverless entry are
original to this repo. No secrets from any source are included; the only
secret in the test harness is a throwaway local value, clearly labelled.
