# Evidencia de la implementación

El MVP de texto se ejecuta con Node 24 y SQLite. Esta entrega incluye adaptadores de pey, Baileys y OpenAI, pero no equivale a una instalación productiva.

## Comprobaciones reproducibles

`npm run verify` comprueba formato y tipos, ejecuta las pruebas, compila, corre la demo y revisa enlaces locales. La ejecución final tiene 67 pruebas únicas en ocho archivos. [Salida completa](verification.txt). Las pruebas cubren aprobación por código y cita, identidad, ecos, dos cobros simultáneos, cambios de cotización, vencimientos, receptor, moneda, centavos, duplicados, incertidumbre, reinicios y restauración de respaldos.

La [salida de la demo](demo.txt) y el [video](demo.mp4) provienen de `npm run demo`. El video presenta el texto emitido por la ejecución; no es una grabación de WhatsApp. La demo usa proveedor pey, transporte y extractor falsos etiquetados, junto con el coordinador, SQLite, Standard Webhooks y Fastify reales.

Para regenerar el video se requieren Python, Pillow y FFmpeg:

```bash
python3 -m venv /tmp/pey-video
/tmp/pey-video/bin/pip install Pillow
/tmp/pey-video/bin/python scripts/demo-video.py
```

El contenedor se construyó y pasó la demo con `--network none`, una petición HTTP real al healthcheck y una comprobación del usuario sin privilegios. También rechazó el arranque sin configuración. Ver [construcción](docker-build.txt) y [smoke test](docker-smoke.txt). No se desplegó públicamente.

## Integraciones comprobadas

La [prueba de integraciones](integrations.json) guarda solo datos sintéticos y el resultado resumido de una consulta, sin claves ni transacciones privadas.

- OpenAI `gpt-4.1-mini` devolvió una extracción correcta de una cotización de $1,200 con anticipo de $600.
- El script comprueba también cotización ambigua e instrucciones maliciosas de un cliente.
- La clave de pey respondió `200` a `GET /transaction/api-key`. Eso comprueba autenticación de lectura, no creación de QR ni recepción de dinero.
- OpenAI devolvió inicialmente `429` por saldo agotado. Tras la recarga del usuario, se repitió la prueba correctamente.

Para repetir estas solicitudes reales, carga un archivo privado con `PEY_API_KEY` y `OPENAI_API_KEY`:

```bash
node --env-file=/ruta/privada/pey.env --import tsx scripts/check-integrations.ts
```

El script usa texto ficticio en OpenAI y solo lectura en pey. No registra cuentas ni crea cobros.

## Estado frente al plan

| Corte | Entrega |
|---|---|
| 0. Esqueleto | TypeScript estricto, Node 24, SQLite WAL, configuración, redacción de logs, CI |
| 1. Núcleo | Snapshots, aprobaciones, versiones, outbox, saldos separados y pruebas de recuperación |
| 2. pey | Cliente HTTP, firmas sobre cuerpo crudo, inbox duradero, validación y consulta de conciliación |
| 3. WhatsApp | Adaptador con sesión cifrada, identidad, allowlist, IDs reservados, ACK, reconexión y pruebas con socket falso |
| 4. Extracción | Salida estructurada con evidencia, espera persistente, descarte de resultados obsoletos y prueba real con OpenAI |
| 5. Onboarding | CLABE con checksum, consentimiento versionado, registro, consulta de estados y bloqueo hasta ACTIVE |
| 6. Ensayo | Demo integral simulada que pasa sus aserciones, sin pasos ocultos |
| 7. Audio opcional | No incluido |
| 7b. Página opcional | No incluida; se entrega la imagen del QR y su desglose |
| 8. Entrega | Guía de operación, video, contenedor y evidencia |

Las maquetas del commit `efab8b9` se conservaron. Ilustran audio, una página opcional y conversaciones naturales que no son evidencia de funcionalidades ejecutadas. Los comandos operativos exactos están en [la guía de operación](../operacion.md).

## Límites pendientes de prueba real

Falta vincular un teléfono del comerciante, completar los datos del webhook y disponer de una cuenta receptora `ACTIVE`. No se registró ninguna CLABE ni se creó un QR real durante esta ejecución. Tampoco se enviaron mensajes reales a clientes.

El adaptador exige preservar el ID de mensaje y recibir ACK o eco. Esa comprobación está probada con socket falso; queda pendiente su aceptación en una sesión real de Baileys. El ruteo de un QR y la correspondencia entre IDC, `payableId` y `amountBreakdown.base` también requieren una operación real autorizada.

La conciliación por consulta abre una revisión si falta un webhook firmado. No marca ese pago como verificado. Las notas de voz, la página de cobro, el resumen diario en lenguaje natural y el despliegue público quedan fuera de la entrega ejecutada.

## Coordinación y decisiones

Se usaron las skills de `pstack-for-codex-local` 0.4.0 para planificar, distribuir archivos, verificar y registrar decisiones. Los hooks de persistencia entre turnos no se pudieron confirmar. Los subagentes se solicitaron con `gpt-6.1-terra`; no hay una medición independiente del modelo servido por el proveedor.

Tres propietarios implementaron núcleo, pey y WhatsApp/extracción. Otros carriles revisaron los riesgos. Las escrituras se separaron por archivos en un worktree aislado. El coordinador integró, ejecutó las pruebas y retuvo los efectos externos. La revisión es independiente entre agentes del modelo solicitado, no una revisión entre familias de modelos.

El [flujo de trabajo](workflow.md) y el [registro de decisiones](decisions.tsv) contienen el alcance y las correcciones. Las pruebas ejecutables son la evidencia autoritativa de comportamiento.

## Atención de la revisión independiente

Revisor solicitado `gpt-6.1-terra`; modelo servido no observable de forma independiente. La revisión final señaló la corrección del cliente durante la espera de extracción; se agregó suspensión inmediata y su prueba. El análisis de comentarios eliminó una narración redundante. No se instaló `deslop`; se revisaron manualmente el diff, los comentarios y las supresiones antes del commit.

Siguen abiertas la aceptación de WhatsApp con teléfono real y las operaciones reales de alta, QR y pago. La consulta `200` de pey solo demuestra lectura autenticada. Los cortes de audio y página son opcionales y no se implementaron.
