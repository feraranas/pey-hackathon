import { readFileSync } from "node:fs";
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

/** Carpeta `mcp/skills`, relativa a este archivo (src/mcp/ → raíz del repo). */
const SKILLS_DIR = new URL("../../mcp/skills/", import.meta.url);

/** Lee un SKILL.md y le quita el frontmatter. */
export function readSkill(name: string): { description: string; body: string } {
  const raw = readFileSync(new URL(`${name}/SKILL.md`, SKILLS_DIR), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`SKILL.md sin frontmatter: ${name}`);
  const description =
    /^description:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim() ?? name;
  return { description, body: match[2]!.trim() };
}

const message = (text: string) => ({
  messages: [
    { role: "user" as const, content: { type: "text" as const, text } },
  ],
});

/**
 * Los cuatro prompts MCP: las mismas skills de `mcp/skills`, listas para que
 * un cliente MCP las ofrezca como comandos («/cobra_al_cliente»).
 */
export function registerPeyPrompts(server: McpServer) {
  const cobra = readSkill("cobra-al-cliente");
  server.registerPrompt(
    "cobra_al_cliente",
    {
      title: "Cobra al cliente",
      description: cobra.description,
      argsSchema: z.object({
        monto: z.string().describe("Monto en pesos MXN. Ej. 150"),
        concepto: z.string().describe("Para qué es el cobro"),
        telefono: z
          .string()
          .optional()
          .describe("Celular del cliente (10 dígitos), opcional"),
      }),
    },
    ({ monto, concepto, telefono }) =>
      message(
        `Cobra al cliente ahora: monto $${monto} MXN, concepto «${concepto}»${
          telefono
            ? `, celular del cliente ${telefono}`
            : ", sin celular (genera un QR)"
        }.\n\n${cobra.body}`,
      ),
  );

  const revisa = readSkill("revisa-si-pago");
  server.registerPrompt(
    "revisa_si_pago",
    {
      title: "Revisa si pagó",
      description: revisa.description,
      argsSchema: z.object({
        cobro_id: z
          .string()
          .optional()
          .describe(
            "cobro_id de crear_cobro; si falta, usa el último de la conversación",
          ),
      }),
    },
    ({ cobro_id }) =>
      message(
        `${
          cobro_id
            ? `Revisa si ya pagó el cobro ${cobro_id}.`
            : "Revisa si ya pagó el último cobro de esta conversación."
        }\n\n${revisa.body}`,
      ),
  );

  const reconcilia = readSkill("reconcilia-el-dia");
  server.registerPrompt(
    "reconcilia_el_dia",
    {
      title: "Reconcilia el día",
      description: reconcilia.description,
      argsSchema: z.object({
        fecha: z
          .string()
          .optional()
          .describe("Día a conciliar (AAAA-MM-DD). Por defecto hoy"),
      }),
    },
    ({ fecha }) =>
      message(
        `Haz el corte ${fecha ? `del ${fecha}` : "de hoy"}.\n\n${reconcilia.body}`,
      ),
  );

  const alta = readSkill("da-de-alta-mi-cuenta");
  server.registerPrompt(
    "da_de_alta_mi_cuenta",
    {
      title: "Da de alta mi cuenta",
      description: alta.description,
      argsSchema: z.object({}),
    },
    () =>
      message(
        `Ayúdame a dar de alta mi cuenta para recibir cobros. Pídeme los datos que falten.\n\n${alta.body}`,
      ),
  );
}
