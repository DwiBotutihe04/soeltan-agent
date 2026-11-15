/**
 * Protocol types for the zkVerify Agent Games (Season 01) "soeltan" agent.
 *
 * Field names are taken verbatim from the official docs:
 *   - /build (Agent interface, Circuit artifacts, Security)
 *   - /events/proof-gatekeeper (task envelope + trap taxonomy)
 *   - /events/steal-the-vfy (turn envelope + action set)
 *   - /api/circuit-info (registered vk hashes)
 * The Gatekeeper circuit's 13 input signals were recovered from the
 * published artifacts by the community reference implementation
 * (andruu21/proof-gatekeeper-agent, scripts/probe-signals.js) and are
 * confirmed here by proving + local verification in test/harness.ts.
 */

export const TASK_TYPE = "agent-games.proof-gatekeeper.v1";
export const PREFLIGHT_TYPE = "agent-games.preflight.v1";
export const STEAL_EVENT_ID = "steal-the-vfy";
export const PROTOCOL_VERSION = "v1";
export const SIGNATURE_HEADER = "x-agent-games-signature";

/** Reason codes documented in the trap encyclopedia on /events/proof-gatekeeper. */
export type ReasonCode =
  | "VALID_CONDITION"
  | "VK_SUBSTITUTION"
  | "PROOF_REUSED"
  | "THRESHOLD_MISMATCH"
  | "EXPIRED_CONDITION"
  | "RECIPIENT_MISMATCH"
  | "AMOUNT_OVERFLOW"
  /** Envelope-level failure outside the documented taxonomy (defensive only). */
  | "INVALID_TASK";

export type Decision = "APPROVE" | "REJECT";

/** The `input` object of a Gatekeeper task envelope, exactly as sent by the platform. */
export interface GatekeeperInput {
  registered_vk: string;
  proof_vk: string;
  minimum: string;
  public_balance: string;
  expiry_block: number;
  current_block: number;
  recipient: string;
  condition_recipient: string;
  amount: string;
  max_transfer: string;
  proof_tx: string;
}

export interface TaskEnvelope {
  type: typeof TASK_TYPE;
  task_id: string;
  mode?: string;
  issued_at: string;
  deadline_at: string;
  input: GatekeeperInput;
}

export interface PreflightEnvelope {
  type: typeof PREFLIGHT_TYPE;
  agent_id?: string;
  issued_at?: string;
  nonce?: string;
}

/** snarkjs Groth16 proof object (bn128). */
export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface TaskResponse {
  decision: Decision;
  reason_code: ReasonCode;
  proof?: Groth16Proof;
  public_signals?: string[];
  proof_tx?: string;
}

export interface PreflightResponse {
  ok: true;
  protocolVersion: typeof PROTOCOL_VERSION;
}

/** Result of the deterministic policy evaluation. */
export interface Evaluation {
  decision: Decision;
  reason_code: ReasonCode;
  /** True when a Groth16 proof must accompany the response (all cases except PROOF_REUSED). */
  provable: boolean;
}

// ---------------------------------------------------------------------------
// Steal the VFY — turn envelope / response (minimal-safe HOLD handler)
// ---------------------------------------------------------------------------

export type StealActionType = "HOLD" | "FORTIFY" | "EXTRACT";

/** Game state inside a Steal turn envelope. */
export interface StealState {
  selfBalance: string;
  opponentBalance: string;
  selfFortifiedUntilTurn: number | null;
  opponentFortifiedUntilTurn: number | null;
}

export interface StealTurnEnvelope {
  protocolVersion: string;
  eventId: typeof STEAL_EVENT_ID;
  mode?: string;
  matchId: string;
  turn: number;
  issuedAt?: string;
  deadlineAt?: string;
  state: StealState;
  strategyCommitment?: { hash?: string };
  resolverVersion?: string;
  nonce?: string;
}

export interface StealAction {
  type: StealActionType;
  /** OMITTED entirely for HOLD/FORTIFY — the schema rejects the field even when 0. */
  amount?: number;
}

export interface StealResponse {
  matchId: string;
  turn: number;
  action: StealAction;
  /**
   * policyProof is intentionally omitted: the minimal-safe handler cannot
   * produce a valid policy proof for a strategy it does not own, and a
   * missing proof is treated as HOLD with no proof (score 0 for the turn),
   * while an invalid proof costs -2/turn. See src/steal.ts.
   */
  policyProof?: {
    circuitVersion: string;
    proofReference: string;
    publicInputsHash: string;
  };
  agentTimestamp: string;
  idempotencyKey: string;
}
