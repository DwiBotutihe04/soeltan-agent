import { keccak256 } from "js-sha3";
import type { StealActionType, StealResponse, StealTurnEnvelope } from "./types";

/**
 * Steal the VFY — MINIMAL-SAFE handler.
 *
 * The full event requires a per-turn Groth16 policy proof that the action
 * follows the strategy committed on the dashboard. This agent does not own a
 * committed strategy (the commitment is set from Dashboard → My Agents →
 * Edit agent before Swiss Round 1, and Round 1 already opened 13 Nov), so
 * it cannot produce a valid policy proof. The safe floor, per the event
 * page's own score model, is a clean HOLD with NO proof attached:
 *
 *   - missing proof  -> treated as HOLD with no proof (turn scores 0)
 *   - invalid proof  -> -2 / turn (strictly worse)
 *   - no response    -> forced HOLD with -1 timeout penalty (strictly worse)
 *
 * So: always answer HOLD, fast, schema-valid, signed, idempotent per turn.
 * A HOLD response must NOT carry an `amount` field — the schema rejects it
 * even when 0.
 *
 * This module also implements the public-inputs hash exactly as specified on
 * /build (keccak256 over ABI-packed 32-byte big-endian fields), ready for
 * the day a real policy proof is implemented. It is NOT attached to the
 * HOLD response today (it lives inside policyProof, which we omit).
 */

// Action enum, per /build: HOLD 0, FORTIFY 1, EXTRACT 2.
export const STEAL_ACTION_ENUM: Record<StealActionType, number> = {
  HOLD: 0,
  FORTIFY: 1,
  EXTRACT: 2,
};

const CIRCUIT_VERSION_FIELD = 1n; // circuitVersion "v1" -> 1

function toBytes32(value: bigint): Buffer {
  const hex = value.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

function hashToBytes32(hash: string): Buffer {
  const h = (hash ?? "").trim().toLowerCase().replace(/^0x/, "");
  if (/^[0-9a-f]{64}$/.test(h)) return Buffer.from(h, "hex");
  // Defensive: a short/odd hash is left-padded into 32 bytes.
  if (/^[0-9a-f]+$/.test(h) && h.length < 64) {
    return Buffer.from(h.padStart(64, "0"), "hex");
  }
  // Last resort: hash the raw string itself (keeps the function total).
  return Buffer.from(keccak256(hash ?? ""), "hex");
}

function matchIdToBytes32(matchId: string): Buffer {
  const stripped = (matchId ?? "").replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(stripped)) {
    return toBytes32(BigInt("0x" + stripped));
  }
  // Non-UUID matchId: hash the raw id into the field (defensive fallback).
  return Buffer.from(keccak256(matchId ?? ""), "hex");
}

function parseDecimal(v: unknown): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) return BigInt(v.trim());
  throw new Error(`not a non-negative integer: ${String(v)}`);
}

/**
 * publicInputsHash = keccak256(abi.encodePacked(
 *   strategyCommitment.hash, matchId, turn, selfBalance, opponentBalance,
 *   actionEnum, amount, circuitVersion )) — each field 32-byte big-endian.
 * Field order is load-bearing: the platform recomputes this hash from the
 * game state it knows and rejects proofs whose hashes diverge.
 */
export function computePublicInputsHash(params: {
  strategyCommitmentHash: string;
  matchId: string;
  turn: number;
  selfBalance: string;
  opponentBalance: string;
  action: StealActionType;
  amount: number;
}): string {
  const packed = Buffer.concat([
    hashToBytes32(params.strategyCommitmentHash),
    matchIdToBytes32(params.matchId),
    toBytes32(BigInt(params.turn)),
    toBytes32(parseDecimal(params.selfBalance)),
    toBytes32(parseDecimal(params.opponentBalance)),
    toBytes32(BigInt(STEAL_ACTION_ENUM[params.action])),
    toBytes32(BigInt(params.amount)),
    toBytes32(CIRCUIT_VERSION_FIELD),
  ]);
  return "0x" + keccak256(packed);
}

/** Idempotency key: unique per match+turn, deterministic across redelivery. */
export function stealIdempotencyKey(matchId: string, turn: number): string {
  return `steal:${matchId}:${turn}`;
}

/** Structural validation of a Steal turn envelope. Returns null on any malformed field. */
export function parseStealTurn(envelope: Record<string, unknown>): StealTurnEnvelope | null {
  if (!envelope || typeof envelope !== "object") return null;
  const matchId = envelope.matchId;
  const turn = envelope.turn;
  const state = envelope.state as Record<string, unknown> | undefined;
  if (typeof matchId !== "string" || !matchId) return null;
  if (typeof turn !== "number" || !Number.isSafeInteger(turn) || turn < 0) return null;
  if (!state || typeof state !== "object") return null;
  if (typeof state.selfBalance !== "string" || typeof state.opponentBalance !== "string") {
    return null;
  }
  try {
    parseDecimal(state.selfBalance);
    parseDecimal(state.opponentBalance);
  } catch {
    return null;
  }
  const commitment = envelope.strategyCommitment as { hash?: unknown } | undefined;
  return {
    protocolVersion: typeof envelope.protocolVersion === "string" ? envelope.protocolVersion : "v1",
    eventId: "steal-the-vfy",
    mode: typeof envelope.mode === "string" ? envelope.mode : undefined,
    matchId,
    turn,
    issuedAt: typeof envelope.issuedAt === "string" ? envelope.issuedAt : undefined,
    deadlineAt: typeof envelope.deadlineAt === "string" ? envelope.deadlineAt : undefined,
    state: {
      selfBalance: state.selfBalance,
      opponentBalance: state.opponentBalance,
      selfFortifiedUntilTurn:
        typeof state.selfFortifiedUntilTurn === "number" ? state.selfFortifiedUntilTurn : null,
      opponentFortifiedUntilTurn:
        typeof state.opponentFortifiedUntilTurn === "number"
          ? state.opponentFortifiedUntilTurn
          : null,
    },
    strategyCommitment:
      commitment && typeof commitment.hash === "string" ? { hash: commitment.hash } : undefined,
    resolverVersion:
      typeof envelope.resolverVersion === "string" ? envelope.resolverVersion : undefined,
    nonce: typeof envelope.nonce === "string" ? envelope.nonce : undefined,
  };
}

/**
 * Build the minimal-safe HOLD response. No `amount` field, no policyProof.
 * Deterministic idempotencyKey per turn; agentTimestamp is the response time.
 */
export function buildHoldResponse(turn: StealTurnEnvelope): StealResponse {
  return {
    matchId: turn.matchId,
    turn: turn.turn,
    action: { type: "HOLD" },
    agentTimestamp: new Date().toISOString(),
    idempotencyKey: stealIdempotencyKey(turn.matchId, turn.turn),
  };
}
