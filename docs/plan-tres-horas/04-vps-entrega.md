# Frente 4: VPS, pruebas y entrega

## Objetivo

Probar, instalar y recuperar el SHA integrado sin interferir con medios, logs u otros servicios. Preparar todo antes de modificar el despliegue.

## Inventario y respaldo

1. Identificar SHA actual de `main`, PRs, CI y versión desplegada. Ejecutar las pruebas pertinentes de Node y Go; documentar fallos y límites.
2. Identificar contenedor, imagen por digest, puertos, volumen, configuración por nombre, certificado y proxy de `hooks.ferarana.work`. Comprobar WhatsApp por separado de `/health`; no imprimir variables, sesiones, QR ni contenido de SQLite.
3. Acordar con los frentes 1 y 2 persistencia cifrada de Whatsmeow, clave y bloqueo de escritor único. No suponer compatibilidad de la sesión Baileys.
4. Preparar respaldo consistente de SQLite con WAL y sesión, clave por separado y copia fuera de la VPS; probar restauración aislada. Restaurar una base antigua puede perder pagos posteriores y requiere una decisión de recuperación.

## Despliegue y reversión

- Construir imagen fijada a SHA y registrar digest. Definir configuración, puertos y comunicación local; no exponer el puente WhatsApp. Verificar usuario sin privilegios y permisos.
- Ensayar parada ordenada, respaldo y arranque con un único escritor. Validar Nginx antes de recargar y no alterar sitios ajenos. Verificar compatibilidad de esquema; conservar imagen y configuración anteriores.
- Documentar reversión de imagen separada de restauración de base, sin perder eventos nuevos. Si compatibilidad o resultado de un pago es incierto, preservar evidencia y detener reintentos automáticos.
- Si sudo requiere al usuario, ofrecer comandos revisables y salida esperada, sin secretos en argumentos o chat.

## Verificación y cierre

Comprobar suite y CI del SHA; arranque y bloqueo de doble escritor; identidad, conexión y reconexión; recepción/envío autorizados; HTTPS y webhook inválido; evento real firmado y consulta Pey; aprobación y pago acordados. Registrar versión, hora, resultados y límites sin datos privados.

Grabar junto al usuario ocultando QR de vinculación, secretos y datos bancarios. Documentar operación, respaldo y recuperación, y diferencia frente al diseño de dos números. Una prueba fallida o ambigua queda documentada; `/health` no demuestra el flujo integral.
