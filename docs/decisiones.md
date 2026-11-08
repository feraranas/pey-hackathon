# Decisiones

Este documento resume las alternativas que se compararon y por qué se eligió cada una. Se compararon dos arquitecturas completas y una revisión independiente las calificó. La revisión se hizo en el mismo entorno, no con un equipo externo.

## 1. Un servicio persistente en vez de gateway más worker

**Elegido:** un proceso Node.js con Fastify, Baileys, SQLite en WAL y un worker interno.

**Alternativa evaluada con seriedad:** dos procesos del mismo repositorio, un *gateway* que solo mantiene la sesión de Baileys y una app/worker con webhooks, IA y reglas de dinero. Ambos se comunicarían mediante tablas en PostgreSQL (`SELECT … FOR UPDATE SKIP LOCKED` como cola).

| Criterio | Un servicio + SQLite | Gateway + worker + PostgreSQL |
|---|---|---|
| Redesplegar la lógica sin tumbar la sesión de WhatsApp | No: un reinicio reconecta Baileys (lo cubren el cursor y la deduplicación) | **Sí**: es su mejor argumento |
| Aislar fallas | Una falla de la app afecta el socket | Mejor aislamiento |
| Varios workers o sesiones en el futuro | Requiere migrar | Preparado |
| Esfuerzo en menos de un día | Menor: un proceso, sin base gestionada | Mayor: dos entrypoints, PostgreSQL, polling de tablas |
| Superficie de fallas nuevas | Menor | Más estados entre procesos |
| Latencia de la IA | No bloquea: una llamada HTTP asíncrona no detiene el event loop de Node | Mismo comportamiento; **no** es una razón para separar |

Para una demo de una sola sesión, el beneficio principal de separar (redesplegar sin reconectar) no compensa el trabajo extra. Los módulos se separan igual (`whatsapp/`, `pey/`, `coordinator/`), y la outbox y los trabajos ya son durables en tablas. Si el producto pasa a varias sesiones o workers, el siguiente paso natural es esa división con PostgreSQL.

Se descartaron Redis, colas externas, microservicios y serverless: el socket de WhatsApp necesita un proceso vivo, y más infraestructura no reduce la complejidad del problema real (autorización y dinero).

## 2. Herramientas estrechas en vez de MCP de toda la API

El coordinador llama a cinco o seis funciones del adaptador de pey. El modelo no tiene herramientas de acción: devuelve hechos. Un servidor MCP que envuelva toda la API de pey le daría al modelo capacidades monetarias que el diseño quiere fuera de su alcance. Queda como opción futura para **consultas** de solo lectura.

## 3. Agente libre o reglas en el prompt: descartado

Un agente que lee chats y opera el portal parece simple, pero dejaría las reglas de dinero (quién autoriza, a quién se envía, cuándo está pagado) en manos del prompt. Además, la ingeniería inversa del portal está prohibida en los términos (cl. 4.2). Las reglas viven en código y en restricciones SQL.

## 4. Autorización: cita del prompt o código único

Se comparó contra la opción de aceptar un "sí" suelto cuando hay una sola oferta abierta. Esa opción es más cómoda, pero ambigua tras reconexiones o mensajes cruzados, y obligaría a limitar las órdenes a un cobro abierto por cliente, lo que impediría cobrar anticipo y saldo a la vez. Se eligió la cita del prompt o el código: es casi igual de cómoda y está ligada a un digest.

## 5. Órdenes con varios cobros de monto fijo

Un QR tiene un monto fijo (nunca `amount = 0`). El "pago parcial" ocurre a nivel orden, con varios `ChargeIntent` aprobados uno por uno. Esto evita insinuar que un QR acepta abonos y mantiene un saldo claro: verificado, efectivo registrado y pendiente, cada uno por separado.

## 6. Máquinas de estado separadas

Una sola enumeración (`proposed … sent … paid`) no puede representar un pago verificado que llega mientras la entrega está incierta. Por eso se usan cuatro máquinas independientes por intent (aprobación, creación, entrega y liquidación) y una más para el saldo de la orden.

## 7. Resultados inciertos: revisión, no reintento

Las APIs externas no ofrecen exactly-once, y pey no documenta clave de idempotencia ni búsqueda de QR por referencia.

- **Creación incierta:** sin `qrString` no hay nada que enviar. Por eso un QR "fantasma" no llega al cliente por este sistema. Aun así, un nuevo intento exige un nuevo "sí".
- **Entrega incierta:** se espera el eco con el ID preasignado; si no aparece, se pasa a revisión.
- **Registro de CLABE incierto:** revisión manual, porque no existe búsqueda por CLABE.

## 8. Eco del bot: ID preasignado

Se evaluó registrar los mensajes del bot *después* de enviarlos, pero eso deja una ventana en la que el eco puede confundirse con el comerciante. También se evaluó buscar en el historial tras una caída, que no es confiable. En Baileys 7 RC se verificó en el código que `sendMessage` acepta `messageId`, así que el ID se genera y persiste antes de enviar. Si en la sesión real no funciona, los comandos se deshabilitan.

## 9. QR primero; link hospedado fuera

`POST /payment-link/create` no acepta `bankAccountId`, así que no puede dirigir el dinero a la CLABE de cada comerciante. Hasta que pey lo documente, el link no forma parte del producto.

## 10. Sin sandbox asumido

La documentación vigente recomienda probar en producción con centavos y anuncia un ambiente de pruebas "próximamente". Las pruebas automáticas usan un proveedor falso explícito. Cualquier transacción real es una decisión humana aparte.

## 11. Permiso de plataforma

El equipo confirmó que puede registrar CLABEs de distintos comercios bajo su API key. Los términos se citan en [integraciones](integraciones.md#términos-del-api-de-pey) solo como referencia, sin convertirlos en un bloqueo. El consentimiento guardado documenta la autorización del comerciante; no se presenta como prueba de titularidad.
