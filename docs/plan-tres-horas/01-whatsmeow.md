# Frente 1: Whatsmeow y passkey

## Objetivo

Vincular el número del comerciante con Whatsmeow y demostrar identidad, recepción, envío y reconexión. Empezar con una sesión aislada; no modificar la sesión de Baileys ni el contenedor de producción. QR y códigos son privados.

## Tareas

1. Fijar versión y commit de Whatsmeow; revisar `PairPasskeyRequest`, `SendPasskeyResponse` y `PairPasskeyConfirmation`. La biblioteca transporta el desafío; un autenticador con la passkey de `whatsapp.com` debe firmarlo.
2. Confirmar dónde está la passkey y con qué navegador funcionó WhatsApp Web. Investigar cómo obtener una firma WebAuthn desde un origen autorizado: una página de otro dominio no puede asumir acceso a la passkey de WhatsApp.
3. Diseñar un puente temporal local autenticado, con origen validado, expiración y un único desafío en curso. No registrar desafío, firma, QR, códigos o credenciales. El usuario autoriza la firma en el navegador; no se exporta la clave privada.
4. Si el protocolo solicita comparar códigos, mostrarlos solo al usuario y enviar confirmación solo tras su comparación explícita; expirar o cancelar ante discrepancia.
5. Usar almacenamiento temporal privado y permisos restrictivos. Probar origen no autorizado, respuesta a desafío equivocado, timeout, cancelación, desconexión y desafíos repetidos. No abrir puertos públicos.
6. Con el comerciante presente, vincular, verificar identidad, probar recepción y envío, cerrar y reiniciar para demostrar reconexión. Limpiar datos temporales y comunicar si quedó un dispositivo vinculado temporal.
7. Para producción, acordar con VPS cifrado y respaldo de sesión y clave, permisos y escritor único. La sesión Baileys no es automáticamente compatible.

## Entrega

Comunicar al frente 2 contrato, versión, SHA, identidad y semántica real de acuses; entregar pruebas y límites sin información sensible. Si el navegador no puede firmar con origen autorizado, reportar el bloqueo a los 45 minutos; no improvisar un puente en producción. `connected` por sí solo no demuestra identidad ni entrega.
