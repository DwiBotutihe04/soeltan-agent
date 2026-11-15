import { createAgentServer } from "./local-server";

/**
 * Vercel backends entrypoint: the platform expects a default export that is
 * a function or an http.Server. The server is created but NOT listened here;
 * the hosting runtime assigns the port. Local runs use src/local-server.ts
 * via `npm run dev` / `npm run serve`.
 *
 * NOTE: on Vercel Hobby the serverless function may be capped at a 10s
 * execution budget — proving alone (~1s) fits, but set
 * KURIER_POLL_BUDGET_MS=5000 there so a slow Kurier poll cannot push the
 * response past the cap. A long-lived host (npm start) has no such cap and
 * keeps the seen-store on persistent disk — the safer deployment for the
 * 8 Gatekeeper rounds. See README "Deployment".
 */
const server = createAgentServer();

export default server;
