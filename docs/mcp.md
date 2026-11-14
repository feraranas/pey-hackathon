# Servidor MCP de pey

Un servidor [MCP](https://modelcontextprotocol.io) para que un agente de IA (Claude Desktop, Cursor o cualquier cliente MCP) cobre con pey: crea cobros CoDi, revisa si pagaron, hace el corte del día y registra la cuenta del negocio.

- **Protocolo:** MCP **`2026-07-28`**, la revisión vigente según la [página de versionado](https://modelcontextprotocol.io/specification/versioning) (consultada el 14 de noviembre de 2026). Cambios frente a `2025-11-25`: [changelog oficial](https://modelcontextprotocol.io/specification/2026-07-28/changelog). Es la primera revisión sin `initialize` ni sesiones; el SDK sigue atendiendo también a clientes de la era 2025.
- **SDK:** [`@modelcontextprotocol/server` y `@modelcontextprotocol/client` 2.4.0](https://www.npmjs.com/package/@modelcontextprotocol/server) (la v2, línea estable que implementa `2026-07-28`; publicada el 23 de octubre de 2026). El paquete anterior `@modelcontextprotocol/sdk` 1.x sigue existiendo, pero es la línea previa. [Documentación del SDK](https://ts.sdk.modelcontextprotocol.io/v2/).
- **Transporte:** stdio (el cliente lanza el servidor como proceso hijo).
- **Cliente de pey:** reutiliza `PeyClient` (`src/pey.ts`): `Authorization: Bearer <clave>` contra `https://api.pey.mx`, igual que el resto de la app.

> pey **no** tiene reembolsos, retiros ni saldos, y este servidor no los inventa. `conciliar_dia` suma pagos recibidos; no es el saldo de la cuenta.

## Arranque rápido (sandbox, sin dinero real)

```bash
npm install
npm run mcp:demo    # recorre un cobro completo con un cliente MCP real
npm run mcp         # servidor por stdio, para conectarlo a un cliente
```

Por defecto corre en **sandbox**: levanta en memoria un pey de mentira en `127.0.0.1` con una cuenta activa de ejemplo. Nada sale a internet ni se mueve dinero. En ese modo existe además la herramienta `simular_pago`, para ver un cobro pasar a pagado.

## Herramientas

| Herramienta | Qué hace | Endpoint de pey |
| --- | --- | --- |
| `crear_cobro` | Cobra `monto` MXN con `concepto`. Con `telefono_pagador` manda la solicitud CoDi al celular; sin él, un QR CoDi (imagen incluida) o un link de pago (`metodo: "link"`). Opcional: `alias_pagador`, `cuenta_id`, `metodo` (`auto`, `qr`, `link`, `push`). Devuelve `cobro_id`. | `POST /codi/qr`, `/codi/pn`, `/payment-link/create` |
| `revisar_cobro` | Dice si un `cobro_id` (`qr:…`, `link:…`, `tx:…`) ya está pagado, pendiente, procesando o parcial. | `GET /transaction/codi/qr/{id}`, `/payment-link/{id}`, `/transaction/{id}` |
| `conciliar_dia` | Pagos recibidos en un día (hoy en `America/Mexico_City` por defecto), con totales por método. Opcional: `fecha`, `cuenta_id`, `max_paginas`. | `GET /transaction/api-key` o `/transaction/bank-account/{id}` |
| `registrar_cuenta` | Da de alta una cuenta: `alias`, `nombre_legal`, `clabe` (se valida el dígito verificador), `tipo_persona` (`persona_fisica` o `empresa`). | `POST /bank-account` |
| `consultar_cuenta` | Estado de activación CoDi de una cuenta (`PENDING`, `PROCESSING`, `ACTIVE`, `ERROR`). | `GET /bank-account/{id}` |
| `simular_pago` | **Solo sandbox.** Marca como pagado un cobro de prueba. | — |

Todas las descripciones y los mensajes están en español, los esquemas son [zod](https://zod.dev) y cada herramienta lleva anotaciones (`readOnlyHint`, etc.) para que el cliente decida cuándo pedir permiso. Las CLABEs siempre salen enmascaradas (`**************1234`) y los teléfonos solo con los últimos cuatro dígitos.

## Prompts y skills

El servidor publica cuatro **prompts MCP**; un cliente los muestra como comandos:

| Prompt | Para qué |
| --- | --- |
| `cobra_al_cliente` (`monto`, `concepto`, `telefono?`) | «Cóbrale 150 a Ana» |
| `revisa_si_pago` (`cobro_id?`) | «¿Ya pagó?» |
| `reconcilia_el_dia` (`fecha?`) | «Haz el corte de hoy» |
| `da_de_alta_mi_cuenta` | «Registra mi CLABE» |

Son las mismas instrucciones de [`mcp/skills/`](../mcp/skills/README.md), en formato `SKILL.md`: un negocio puede entregárselas tal cual a cualquier agente (Cursor: `.cursor/skills/`; Claude Code: `.claude/skills/`) aunque no use prompts MCP.

## Variables de entorno

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `PEY_MODE` | `sandbox` | `sandbox` o `production`. |
| `PEY_API_KEY` | — | Clave de pey. **Obligatoria en producción**; en sandbox se ignora. |
| `PEY_BASE_URL` | `https://api.pey.mx` | Solo HTTPS. |
| `PEY_MCP_ALLOW_WRITES` | `false` en producción | En producción, sin `true` no se crean cobros ni cuentas. |
| `PEY_MCP_MAX_AMOUNT` | `100` en producción | Tope en pesos por cobro. En sandbox, sin tope práctico. |
| `PEY_BANK_ACCOUNT_ID` | cuenta ligada a la clave | Cuenta que recibe los cobros. |
| `PEY_LINK_SUCCESS_URL` / `PEY_LINK_BACK_URL` | `https://pey.mx/` | Regreso del cliente tras pagar o cancelar un link (HTTPS). |
| `PEY_QR_EXPIRATION_SECONDS` | `3600` | Vigencia del QR (mínimo 360). |
| `PEY_MCP_TIMEZONE` | `America/Mexico_City` | Zona para «hoy» en `conciliar_dia`. |

## Producción: dinero real

La clave de producción mueve dinero de verdad. El servidor la protege en capas:

1. **Sandbox por defecto.** Hay que pedir `PEY_MODE=production` a propósito.
2. **Escrituras apagadas.** En producción, `crear_cobro` y `registrar_cuenta` fallan hasta que el dueño inicie el servidor con `PEY_MCP_ALLOW_WRITES=true`. Las lecturas (`revisar_cobro`, `conciliar_dia`, `consultar_cuenta`) siempre funcionan.
3. **Tope por cobro.** $100 MXN salvo que se indique `PEY_MCP_MAX_AMOUNT`.
4. **Confirmación en dos pasos.** Sin `confirmar: true`, las escrituras solo devuelven una **vista previa**; el agente debe enseñársela al dueño y repetir con `confirmar: true`. Las skills le indican hacerlo así.
5. **Sin simulador.** `simular_pago` no existe en producción.
6. **Secretos.** La clave nunca aparece en respuestas ni en logs; el servidor escribe solo a stderr.

Recomendación: prueba primero en sandbox, luego con `PEY_MCP_MAX_AMOUNT=1` y un cobro de $1 a tu propia cuenta.

## Conectarlo a un cliente MCP

Sustituye `/ruta/a/pey-hackathon` por la ruta del repositorio (después de `npm install`).

### Claude Desktop

Edita `claude_desktop_config.json` (menú *Settings → Developer → Edit Config*) y reinicia la aplicación:

```json
{
  "mcpServers": {
    "pey": {
      "command": "/bin/sh",
      "args": [
        "-c",
        "cd /ruta/a/pey-hackathon && exec node --import tsx src/mcp.ts"
      ],
      "env": { "PEY_MODE": "sandbox" }
    }
  }
}
```

Para producción añade en `env`: `"PEY_MODE": "production"`, `"PEY_API_KEY": "…"`, `"PEY_MCP_ALLOW_WRITES": "true"` y `"PEY_MCP_MAX_AMOUNT": "100"`.

### Cursor

En `.cursor/mcp.json` del proyecto (o `~/.cursor/mcp.json` para todos):

```json
{
  "mcpServers": {
    "pey": {
      "command": "node",
      "args": ["--import", "tsx", "src/mcp.ts"],
      "cwd": "/ruta/a/pey-hackathon",
      "env": { "PEY_MODE": "sandbox" }
    }
  }
}
```

Si tu versión de Cursor no respeta `cwd`, usa la forma `/bin/sh -c "cd … && exec …"` de Claude Desktop.

### Cualquier otro cliente MCP

El servidor habla MCP por stdio: lanza `node --import tsx src/mcp.ts` desde la raíz del repositorio, con las variables de entorno de arriba. Con el SDK de TypeScript:

```ts
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client(
  { name: "mi-agente", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
await client.connect(
  new StdioClientTransport({ command: "node", args: ["--import", "tsx", "src/mcp.ts"] }),
);
const r = await client.callTool({
  name: "crear_cobro",
  arguments: { monto: 150, concepto: "Corte de cabello" },
});
```

### MCP Inspector

Para probar las herramientas a mano, sin ningún agente:

```bash
npx @modelcontextprotocol/inspector node --import tsx src/mcp.ts
```

Abre la pestaña que se lanza en el navegador, pulsa **Connect** y usa las pestañas *Tools* y *Prompts*. Con las variables de entorno de la interfaz puedes fijar `PEY_MODE`.

## Demo

`npm run mcp:demo` lanza el servidor en sandbox, lo conecta con un cliente MCP real (versión fijada a `2026-07-28`), lista herramientas y prompts, y ejecuta `crear_cobro` → `revisar_cobro` (pendiente) → `simular_pago` → `revisar_cobro` (pagado) → `conciliar_dia`.

## Cómo está hecho

- `src/mcp.ts`: punto de entrada stdio (`serveStdio`).
- `src/mcp/tools.ts`: las herramientas y sus esquemas.
- `src/mcp/prompts.ts`: los prompts, que leen `mcp/skills/*/SKILL.md`.
- `src/mcp/config.ts`: variables de entorno y límites.
- `src/mcp/sandbox.ts`: pey de mentira. Reutiliza `createPeySandbox` y le añade los endpoints que el MCP necesita (listados, push, links de pago) sin tocar el sandbox base.
- `src/pey.ts`: `PeyClient` ganó `createCodiQr`, `createPush`, `createPaymentLink`, `getPaymentLink` y `listTransactions`, con los mismos esquemas estrictos y la misma autenticación.
- `test/mcp.test.ts`: pruebas de configuración, herramientas (cliente MCP real en memoria y por stdio), protección de producción y forma real de la API.

Límites conocidos: no hay transporte HTTP (solo stdio); `conciliar_dia` revisa hasta 10 páginas de 80 pagos; el sandbox de este servidor no emite webhooks.
