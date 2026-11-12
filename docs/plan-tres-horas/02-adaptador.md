# Frente 2: adaptador Whatsmeow para Node

## Objetivo

Conservar coordinador, almacenamiento y reglas de aprobación; sustituir el transporte Baileys por un adaptador Whatsmeow. Revisar `WhatsAppPort`, `src/runtime.ts`, `src/coordinator.ts` y `src/whatsapp.ts` antes de fijar el contrato. No asumir que Whatsmeow expone los mismos IDs o acuses.

## Contrato inicial a acordar en 15 minutos

Comunicación local versionada por Unix socket con permisos restrictivos o loopback autenticado; nunca puerto público. Cerrar por defecto ante identidad incierta, desconexión, desbordamiento, fallo de autenticación o versión incompatible.

| Operación o evento | Datos y garantía |
|---|---|
| Estado | Versión, conexión e identidad verificada; identidad diferente bloquea comandos y envíos. |
| Observación | Chat, ID estable, propio/ajeno, tiempo, texto y cita si existen. Solo chats permitidos; ignorar grupos y mensajes anteriores según política actual. |
| Envío | ID reservado y persistido, destinatario permitido, contenido y correlación. Exigir aprobación vigente del destinatario y monto. |
| Resultado | Distinguir error antes de transmitir, acuse o eco verificable y resultado incierto. Aceptación de transporte no es pago. |
| Ciclo de vida | Reconexión, duplicados, nueva vinculación y prueba de chat propio antes de habilitar comandos. |

## Trabajo y pruebas

1. Inventariar IDs reservados, eco, prueba de chat propio, debounce, suspensión de propuestas tras texto nuevo y manejo de incertidumbre existentes.
2. Implementar adaptador con proveedor falso mientras se resuelve passkey. Acordar orden, correlación, límites de cola y apagado con el frente 1.
3. Probar entradas propias, clientes, grupos y chats no permitidos; eventos duplicados o antiguos; cita; identidad incorrecta y reinicio. `SI código` autoriza únicamente una propuesta vigente; una corrección suspende la anterior.
4. Inyectar desconexión antes y después de transmitir, timeout, eco tardío y cola llena. No reenviar si no se demuestra que el primer envío no salió.
5. Integrar la sesión real cuando existan identidad y semántica de acuse comprobadas. Probar el flujo `COBRAR → propuesta → SI código → envío` y reconexión.

## Aceptación

Pruebas falsas y de integración aplicables pasan; garantías actuales preservadas. Entregar SHA, contrato, configuración y evidencia. Una respuesta exitosa del transporte no basta para declarar entrega al cliente.
