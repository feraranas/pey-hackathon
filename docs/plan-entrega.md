# Plan de entrega: tres horas

Objetivo: demostrar un cobro CoDi real, pequeño y autorizado, desde WhatsApp hasta el aviso de pago verificado por Pey. Tres horas son una meta, sujeta a vinculación de WhatsApp y cuenta bancaria activa.

## Alcance y estado

Una sesión del comerciante; chat propio como control; chats individuales permitidos; aprobación explícita; QR fijo; webhook firmado y deduplicado; consulta a Pey y aviso de saldo. `COBRAR` es el camino mínimo; validar OpenAI después, sin bloquearlo. Dos números, audio y SaaS multiusuario quedan fuera de la primera entrega.

El runtime llegó a `main` en el [PR #5](https://github.com/feraranas/pey-hackathon/pull/5). La VPS puede ejecutar otra versión: verificar su digest. Baileys recibió `passkey_prologue_request` sin completar la vinculación; WhatsApp Web oficial sí funcionó. Whatsmeow soporta el intercambio pero requiere firma WebAuthn y aún no se ha probado con esta cuenta. HTTPS y el rechazo de webhook sin firma se comprobaron; el pago integral y la cuenta `ACTIVE` siguen por verificar.

## Cuatro frentes paralelos

| Frente | Documento | Entregable |
|---|---|---|
| Whatsmeow | [01 Vinculación y sesión](plan-tres-horas/01-whatsmeow.md) | Passkey, identidad y reconexión demostradas en una sesión aislada. |
| Adaptador | [02 Integración Node](plan-tres-horas/02-adaptador.md) | Contrato y adaptador probados con simulador y sesión real. |
| Pey | [03 Pagos y webhook](plan-tres-horas/03-pey.md) | Cuenta y configuración comprobadas; pruebas de pago y eventos. |
| VPS | [04 Despliegue y entrega](plan-tres-horas/04-vps-entrega.md) | Respaldo y reversión ensayados; versión, pruebas y demo. |

Cada responsable usa un worktree propio, acuerda archivos y contrato antes de escribir y comparte SHA, pruebas y límites con el integrador. No poner secretos, sesiones, bases, desafíos ni datos bancarios en Git o chat.

## Reloj

| Tiempo | Hito |
|---|---|
| 0–15 min | Inventario de `main` y VPS; fijar contrato y responsables; lanzar los cuatro frentes. |
| 15–60 min | Prototipo de passkey y adaptador simulado; pruebas Pey; preparar respaldo. Reportar evidencia a los 45 min. |
| 60–105 min | Demostrar vinculación y reconexión; integrar adaptador y receptor. A los 90 min decidir si cuenta y WhatsApp permiten prueba real. |
| 105–150 min | Integrar un SHA, verificar, desplegar con respaldo y realizar una transacción pequeña junto al comerciante. |
| 150–180 min | Verificar acreditación única, aviso y saldo; grabar demo y documentar versión y límites. |

Si WhatsApp o cuenta `ACTIVE` bloquean el pago a los 90 minutos, completar pruebas simuladas y documentar el bloqueo; nunca afirmar que un pago real funcionó. El comerciante participa en la aprobación, pago y grabación; no repetir pagos o envíos inciertos.

## Criterios de entrega

1. Sesión vinculada, identidad esperada verificada, reconexión tras reinicio y recepción/envío en chats autorizados.
2. El comerciante revisa destinatario, importe y cuenta y aprueba una propuesta vigente antes del envío.
3. QR real a cuenta `ACTIVE`, pago pequeño, webhook firmado persistido y transacción confirmada por API.
4. Duplicados o reinicios no duplican la acreditación ni el aviso; incertidumbres pasan a revisión sin reintentos ciegos.
5. Pruebas y CI del SHA desplegado; configuración, respaldo, recuperación y demostración documentados sin secretos.

Registrar fecha, versión, resultado y límites por criterio. Etiquetar cualquier demostración simulada como tal.
