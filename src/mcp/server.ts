import { McpServer } from "@modelcontextprotocol/server";
import { PeyClient } from "../pey.js";
import { loadMcpConfig, type McpConfig } from "./config.js";
import { registerPeyPrompts } from "./prompts.js";
import { startMcpSandbox } from "./sandbox.js";
import { registerPeyTools, type McpContext } from "./tools.js";

/** Versión del protocolo MCP contra la que se construyó este servidor. */
export const MCP_SPEC_VERSION = "2026-07-28";

const INSTRUCTIONS = `Servidor de pey (cobros CoDi en México). Herramientas: crear_cobro, revisar_cobro, conciliar_dia, registrar_cuenta, consultar_cuenta. Los montos son pesos MXN. pey NO ofrece reembolsos, retiros ni saldos: no los prometas. Crear un cobro no es cobrarlo: confirma el pago con revisar_cobro antes de decir que ya pagaron. Nunca muestres CLABEs completas.`;

/** Arma el servidor MCP con sus herramientas y prompts. */
export function createPeyMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "pey", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerPeyTools(server, ctx);
  registerPeyPrompts(server);
  return server;
}

/**
 * Prepara el contexto según el modo: en sandbox levanta el pey de mentira en
 * un puerto local libre; en producción usa la clave real (PEY_API_KEY).
 */
export async function buildContext(
  config: McpConfig = loadMcpConfig(),
): Promise<McpContext & { close: () => Promise<void> }> {
  if (config.mode === "sandbox") {
    const sandbox = await startMcpSandbox();
    return {
      config: {
        ...config,
        bankAccountId: config.bankAccountId ?? sandbox.accountId,
      },
      pey: new PeyClient({
        apiKey: sandbox.apiKey,
        baseUrl: sandbox.url,
        allowLoopbackHttp: true,
      }),
      sandboxUrl: sandbox.url,
      close: async () => {
        await sandbox.close();
      },
    };
  }
  return {
    config,
    pey: new PeyClient({ apiKey: config.apiKey!, baseUrl: config.baseUrl }),
    close: async () => {},
  };
}
