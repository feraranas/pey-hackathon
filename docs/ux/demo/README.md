# Animación del flujo

Animación del flujo planeado, generada con código a partir de las 17 maquetas de [`../screens.json`](../screens.json). Usa datos de ejemplo: personas, CLABE enmascarada y montos. No hay app construida ni cuentas conectadas, y no se envía ni se cobra nada.

El guion activa el **modo limpio** (`"clean": true` en `timeline.json`): las pantallas se dibujan sin las marcas de maqueta de las PNG de `../mockups/` (etiquetas «demo», notas de comisión ilustrativa, aviso de tarjeta). La espera de activación de pey (hasta 5 días hábiles, dicho en el chat) se muestra con una tarjeta «Días después».

### Modo limpio: [`../presentation.json`](../presentation.json)

- **Pantalla 1:** en vez de la lista de chats, Rafa se presenta al Agente de cobros («Soy Rafa, soy mecánico…»). La lista de chats se conserva como pantalla oculta `00`, que solo usa la animación.
- **Enlace y QR:** los enlaces de cobro muestran la URL de checkout de pey que eligió el equipo (`https://app.mipey.mx/checkout/payment-qr/01M6VX12YC0469HRZN7R5T1KWW`). La vista previa y el QR usan [`../assets/pey-qr-checkout.png`](../assets/pey-qr-checkout.png), una copia exacta de la imagen entregada (sin recolorear; solo se escala conservando la proporción).
- **Nota técnica:** ese enlace y ese QR son un recurso de presentación, compartido por los cobros de Ana y de Luis. **No** está verificado que correspondan a un cobro por comerciante con `bankAccountId` (ver [integraciones](../../integraciones.md#link-de-pago-hospedado-sin-paridad-fuera-del-mvp)), ni que el monto o el comercio coincidan con los de cada escena. En el diseño, cada cobro es un QR propio creado con `POST /codi/qr`.
- En modo limpio, un chat que no cabe deja sus mensajes más antiguos bajo el encabezado, como al hacer scroll, en lugar de fallar.

Video de 1920 × 1080, 30 fps, H.264 (yuv420p, faststart), de unos 2 min 41 s, sin audio. El MP4 no se versiona en el repositorio: se regenera con el script.

## Qué muestra

Todo desde el teléfono de Rafa, salvo el checkout y el QR (teléfono de Ana):

1. **Alta:** Rafa le escribe a «Agente de cobros» (número del producto, agente en blanco y Rafa en verde), da cuatro datos, responde «Sí, autorizo», vincula su WhatsApp y elige qué chats lee el agente. «Días después», pey activa la cuenta.
2. **Ana:** desglose de $1,200 en el chat de Rafa con Ana. Llega una notificación del agente con la propuesta, Rafa responde «Sí» y el cobro sale del WhatsApp de Rafa hacia Ana. Ana ve el checkout con estilo pey y el QR CoDi. Después, pey confirma el pago.
3. **Luis:** nota de voz (burbuja, sin audio) con $1,500. Rafa corrige a $1,600 con Luis; la propuesta anterior queda descartada sin enviarse. Llega una pregunta nueva, Rafa responde «Sí», sale el cobro y Luis manda un comprobante.
4. **Cierre:** el comprobante queda como reportado, pey confirma el pago y el resumen muestra $2,800.

No aparecen códigos de aprobación.

## Archivos

- [`timeline.json`](timeline.json): el guion. Cada paso (`send`, `recv`, `appear`, `banner`, `open`, `page`, `tap`, `caption`, `card`…) apunta a un mensaje de `screens.json` con `pantalla:índice`, así que el texto es el mismo que en las maquetas.
- [`animate_demo.py`](animate_demo.py): el motor. Reutiliza las funciones de [`../render_mockups.py`](../render_mockups.py): burbujas, encabezados, compositor, checkout y QR. Las animaciones (mensajes que entran deslizándose, «escribiendo…», texto que se escribe en el compositor, notificaciones, transiciones push/pop, toques) se dibujan con Pillow, y los fotogramas pasan a `ffmpeg` por una tubería.

## Regenerar

```bash
python3 -m venv /tmp/mockvenv && /tmp/mockvenv/bin/pip install pillow qrcode   # y ffmpeg con libx264
/tmp/mockvenv/bin/python docs/ux/demo/animate_demo.py --dry-run                 # línea de tiempo y duración
/tmp/mockvenv/bin/python docs/ux/demo/animate_demo.py --out /tmp/pey-demo.mp4   # video
/tmp/mockvenv/bin/python docs/ux/demo/animate_demo.py --frames /tmp/fotogramas --at 14 64 84 150
/tmp/mockvenv/bin/python docs/ux/demo/animate_demo.py --keyframes /tmp/secuencias      # PNG del teléfono por escena
/tmp/mockvenv/bin/python docs/ux/render_mockups.py --clean --screens-only --out /tmp/pantallas-limpias
```

- `--keyframes` guarda solo la pantalla del teléfono (786 × 1704, sin escenario ni textos) en cada paso con `"key"` de `timeline.json`, agrupada por escena (`01-alta/01-inicio.png`…), junto con un `manifest.json`.
- `render_mockups.py --clean` (o `MOCKUP_CLEAN=1`) dibuja las 17 pantallas en el mismo modo limpio. Sin esa opción, las maquetas de `../mockups/` no cambian.

Los tiempos de lectura se calculan según la longitud de cada mensaje y se pueden ajustar paso a paso con `hold` en `timeline.json`.
