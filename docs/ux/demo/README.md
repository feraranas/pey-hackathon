# Demo animada y guionizada

> **Demo guionizada con datos ficticios.** Es una animación del flujo planeado (17 maquetas de [`../screens.json`](../screens.json)), no una grabación de una sesión real. No hay app construida, no se conectó ninguna cuenta de WhatsApp ni de pey y no se envió ni cobró nada. El salto de la activación (hasta 5 días hábiles) se muestra como un salto de tiempo escenificado.

Video de 1920 × 1080, 30 fps, H.264 (yuv420p, faststart), de unos 2 min 40 s, sin audio. El MP4 no se versiona en el repositorio: se regenera con el script.

## Qué muestra

Todo desde el teléfono de Rafa, salvo el checkout y el QR (teléfono de Ana):

1. **Alta:** Rafa le escribe a «Agente de cobros» (número del producto, agente en blanco y Rafa en verde), da cuatro datos, responde «Sí, autorizo», vincula su WhatsApp y elige qué chats lee el agente. Luego hay un salto de tiempo escenificado y pey activa la cuenta.
2. **Ana:** desglose de $1,200 en el chat de Rafa con Ana. Llega una notificación del agente con la propuesta, Rafa responde «Sí» y el cobro sale del WhatsApp de Rafa hacia Ana. Ana ve el checkout con estilo pey y el QR CoDi de demo. Después, pey confirma el pago.
3. **Luis:** nota de voz representada (sin audio real) con $1,500. Rafa corrige a $1,600 con Luis; la propuesta anterior queda descartada sin enviarse. Llega una pregunta nueva, Rafa responde «Sí», sale el cobro y Luis manda un comprobante.
4. **Cierre:** el comprobante queda como reportado, pey confirma el pago y el resumen muestra $2,800.

No aparecen códigos de aprobación. Los enlaces (`cobro.example`), los QR (`example.invalid`), las personas y la CLABE son ficticios.

## Archivos

- [`timeline.json`](timeline.json): el guion. Cada paso (`send`, `recv`, `appear`, `banner`, `open`, `page`, `tap`, `caption`, `card`…) apunta a un mensaje de `screens.json` con `pantalla:índice`, así que el texto es el mismo que en las maquetas.
- [`animate_demo.py`](animate_demo.py): el motor. Reutiliza las funciones de [`../render_mockups.py`](../render_mockups.py): burbujas, encabezados, compositor, checkout y QR. Las animaciones (mensajes que entran deslizándose, «escribiendo…», texto que se escribe en el compositor, notificaciones, transiciones push/pop, toques) se dibujan con Pillow, y los fotogramas pasan a `ffmpeg` por una tubería.

## Regenerar

```bash
python3 -m venv /tmp/mockvenv && /tmp/mockvenv/bin/pip install pillow qrcode   # y ffmpeg con libx264
/tmp/mockvenv/bin/python docs/ux/demo/animate_demo.py --dry-run                 # línea de tiempo y duración
/tmp/mockvenv/bin/python docs/ux/demo/animate_demo.py --out /tmp/pey-demo.mp4   # video
/tmp/mockvenv/bin/python docs/ux/demo/animate_demo.py --frames /tmp/fotogramas --at 14 64 84 150
```

Los tiempos de lectura se calculan según la longitud de cada mensaje y se pueden ajustar paso a paso con `hold` en `timeline.json`.
