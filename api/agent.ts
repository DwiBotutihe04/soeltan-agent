import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../src/config";
import { AgentHandler } from "../src/handler";
import { SeenStore } from "../src/seenStore";
import { SIGNATURE_HEADER } from "../src/types";

/**
 * Vercel serverless entrypoint for POST /agent (and GET /agent health).
 *
 * `bodyParser: false` is load-bearing: the HMAC must be verified over the
 * RAW request body, before any JSON parsing. The handler is shared with the
 * long-lived Node server (src/local-server.ts).
 *
 * One handler instance per module load; the seen-store file lives in /tmp on
 * Vercel and can reset on cold start — see README "Deployment" for why a
 * long-lived host is the safer choice for the 8 Gatekeeper rounds.
 */
export const config = {
  api: { bodyParser: false },
};

let handler: AgentHandler | null = null;

function getHandler(): AgentHandler {
  if (!handler) {
    const cfg = loadConfig();
    handler = new AgentHandler(cfg, new SeenStore(cfg.seenStorePath));
  }
  return handler;
}

function readRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function agent(req: VercelRequest, res: VercelResponse): Promise<void> {
  const h = getHandler();

  if (req.method === "GET") {
    const r = h.health();
    res.status(r.status).json(JSON.parse(r.body));
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers[SIGNATURE_HEADER];
  const result = await h.handlePost(
    rawBody,
    Array.isArray(signature) ? signature[0] : signature,
  );
  if (result.signature) res.setHeader(SIGNATURE_HEADER, result.signature);
  res.status(result.status).setHeader("content-type", "application/json").send(result.body);
}
