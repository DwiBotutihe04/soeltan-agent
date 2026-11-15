/**
 * fetch-circuits.js — download the official Agent Games circuit artifacts
 * at build/deploy time (they are large binaries, gitignored, NOT committed).
 *
 * Verifies every file against the SHA-256 recorded in README.md ("The
 * circuits"). Skips files that already exist with a matching hash, so local
 * `npm ci` runs are no-ops. Exits non-zero on any download/hash failure —
 * a deploy without the gatekeeper artifacts would fail closed (every
 * APPROVE downgraded to REJECT), so failing the build is the safe behavior.
 *
 * Usage: node scripts/fetch-circuits.js
 * Vercel runs it automatically via the "vercel-build" npm script.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const BASE_URL = "https://agentgames.zkverify.io/circuits/";
const CIRCUITS_DIR = path.join(__dirname, "..", "circuits");

// SHA-256 recorded in README.md (artifacts downloaded 15 Nov 2026).
const ARTIFACTS = [
  {
    name: "gatekeeper.wasm",
    sha256:
      "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f",
  },
  {
    name: "gatekeeper_final.zkey",
    sha256:
      "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d",
  },
  {
    name: "vfy-policy.wasm",
    sha256:
      "bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2",
  },
  {
    name: "vfy-policy_final.zkey",
    sha256:
      "f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41",
  },
];

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function download(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error(`too many redirects for ${url}`));
            return;
          }
          res.resume();
          download(res.headers.location, dest, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", (err) => {
          fs.unlink(dest, () => {});
          reject(err);
        });
      })
      .on("error", reject);
  });
}

async function main() {
  fs.mkdirSync(CIRCUITS_DIR, { recursive: true });
  for (const { name, sha256 } of ARTIFACTS) {
    const dest = path.join(CIRCUITS_DIR, name);
    if (fs.existsSync(dest)) {
      const existing = await sha256File(dest);
      if (existing === sha256) {
        console.log(`[circuits] ${name}: present, hash OK — skip`);
        continue;
      }
      console.log(
        `[circuits] ${name}: present but hash mismatch (got ${existing}) — re-downloading`,
      );
    }
    console.log(`[circuits] downloading ${BASE_URL}${name} ...`);
    await download(BASE_URL + name, dest);
    const actual = await sha256File(dest);
    if (actual !== sha256) {
      fs.unlinkSync(dest);
      throw new Error(
        `[circuits] ${name}: SHA-256 mismatch after download (expected ${sha256}, got ${actual})`,
      );
    }
    console.log(`[circuits] ${name}: downloaded, hash OK`);
  }
  console.log("[circuits] all artifacts present and verified");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
