import * as path from "path";
import * as snarkjs from "snarkjs";
import type { Groth16Proof } from "./types";

/**
 * Local Groth16 proving with snarkjs fullProve against the downloaded
 * gatekeeper artifacts. Measured locally at ~0.3-1.3s per proof for this
 * circuit, comfortably inside the 60s task deadline.
 *
 * The prover is generic over wasm/zkey paths so the same class can later
 * prove the vfy-policy circuit (circuits/vfy-policy.wasm +
 * circuits/vfy-policy_final.zkey) once a real Steal policy exists.
 */
export class Prover {
  private wasmPath: string;
  private zkeyPath: string;

  constructor(wasmPath: string, zkeyPath: string) {
    this.wasmPath = wasmPath;
    this.zkeyPath = zkeyPath;
  }

  static gatekeeper(circuitsDir: string): Prover {
    return new Prover(
      path.join(circuitsDir, "gatekeeper.wasm"),
      path.join(circuitsDir, "gatekeeper_final.zkey"),
    );
  }

  static vfyPolicy(circuitsDir: string): Prover {
    return new Prover(
      path.join(circuitsDir, "vfy-policy.wasm"),
      path.join(circuitsDir, "vfy-policy_final.zkey"),
    );
  }

  async prove(
    circuitInputs: Record<string, string>,
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }> {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInputs,
      this.wasmPath,
      this.zkeyPath,
    );
    return { proof: proof as Groth16Proof, publicSignals };
  }
}
