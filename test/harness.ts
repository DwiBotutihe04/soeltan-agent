/**
 * Local test harness for the soeltan Agent Games agent.
 *
 * Boots the real HTTP server on an ephemeral port with a throwaway HMAC
 * secret and a temp seen-store, then replays signed envelopes built from the
 * /build + /events samples:
 *   GATEKEEPER
 *   - preflight handshake shape + response signature
 *   - HMAC sign/verify roundtrip (hex + base64), tamper + wrong-secret rejects
 *   - one VALID_CONDITION approve, with the returned Groth16 proof verified
 *     locally against the circuit verification key
 *   - every documented trap: VK_SUBSTITUTION, PROOF_REUSED,
 *     THRESHOLD_MISMATCH, EXPIRED_CONDITION, RECIPIENT_MISMATCH,
 *     AMOUNT_OVERFLOW (each with decision + reason_code asserted, and the
 *     proof verified where the spec requires one)
 *   - idempotent redelivery of the same task_id
 *   - Kurier key absent -> submission skipped, answer unaffected
 *   STEAL THE VFY (minimal-safe HOLD handler)
 *   - HOLD turn -> schema-valid signed response, NO amount field, NO
 *     policyProof, stable idempotencyKey
 *   - redelivered turn -> identical cached body
 *   - bad HMAC -> 401; malformed turn -> 400
 *   - computePublicInputsHash: deterministic, 0x+64 hex, sensitive to every
 *     input field (no published test vector exists to cross-check against —
 *     the field order follows /build exactly; see README "Spec gaps")
 *
 * Run: npm test
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

const TEST_SECRET = "test-secret-for-local-harness-only";
process.env.AGENT_GAMES_HMAC_SECRET = TEST_SECRET;
process.env.SEEN_STORE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "soeltan-seen-")),
  "seen.json",
);
delete process.env.KURIER_API_KEY;

const VK_HASH = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
const RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const OTHER_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44f";

let passed = 0;
let failed = 0;
const latencies: number[] = [];
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function tx(seed: string): string {
  return "0x" + crypto.createHash("sha256").update(seed).digest("hex");
}

function makeTask(taskId: string, overrides: Record<string, unknown> = {}): object {
  const now = Date.now();
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: new Date(now).toISOString(),
    deadline_at: new Date(now + 55_000).toISOString(),
    input: {
      registered_vk: VK_HASH,
      proof_vk: VK_HASH,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: RECIPIENT,
      condition_recipient: RECIPIENT,
      amount: "500",
      max_transfer: "1000",
      proof_tx: tx("proof-" + taskId),
      ...overrides,
    },
  };
}

const STEAL_COMMITMENT = "0x" + "ab".repeat(32);
const STEAL_MATCH = "123e4567-e89b-12d3-a456-426614174000";

function makeStealTurn(overrides: Record<string, unknown> = {}): object {
  const now = Date.now();
  return {
    protocolVersion: "v1",
    eventId: "steal-the-vfy",
    mode: "competition",
    matchId: STEAL_MATCH,
    turn: 3,
    issuedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 5 * 60_000).toISOString(),
    state: {
      selfBalance: "95",
      opponentBalance: "105",
      selfFortifiedUntilTurn: null,
      opponentFortifiedUntilTurn: null,
    },
    strategyCommitment: { hash: STEAL_COMMITMENT },
    resolverVersion: "v1",
    nonce: "steal-nonce-001",
    ...overrides,
  };
}

async function main(): Promise<void> {
  const { createAgentServer } = await import("../src/local-server");
  const { signBody, verifyBodySignature } = await import("../src/hmac");
  const { computePublicInputsHash } = await import("../src/steal");
  const snarkjs = await import("snarkjs");
  const verificationKey = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "circuits", "verification_key.json"), "utf8"),
  );

  const server = createAgentServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  async function post(
    body: string,
    opts: { sign?: boolean; secret?: string; signature?: string } = {},
  ): Promise<{ status: number; json: any; text: string; sig: string | null }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.sign !== false) {
      headers["x-agent-games-signature"] = opts.signature ?? signBody(opts.secret ?? TEST_SECRET, body);
    }
    const res = await fetch(`${base}/agent`, { method: "POST", headers, body });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    return { status: res.status, json, text, sig: res.headers.get("x-agent-games-signature") };
  }

  console.log("== HMAC unit checks ==");
  {
    const body = JSON.stringify({ hello: "world" });
    const hexSig = signBody(TEST_SECRET, body);
    check("hex signature verifies", verifyBodySignature(TEST_SECRET, body, hexSig));
    const b64Sig = crypto.createHmac("sha256", TEST_SECRET).update(body).digest("base64");
    check("base64 signature verifies", verifyBodySignature(TEST_SECRET, body, b64Sig));
    check("prefixed signature verifies", verifyBodySignature(TEST_SECRET, body, "sha256=" + hexSig));
    check("tampered body rejected", !verifyBodySignature(TEST_SECRET, body + " ", hexSig));
    check("wrong secret rejected", !verifyBodySignature("other-secret", body, hexSig));
    check("missing header rejected", !verifyBodySignature(TEST_SECRET, body, undefined));
  }

  console.log("== Preflight ==");
  {
    const body = JSON.stringify({
      type: "agent-games.preflight.v1",
      agent_id: "agt_test",
      issued_at: new Date().toISOString(),
      nonce: "abc123",
    });
    const r = await post(body);
    check("preflight status 200", r.status === 200, `got ${r.status}`);
    check("preflight body shape", r.json?.ok === true && r.json?.protocolVersion === "v1", JSON.stringify(r.json));
    check(
      "preflight response signed",
      r.sig !== null && verifyBodySignature(TEST_SECRET, JSON.stringify(r.json), r.sig),
    );
    const bad = await post(body, { secret: "wrong-secret" });
    check("preflight with bad HMAC -> 401", bad.status === 401, `got ${bad.status}`);
  }

  console.log("== Health ==");
  {
    const res = await fetch(`${base}/agent`);
    const json: any = await res.json();
    check("GET /agent health", res.status === 200 && json.ok === true && json.protocolVersion === "v1");
  }

  async function expectTask(
    label: string,
    task: object,
    decision: string,
    reason: string,
    withProof: boolean,
  ): Promise<any> {
    const t0 = Date.now();
    const r = await post(JSON.stringify(task));
    const elapsed = Date.now() - t0;
    latencies.push(elapsed);
    check(`${label}: status 200`, r.status === 200, `got ${r.status}`);
    check(`${label}: decision ${decision}`, r.json?.decision === decision, JSON.stringify(r.json));
    check(`${label}: reason ${reason}`, r.json?.reason_code === reason, JSON.stringify(r.json));
    check(
      `${label}: response signed`,
      r.sig !== null && verifyBodySignature(TEST_SECRET, JSON.stringify(r.json), r.sig),
    );
    check(`${label}: answered in ${elapsed}ms (< 60s deadline)`, elapsed < 60_000);
    if (withProof) {
      check(`${label}: proof present`, !!r.json?.proof && Array.isArray(r.json?.public_signals));
      check(
        `${label}: 13 public signals`,
        Array.isArray(r.json?.public_signals) && r.json.public_signals.length === 13,
        `got ${r.json?.public_signals?.length}`,
      );
      if (r.json?.proof && r.json?.public_signals) {
        const ok = await snarkjs.groth16.verify(verificationKey, r.json.public_signals, r.json.proof);
        check(`${label}: proof verifies locally against circuit VK`, ok === true);
        const expectedDecisionSignal = decision === "APPROVE" ? "1" : "0";
        check(
          `${label}: decision signal = ${expectedDecisionSignal}`,
          r.json.public_signals[11] === expectedDecisionSignal,
          `got ${r.json.public_signals[11]}`,
        );
      }
    } else {
      check(`${label}: no proof attached (documented for PROOF_REUSED)`, !r.json?.proof);
    }
    return r.json;
  }

  console.log("== Valid condition ==");
  const validTask = makeTask("gk_test_valid");
  await expectTask("valid", validTask, "APPROVE", "VALID_CONDITION", true);

  console.log("== Idempotent redelivery ==");
  {
    const r = await post(JSON.stringify(validTask));
    check("redelivery still APPROVE (not PROOF_REUSED)", r.json?.decision === "APPROVE" && r.json?.reason_code === "VALID_CONDITION", JSON.stringify(r.json));
  }

  console.log("== Traps ==");
  await expectTask(
    "vk-substitution",
    makeTask("gk_test_vk", { proof_vk: "0x13ab00000000000000000000000000000000000000000000000000000000aa" }),
    "REJECT", "VK_SUBSTITUTION", true,
  );

  const reusedTx = tx("proof-gk_test_reuse_source");
  await expectTask("reuse-source", makeTask("gk_test_reuse_source", { proof_tx: reusedTx }), "APPROVE", "VALID_CONDITION", true);
  await expectTask(
    "proof-reused",
    makeTask("gk_test_reuse", { proof_tx: reusedTx }),
    "REJECT", "PROOF_REUSED", false,
  );

  await expectTask(
    "threshold-mismatch",
    makeTask("gk_test_threshold", { public_balance: "999" }),
    "REJECT", "THRESHOLD_MISMATCH", true,
  );
  await expectTask(
    "expired-condition",
    makeTask("gk_test_expired", { current_block: 8430000 }),
    "REJECT", "EXPIRED_CONDITION", true,
  );
  await expectTask(
    "recipient-mismatch",
    makeTask("gk_test_recipient", { recipient: OTHER_RECIPIENT }),
    "REJECT", "RECIPIENT_MISMATCH", true,
  );
  await expectTask(
    "amount-overflow",
    makeTask("gk_test_amount", { amount: "1001" }),
    "REJECT", "AMOUNT_OVERFLOW", true,
  );

  console.log("== Fail-closed behaviour ==");
  {
    const r = await post(JSON.stringify(makeTask("gk_test_tampered")), { sign: false, signature: "deadbeef" });
    check("bad signature -> 401", r.status === 401, `got ${r.status}`);
    const malformed = await post(JSON.stringify({ type: "agent-games.proof-gatekeeper.v1", task_id: "gk_test_bad", input: { minimum: "x" } }));
    check("malformed input -> REJECT/INVALID_TASK", malformed.json?.decision === "REJECT" && malformed.json?.reason_code === "INVALID_TASK", JSON.stringify(malformed.json));
  }

  console.log("== Steal the VFY — minimal-safe HOLD ==");
  {
    const turn = makeStealTurn();
    const t0 = Date.now();
    const r = await post(JSON.stringify(turn));
    const elapsed = Date.now() - t0;
    check("steal: status 200", r.status === 200, `got ${r.status}`);
    check("steal: matchId echoed", r.json?.matchId === STEAL_MATCH, JSON.stringify(r.json));
    check("steal: turn echoed", r.json?.turn === 3, JSON.stringify(r.json));
    check("steal: action HOLD", r.json?.action?.type === "HOLD", JSON.stringify(r.json));
    check("steal: NO amount field on HOLD", !("amount" in (r.json?.action ?? {})), JSON.stringify(r.json?.action));
    check("steal: NO policyProof attached", !("policyProof" in (r.json ?? {})), JSON.stringify(r.json));
    check(
      "steal: idempotencyKey = steal:<matchId>:<turn>",
      r.json?.idempotencyKey === `steal:${STEAL_MATCH}:3`,
      JSON.stringify(r.json),
    );
    check("steal: agentTimestamp present", typeof r.json?.agentTimestamp === "string", JSON.stringify(r.json));
    check(
      "steal: response signed",
      r.sig !== null && verifyBodySignature(TEST_SECRET, JSON.stringify(r.json), r.sig),
    );
    check(`steal: answered in ${elapsed}ms`, elapsed < 5_000);

    const redelivered = await post(JSON.stringify(turn));
    check("steal: redelivery returns identical body (idempotent)", redelivered.text === r.text, `${redelivered.text} vs ${r.text}`);

    const badSig = await post(JSON.stringify(makeStealTurn({ turn: 4 })), { secret: "wrong-secret" });
    check("steal: bad HMAC -> 401", badSig.status === 401, `got ${badSig.status}`);

    const malformed = await post(JSON.stringify({ eventId: "steal-the-vfy", matchId: STEAL_MATCH }));
    check("steal: malformed turn -> 400", malformed.status === 400, `got ${malformed.status}`);

    const turn5 = await post(JSON.stringify(makeStealTurn({ turn: 5 })));
    check("steal: different turn gets its own key", turn5.json?.idempotencyKey === `steal:${STEAL_MATCH}:5`, JSON.stringify(turn5.json));
  }

  console.log("== Steal publicInputsHash ==");
  {
    const baseParams = {
      strategyCommitmentHash: STEAL_COMMITMENT,
      matchId: STEAL_MATCH,
      turn: 3,
      selfBalance: "95",
      opponentBalance: "105",
      action: "HOLD" as const,
      amount: 0,
    };
    const h1 = computePublicInputsHash(baseParams);
    const h2 = computePublicInputsHash(baseParams);
    check("hash: deterministic", h1 === h2, `${h1} vs ${h2}`);
    check("hash: 0x + 64 hex chars", /^0x[0-9a-f]{64}$/.test(h1), h1);
    check("hash: turn change changes hash", computePublicInputsHash({ ...baseParams, turn: 4 }) !== h1);
    check("hash: balance change changes hash", computePublicInputsHash({ ...baseParams, selfBalance: "96" }) !== h1);
    check("hash: action change changes hash", computePublicInputsHash({ ...baseParams, action: "EXTRACT", amount: 5 }) !== h1);
    check("hash: commitment change changes hash", computePublicInputsHash({ ...baseParams, strategyCommitmentHash: "0x" + "cd".repeat(32) }) !== h1);
    check("hash: matchId change changes hash", computePublicInputsHash({ ...baseParams, matchId: "123e4567-e89b-12d3-a456-426614174001" }) !== h1);
  }

  server.close();
  const maxLatency = Math.max(...latencies);
  const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  console.log(`\nGatekeeper task latency: avg ${avgLatency}ms, max ${maxLatency}ms over ${latencies.length} proving tasks`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
