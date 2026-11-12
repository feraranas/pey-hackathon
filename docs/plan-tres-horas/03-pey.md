# Frente 3: Pey, webhook y liquidación

## Objetivo

Preparar un pago real pequeño con cuenta receptora `ACTIVE`, QR de monto fijo y confirmación mediante evento firmado y consulta de transacción a Pey.

## Inventario

1. Identificar SHA y versión desplegada; revisar `src/pey.ts`, `src/server.ts`, `src/coordinator.ts` y pruebas. Comprobar por nombre `PEY_API_KEY`, `PEY_API_KEY_ID` y `PEY_WEBHOOK_SECRET`, sin imprimir valores; deben corresponder al mismo webhook.
2. Confirmar en Pey la URL `https://hooks.ferarana.work/webhooks/pey` y eventos `codi.qr.payment_received` y `bank.account.updated`. Consultar por lectura autenticada el estado y titular de la cuenta autorizada. No publicar CLABE, secretos ni payloads completos.
3. Si la cuenta está `PENDING`, verificar con Pey tiempos y alternativas autorizadas; no asumir activación inmediata ni registrar otra cuenta sin decisión del usuario.

## Pruebas locales

- Firma Standard Webhooks sobre cuerpo original, timestamp y rechazo de firmas inválidas. Persistir antes de responder éxito; un fallo de persistencia no puede parecer aceptado.
- Duplicados, reentregas y caídas antes/después del guardado: evento y transacción no deben causar doble acreditación ni aviso. Comprobar IDs incompatibles y eventos no soportados.
- Consultar Pey y comparar estado, monto, moneda, receptor y QR/transacción con la orden. Incompatibilidades pasan a revisión. Una consulta de evento perdido no inventa evidencia firmada.
- Probar segundo pago distinto, pago de versión anterior, sobrepago, errores temporales y timeout. No reintentar ciegamente alta de cuenta ni creación incierta de QR.

## Ensayo con dinero

Con el comerciante presente acordar monto pequeño, cuenta y cliente. Verificar preparación del receptor; generar y aprobar el cobro; observar evento firmado → persistencia → consulta de transacción → acreditación única → aviso y saldo. Probar una reentrega controlada sin segundo aviso. Ante resultado ambiguo investigar antes de crear otro QR o repetir el pago.

Entregar SHA, pruebas, estado de cuenta y límites. Si el banco o Pey bloquean el ensayo, usar fixtures firmados y marcar el resultado como simulación. HTTPS y `/health` no demuestran pago.
