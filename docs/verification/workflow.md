# Ejecución autónoma del MVP

- [x] Leer principios pstack y diseño inicial 7f34bab y actualización remota efab8b9.
- [x] Frame. Delimitar alcance, bloqueos y plazo de tres horas.
- [x] Design the workflow. Contratos compartidos, archivos de propiedad exclusiva, tres carriles Terra.
- [x] Run the loop. Implementar y comprobar núcleo, pey y WhatsApp/extracción.
- [x] Keep the audit trail. Registrar decisiones y evidencia.
- [x] Verify and hand back. Ejecutar matriz, demo, arranque y revisión independiente.

## Criterio de entrega

Aplicación TypeScript ejecutable con persistencia SQLite, aprobaciones ligadas, outbox, manejo de incertidumbre, onboarding con consentimiento, adaptadores pey/Baileys/OpenAI, extracción de texto, webhooks firmados y demo simulada reproducible. Pruebas de invariantes y errores, compilación y documentación de ejecución. No se afirma integración real sin evidencia. Audio opcional posterior al flujo de texto.

## Distribución

El coordinador mantiene contratos, dependencias, arranque, demo y revisión final. Terra núcleo posee src/coordinator.ts, src/store.ts y test/core.test.ts. Terra pey posee src/pey.ts y test/pey.test.ts. Terra WhatsApp/extracción posee src/whatsapp.ts, src/extraction.ts y sus pruebas. Ningún hijo modifica contratos ni dependencias compartidas. La integración autoritativa pertenece al coordinador.

## Tiempo

Inicio aproximado 2026-11-08 10:15 América/Ciudad de México. Límite 13:15. Primera etapa análisis y contratos; segunda implementación paralela; tercera integración y corrección; última validación y entrega. La estimación previa de 6 h 40 min para una persona no garantiza terminar conexiones externas en tres horas.
