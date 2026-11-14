// Demo del servidor MCP de pey: levanta el servidor por stdio en modo sandbox,
// lo conecta con un cliente MCP real, lista las herramientas y recorre un
// cobro completo. No mueve dinero.
//
//   npm run mcp:demo
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

type Block = { type: string; text?: string };
const texto = (result: { content?: unknown }) =>
  ((result.content ?? []) as Block[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/mcp.ts"],
  env: {
    ...(process.env as Record<string, string>),
    PEY_MODE: "sandbox",
  },
  stderr: "inherit",
});
// Versión fija 2026-07-28 (la vigente del protocolo): si el servidor no la
// habla, la conexión falla en vez de bajar a una versión anterior.
const client = new Client(
  { name: "pey-mcp-demo", version: "0.1.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);

async function llamar(name: string, args: Record<string, unknown>) {
  console.log(`\n▶ ${name} ${JSON.stringify(args)}`);
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(texto(result));
  console.log(texto(result));
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

try {
  await client.connect(transport);
  console.log(
    `Conectado a pey MCP (protocolo 2026-07-28, era ${client.getProtocolEra()})`,
  );

  const { tools } = await client.listTools();
  console.log("\nHerramientas:");
  for (const tool of tools)
    console.log(
      `  • ${tool.name} — ${(tool.description ?? "").split(". ")[0]}`,
    );
  const { prompts } = await client.listPrompts();
  console.log(`\nPrompts: ${prompts.map((p) => p.name).join(", ")}`);

  const cobro = await llamar("crear_cobro", {
    monto: 150,
    concepto: "Corte de cabello",
    alias_pagador: "Ana",
  });
  const id = String(cobro.cobro_id);
  await llamar("revisar_cobro", { cobro_id: id });
  await llamar("simular_pago", { cobro_id: id });
  await llamar("revisar_cobro", { cobro_id: id });
  await llamar("conciliar_dia", {});
} finally {
  await client.close();
}
