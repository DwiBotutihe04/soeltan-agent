/**
 * Dev tool: recover the vfy-policy circuit's input signal names from
 * vfy-policy.wasm (same FNV-1a oracle technique as scripts/probe-signals.js).
 *
 * Recovered so far (9 of 17 inputs, all size 1):
 *   matchId, selfBalance, opponentBalance, action, amount,
 *   circuitVersion, commitment, salt, turnNumber
 * The remaining 8 inputs did not match any name in the candidate
 * dictionary — they likely encode strategy parameters / hash components
 * whose names are not guessable without the circuit source.
 *
 * Usage: node scripts/probe-vfy-policy.js [path-to-vfy-policy.wasm]
 */
const fs = require("fs");
const path = require("path");
const { WitnessCalculatorBuilder } = require("circom_runtime");

function fnvHash(str) {
  const M = 2n ** 64n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h *= 0x100000001b3n;
    h %= M;
  }
  return h.toString(16).padStart(16, "0");
}

const CANDIDATES = [
  "matchId", "selfBalance", "opponentBalance", "action", "amount",
  "circuitVersion", "commitment", "salt", "turnNumber",
  "turn", "strategyCommitment", "strategyCommitmentHash", "commitmentHash",
  "policyCommitment", "selfFortified", "opponentFortified",
  "selfFortifiedUntilTurn", "opponentFortifiedUntilTurn",
  "maxExtract", "extractCap", "fortifyCost", "startingBalance", "round",
  "matchTurn", "stateHash", "publicInputsHash", "policyHash", "hash",
  "policy", "strategy", "nonce", "decision", "resolverVersion",
];

(async () => {
  const wasmPath =
    process.argv[2] || path.resolve(__dirname, "..", "circuits", "vfy-policy.wasm");
  const wc = await WitnessCalculatorBuilder(fs.readFileSync(wasmPath));
  const ex = wc.instance.exports;
  console.log("getInputSize():", ex.getInputSize());
  for (const name of CANDIDATES) {
    const h = fnvHash(name);
    const size = ex.getInputSignalSize(parseInt(h.slice(0, 8), 16), parseInt(h.slice(8, 16), 16));
    if (size > 0) console.log(`  input signal: ${name} (size ${size})`);
  }
})();
