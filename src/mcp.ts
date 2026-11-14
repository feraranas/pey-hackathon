// Punto de entrada del servidor MCP de pey por stdio.
//
//   npm run mcp                         → sandbox (sin dinero real)
//   PEY_MODE=production PEY_API_KEY=…   → producción (ver docs/mcp.md)
//
// stdout es el canal del protocolo: todo mensaje humano va a stderr.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadMcpConfig } from "./mcp/config.js";
import {
  buildContext,
  createPeyMcpServer,
  MCP_SPEC_VERSION,
} from "./mcp/server.js";

const config = loadMcpConfig();
const ctx = await buildContext(config);
const handle = serveStdio(() => {
  const server = createPeyMcpServer(ctx);
  // Cuando el cliente cierra el pipe, se apaga también el sandbox para que el
  // proceso termine solo.
  server.server.onclose = () => void ctx.close();
  return server;
});
console.error(
  `pey MCP listo (protocolo ${MCP_SPEC_VERSION}, modo ${config.mode}${
    config.mode === "production"
      ? `, escrituras ${config.allowWrites ? "ACTIVAS" : "desactivadas"}, tope ${config.maxAmountCents / 100} MXN`
      : ""
  })`,
);

const shutdown = async () => {
  await handle.close();
  await ctx.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
