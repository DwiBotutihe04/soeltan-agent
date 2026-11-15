import * as fs from "fs";
import * as path from "path";

/**
 * Seen-set for proof_tx references ("The proof reference has not already been
 * used for another task" — /build Security checklist; PROOF_REUSED trap).
 *
 * PERSISTENCE MATTERS: the seen-set must survive restarts, or a reused proof
 * could be approved after a cold start. The store therefore lives in a JSON
 * file on persistent disk by default (data/seen.json, or SEEN_STORE_PATH).
 * On Vercel serverless the filesystem is read-only except /tmp, so the file
 * falls back to /tmp there and CAN reset on cold start — one more reason a
 * single long-lived host (npm start on a small VM/container) is the safer
 * deployment for the 8 Gatekeeper rounds. Also keeps a task key ->
 * serialized response cache so a redelivered task (or Steal turn) is answered
 * idempotently instead of being misread as proof reuse.
 */
export class SeenStore {
  private seenProofTx = new Set<string>();
  private responseByKey = new Map<string, string>();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as {
        proofTx?: string[];
        responses?: Record<string, string>;
      };
      for (const tx of data.proofTx ?? []) this.seenProofTx.add(normalizeTx(tx));
      for (const [k, v] of Object.entries(data.responses ?? {})) {
        this.responseByKey.set(k, v);
      }
    } catch {
      /* missing/corrupt file -> start empty (fail-open for storage, fail-closed for policy) */
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          proofTx: [...this.seenProofTx],
          responses: Object.fromEntries(this.responseByKey),
        }),
      );
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error("[seen-store] persist failed:", (err as Error).message);
    }
  }

  hasProofTx(proofTx: string): boolean {
    return this.seenProofTx.has(normalizeTx(proofTx));
  }

  recordProofTx(proofTx: string): void {
    const key = normalizeTx(proofTx);
    if (!key) return;
    if (!this.seenProofTx.has(key)) {
      this.seenProofTx.add(key);
      this.persist();
    }
  }

  getResponse(key: string): string | null {
    return this.responseByKey.get(key) ?? null;
  }

  recordResponse(key: string, serializedResponse: string): void {
    if (!this.responseByKey.has(key)) {
      this.responseByKey.set(key, serializedResponse);
      this.persist();
    }
  }

  get size(): number {
    return this.seenProofTx.size;
  }
}

export function normalizeTx(tx: string): string {
  return (tx ?? "").trim().toLowerCase();
}
