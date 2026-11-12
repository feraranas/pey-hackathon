#!/usr/bin/env node
// Renderiza docs/diagrams/*.mmd a SVG y PNG con Mermaid CLI y regenera
// docs/diagramas.md a partir de las fuentes canónicas (.mmd).
//
// Uso:
//   node scripts/render-diagrams.mjs          # renderiza y regenera
//   node scripts/render-diagrams.mjs --check  # falla si diagramas.md no coincide
//
// Requiere Node >= 22.13 (requisito de @mermaid-js/mermaid-cli 12) y un Chrome
// disponible para Puppeteer. Para usar un Chrome del sistema:
//   PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node scripts/render-diagrams.mjs
// La CLI se ejecuta con npx; no se agregan dependencias al repositorio.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MERMAID_CLI = "@mermaid-js/mermaid-cli@12.2.0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "docs", "diagrams");
const docPath = join(root, "docs", "diagramas.md");

const diagrams = [
  [
    "arquitectura",
    "Arquitectura y flujo de datos",
    "Componentes, datos y bordes de confirmación humana. Las líneas punteadas desde el chat del cliente son contexto: nunca otorgan autoridad.",
  ],
  [
    "flujo-e2e",
    "Flujo de extremo a extremo",
    "Desde que llega un mensaje hasta el aviso de pago verificado. Aprobación, creación del QR, entrega y pago son pasos distintos.",
  ],
  [
    "estado-onboarding",
    "Estados: alta de la cuenta receptora",
    "Registro de la CLABE en pey. Solo `ACTIVE` habilita cobros reales; la activación puede tardar hasta cinco días hábiles.",
  ],
  [
    "estado-aprobacion",
    "Estados: aprobación de un ChargeIntent",
    "Cada cobro (anticipo, saldo o total) se aprueba por separado y queda ligado a un digest inmutable.",
  ],
  [
    "estado-creacion-entrega",
    "Estados: creación del QR y entrega",
    "Dos máquinas separadas. Los resultados inciertos van a revisión; no hay reintentos ciegos.",
  ],
  [
    "estado-pago-orden",
    "Estados: pago por cobro y saldo de la orden",
    "Un QR tiene monto fijo; el saldo se calcula a nivel WorkOrder sumando cobros verificados y, aparte, efectivo registrado.",
  ],
];

function buildDoc() {
  const parts = [
    "# Diagramas",
    "",
    "<!-- Archivo generado por scripts/render-diagrams.mjs. Edita los .mmd en docs/diagrams/ y vuelve a ejecutar el script. -->",
    "",
    "Las fuentes canónicas están en [`docs/diagrams/`](diagrams/). Cada diagrama tiene su SVG y PNG renderizados con Mermaid CLI; los bloques `mermaid` de abajo se copian automáticamente de esas fuentes.",
    "",
    "Regenerar: `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node scripts/render-diagrams.mjs` (ver [README](../README.md#diagramas)).",
    "",
    "## Índice",
    "",
    ...diagrams.map(
      ([id, title], i) => `${i + 1}. [${title}](#${anchor(title)})`,
    ),
    "",
  ];
  for (const [id, title, desc] of diagrams) {
    const src = readFileSync(join(dir, `${id}.mmd`), "utf8").trimEnd();
    parts.push(
      `## ${title}`,
      "",
      desc,
      "",
      `![${title}](diagrams/${id}.svg)`,
      "",
      `Fuente: [\`${id}.mmd\`](diagrams/${id}.mmd) · [SVG](diagrams/${id}.svg) · [PNG](diagrams/${id}.png)`,
      "",
      "```mermaid",
      src,
      "```",
      "",
    );
  }
  return parts.join("\n");
}

// Ancla al estilo GitHub: minúsculas, sin puntuación, espacios a guiones.
function anchor(title) {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const check = process.argv.includes("--check");
const doc = buildDoc();
if (check) {
  const current = readFileSync(docPath, "utf8");
  if (current !== doc) {
    console.error(
      "docs/diagramas.md no coincide con docs/diagrams/*.mmd; ejecuta el script sin --check.",
    );
    process.exit(1);
  }
  console.log("docs/diagramas.md coincide con las fuentes.");
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "mmdc-"));
const args = ["--yes", MERMAID_CLI];
const pptr = join(tmp, "puppeteer.json");
const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
writeFileSync(
  pptr,
  JSON.stringify(
    exe
      ? { executablePath: exe, args: ["--no-sandbox"] }
      : { args: ["--no-sandbox"] },
  ),
);
const config = join(tmp, "mermaid.json");
writeFileSync(
  config,
  JSON.stringify({
    theme: "default",
    flowchart: { useMaxWidth: false },
    state: { useMaxWidth: false },
  }),
);
try {
  for (const [id] of diagrams) {
    const input = join(dir, `${id}.mmd`);
    for (const [ext, extra] of [
      ["svg", []],
      ["png", ["-s", "2", "-b", "white"]],
    ]) {
      execFileSync(
        "npx",
        [
          ...args,
          "-p",
          pptr,
          "-c",
          config,
          "-i",
          input,
          "-o",
          join(dir, `${id}.${ext}`),
          ...extra,
        ],
        { stdio: "inherit" },
      );
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
writeFileSync(docPath, doc);
console.log(
  `Renderizados ${diagrams.length} diagramas y regenerado docs/diagramas.md`,
);
