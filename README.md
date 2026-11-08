# pey-hackathon

**Cobros CoDi por WhatsApp para quien vive de su oficio.** Un agente observa los chats con clientes que el comerciante elige. Cuando detecta un trabajo acordado, le pregunta en privado si quiere enviar un QR de pey con el desglose. Solo con su "sí" lo envía al cliente correcto, y avisa cuando pey confirma el pago.

> **Estado:** solo diseño y plan. Todavía no hay aplicación, conexión a WhatsApp, cuentas registradas ni transacciones.

![Arquitectura](docs/diagrams/arquitectura.svg)

## El problema

Mecánicos, hojalateros, plomeros, electricistas y otros oficios cobran por WhatsApp: mandan una foto de su CLABE, el cliente la da de alta, transfiere y envía una captura. Después hay que cotejar las capturas contra el banco y recordar quién pagó en efectivo. El problema principal es **cobrar**, no administrar el taller.

## La propuesta

1. **Alta por WhatsApp:** el comerciante da alias, nombre legal, CLABE y tipo de persona, confirma y acepta. El agente la registra en pey y avisa que la activación puede tardar hasta cinco días hábiles.
2. **Detección:** en los chats elegidos, el agente identifica cuándo hay un trabajo y un monto acordados (texto primero; notas de voz opcionales).
3. **Autorización:** prompt privado con un código, por ejemplo "¿Le envío a Ana el anticipo de $600? Responde **SI A7K2**". Solo ese "sí" autoriza **un** QR.
4. **Cobro:** QR CoDi de monto fijo hacia la CLABE del comerciante, enviado con su desglose al cliente exacto.
5. **Confirmación:** un webhook firmado de pey, verificado contra la API, genera el aviso "Recibiste $600 (verificado por pey)" con el saldo de la orden.

Una captura del cliente cuenta como *reportado, pendiente de verificar*, y el efectivo como *registrado por ti*. Solo pey confirma un pago.

## Documentos

| Documento | Contenido |
|---|---|
| [docs/diseno.md](docs/diseno.md) | Uso, modelo de dominio, máquinas de estado, módulos, interfaces, esquema y reglas duras |
| [docs/implementacion.md](docs/implementacion.md) | Stack, cortes verticales con estimaciones, criterios de aceptación, puntos de corte, matriz de pruebas y demo |
| [docs/integraciones.md](docs/integraciones.md) | Contratos verificados de pey (8 nov 2026), webhooks, Baileys, OpenAI, versiones y pendientes |
| [docs/decisiones.md](docs/decisiones.md) | Alternativas comparadas y razones |
| [docs/diagramas.md](docs/diagramas.md) | Arquitectura, flujo de extremo a extremo y cuatro diagramas de estado |

## Stack sugerido

Node.js 24 LTS + TypeScript · Fastify · Baileys 7 · SQLite (WAL, `better-sqlite3`) · SDK de OpenAI con Zod · `standardwebhooks` · Vitest · Pino con redacción. Un solo servicio persistente con HTTPS y un volumen, sin Redis, colas externas ni microservicios. Ver [implementación](docs/implementacion.md#stack) y [decisiones](docs/decisiones.md).

## Alcance

**Incluye:** onboarding de la CLABE, órdenes con anticipo y saldo, QR CoDi, verificación de pagos, efectivo registrado y comprobantes reportados, para una sola sesión de WhatsApp.

**No incluye:** ERP, inventario, facturación, diagnóstico, aprobación extra del cliente, links hospedados (sin `bankAccountId`), multi-sesión SaaS ni MCP de toda la API.

## Diagramas

Las fuentes canónicas son los archivos [`docs/diagrams/*.mmd`](docs/diagrams/). Los SVG, los PNG y [docs/diagramas.md](docs/diagramas.md) se generan con:

```bash
# Requiere Node >= 22.13 y Chrome; usa npx, sin dependencias en el repo
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node scripts/render-diagrams.mjs
node scripts/render-diagrams.mjs --check   # verifica que diagramas.md coincide con los .mmd
```

Para revisar los enlaces locales de la documentación: `python3 scripts/check-links.py`.

## Seguridad

Nunca se versionan secretos: la API key de pey, el secreto del webhook, la clave de OpenAI, la sesión de Baileys y las bases SQLite están excluidos en [.gitignore](.gitignore).
