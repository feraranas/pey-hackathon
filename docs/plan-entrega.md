# Plan para una entrega funcional

Objetivo: demostrar un cobro CoDi real y pequeño, autorizado por el comerciante, desde WhatsApp hasta su confirmación verificada. La entrega inicial usa una sesión del comerciante y su chat propio para control; el diseño de dos números es una etapa posterior.

## Estado comprobado

- El servicio y el receptor HTTPS se desplegaron en la VPS. Una petición al webhook sin firma recibió 401; falta una entrega firmada real.
- La sesión de WhatsApp figura como no registrada. La causa del problema de vinculación con passkey todavía no está confirmada.
- El runtime y diagnósticos están en el [PR #5](https://github.com/feraranas/pey-hackathon/pull/5), pendiente de integración en `main` al redactar este plan.
- OpenAI y una consulta autenticada de Pey se probaron por separado; no se ha demostrado el cobro completo.

## Orden de trabajo para hoy

1. **Consolidar código:** revisar el PR #5, ejecutar la suite completa y verificar CI; integrar el runtime y dejar un procedimiento de despliegue y reversión reproducible.
2. **WhatsApp:** ejecutar el diagnóstico aislado de la VPS y comparar con WhatsApp Web oficial. Resolver la vinculación, confirmar identidad, recepción y acuse de envío en el chat propio y el chat de prueba. Evitar borrar la sesión o reintentar envíos inciertos.
3. **Pey:** confirmar que la cuenta receptora está `ACTIVE`, que el ID de API y el secreto corresponden a la clave configurada y que el webhook apunta al receptor HTTPS. Verificar una entrega firmada, su persistencia y deduplicación, y la consulta de la transacción por API.
4. **Flujo completo:** con el comerciante presente, registrar la cuenta autorizada, generar y aprobar un cobro pequeño, entregarlo al cliente de prueba y confirmar el pago real. Comprobar que el aviso y saldo reflejan el pago una sola vez. Grabar la demostración sin mostrar secretos ni datos bancarios.
5. **Entrega:** documentar versión desplegada, configuración por nombre, arranque, respaldo, recuperación y límites observados. Resolver los fallos encontrados antes de presentar el flujo como validado.

La fecha de hoy es el objetivo, sujeto a que la vinculación de WhatsApp, la activación de la cuenta y las respuestas de Pey permitan completar las pruebas. El soporte de dos números y las funciones opcionales quedan fuera de esta primera entrega.
