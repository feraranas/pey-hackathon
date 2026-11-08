# Diagramas

<!-- Archivo generado por scripts/render-diagrams.mjs. Edita los .mmd en docs/diagrams/ y vuelve a ejecutar el script. -->

Las fuentes canónicas están en [`docs/diagrams/`](diagrams/). Cada diagrama tiene su SVG y PNG renderizados con Mermaid CLI; los bloques `mermaid` de abajo se copian automáticamente de esas fuentes.

Regenerar: `PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome node scripts/render-diagrams.mjs` (ver [README](../README.md#diagramas)).

## Índice

1. [Arquitectura y flujo de datos](#arquitectura-y-flujo-de-datos)
2. [Flujo de extremo a extremo](#flujo-de-extremo-a-extremo)
3. [Estados: alta de la cuenta receptora](#estados-alta-de-la-cuenta-receptora)
4. [Estados: aprobación de un ChargeIntent](#estados-aprobación-de-un-chargeintent)
5. [Estados: creación del QR y entrega](#estados-creación-del-qr-y-entrega)
6. [Estados: pago por cobro y saldo de la orden](#estados-pago-por-cobro-y-saldo-de-la-orden)

## Arquitectura y flujo de datos

Componentes, datos y bordes de confirmación humana. Las líneas punteadas desde el chat del cliente son contexto: nunca otorgan autoridad.

![Arquitectura y flujo de datos](diagrams/arquitectura.svg)

Fuente: [`arquitectura.mmd`](diagrams/arquitectura.mmd) · [SVG](diagrams/arquitectura.svg) · [PNG](diagrams/arquitectura.png)

```mermaid
flowchart TB
  subgraph WA["WhatsApp (cuenta del comerciante)"]
    C["Chat con cliente<br/>(seleccionado en allowlist)"]
    S["Chat de control<br/>(chat consigo mismo)"]
  end
  Cli(["Cliente"]) <-->|"mensajes, audios,<br/>QR + desglose"| C
  M(["Comerciante"]) <-->|"conversa y cobra"| C
  M <-->|"SI CÓDIGO, onboarding,<br/>efectivo, consultas"| S

  subgraph APP["Servicio único Node.js + TypeScript (un proceso, un volumen)"]
    BA["Adaptador WhatsApp<br/>Baileys: sesión cifrada, JID propio,<br/>cursor, IDs preasignados"]
    EX["Extracción<br/>OpenAI: transcripción +<br/>salida estructurada Zod"]
    CO["Coordinador<br/>único escritor del dominio:<br/>órdenes, intents, aprobación,<br/>saldo, outbox"]
    PA["Adaptador pey<br/>REST + verificación<br/>Standard Webhooks"]
    HT["Fastify HTTPS<br/>POST /webhooks/pey"]
    DB[("SQLite WAL<br/>better-sqlite3")]
    W["Worker de outbox<br/>y temporizador"]
    PG["Página de cobro opcional<br/>GET /c/token, solo lectura:<br/>desglose + QR de pey"]
  end

  C -.->|"observación: contexto,<br/>nunca autoridad"| BA
  S -->|"comando con identidad<br/>propia verificada"| BA
  BA -->|"observación autenticada"| CO
  CO -->|"texto o audio a hechos"| EX
  EX -->|"CandidateFacts<br/>sin capacidad de enviar"| CO
  CO <-->|"transacciones cortas,<br/>sin red dentro"| DB
  W -->|"reclama trabajo durable"| DB
  W -->|"crear QR / registrar CLABE /<br/>consultar estado"| PA
  W -->|"prompt privado o QR al<br/>destinatario exacto"| BA
  BA -->|"envío"| S
  BA -->|"envío autorizado"| C
  PA <-->|"HTTPS Bearer"| PEY[("API pey<br/>api.pey.mx")]
  PEY -->|"webhook firmado"| HT
  HT -->|"firma válida: guardar<br/>y luego 2xx"| DB
  PEY -.->|"SPEI vía CoDi: el dinero<br/>no pasa por el servicio"| BANK[("Cuenta CLABE<br/>del comerciante")]
  Cli -.->|"paga con su app bancaria"| PEY
  Cli -.->|"abre el enlace (opcional)"| PG
  PG -->|"lee intent vigente"| DB

  classDef human fill:#fff3cd,stroke:#b58900,color:#222
  classDef ext fill:#e8f0fe,stroke:#1a73e8,color:#222
  classDef core fill:#e6f4ea,stroke:#188038,color:#222
  class M,Cli human
  class PEY,BANK ext
  class CO,DB core
```

## Flujo de extremo a extremo

Desde que llega un mensaje hasta el aviso de pago verificado. Aprobación, creación del QR, entrega y pago son pasos distintos.

![Flujo de extremo a extremo](diagrams/flujo-e2e.svg)

Fuente: [`flujo-e2e.mmd`](diagrams/flujo-e2e.mmd) · [SVG](diagrams/flujo-e2e.svg) · [PNG](diagrams/flujo-e2e.png)

```mermaid
flowchart TD
  A["Evento nuevo de Baileys"] --> B{"¿Chat en allowlist o chat<br/>de control, y evento no<br/>procesado antes del cursor?"}
  B -- No --> Z["Ignorar sin guardar contenido"]
  B -- Sí --> C{"¿Chat de control, fromMe,<br/>JID propio y ID que no<br/>es eco del bot?"}
  C -- "Sí: comando" --> J{"¿El sí se liga a una sola<br/>pregunta abierta y vigente?<br/>(estado, no el modelo)"}
  C -- "No: contexto de cliente<br/>o del comerciante" --> D["Extraer hechos con evidencia<br/>texto primero, audio opcional"]
  D --> E{"¿Trabajo y monto acordados<br/>sin ambigüedad?"}
  E -- No --> F["Esperar más contexto o pedir<br/>aclaración privada"]
  E -- Sí --> G["Crear o versionar WorkOrder<br/>y ChargeIntent con monto fijo:<br/>anticipo, saldo o total"]
  G --> H{"¿Cuenta receptora propia<br/>en ACTIVE?"}
  H -- No --> H2["Avisar en privado: cuenta<br/>pendiente; no ofrecer cobro real"]
  H -- Sí --> I["Pregunta privada natural:<br/>¿Le envío a Ana $1,200?"]
  I --> J
  J -- "No: 0 o 2+ abiertas,<br/>sustituida o vencida" --> F
  J -- Sí --> K{"¿Mismo digest, vigente,<br/>cuenta ACTIVE del mismo<br/>comerciante?"}
  K -- No --> L["Rechazar; proponer nueva versión"]
  K -- Sí --> M["Una transacción SQL: aprobación +<br/>trabajo de creación de QR"]
  M --> N["Worker: POST /codi/qr con amount fijo,<br/>bankAccountId, numRef, metadata, expiration"]
  N --> O{"¿Resultado?"}
  O -- "201" --> R["Guardar IDC y qrString;<br/>encolar entrega al JID exacto"]
  O -- "4xx definitivo" --> Q["Fallo conocido: avisar;<br/>no enviar nada"]
  O -- "timeout / 5xx / crash" --> P["Creación incierta: sin qrString<br/>no hay nada que enviar;<br/>nuevo intento solo con nuevo sí"]
  R --> S["Preasignar ID de mensaje, persistir,<br/>enviar imagen QR + desglose"]
  S --> T{"¿Eco o ack con ese ID?"}
  T -- Sí --> U["Entregado; no significa pagado"]
  T -- "Incierto" --> P2["Entrega incierta: revisión;<br/>nunca reenviar a ciegas"]
  WH["POST /webhooks/pey"] --> WV{"¿Firma Standard Webhooks<br/>válida?"}
  WV -- No --> WR["Rechazar 4xx; no guardar cuerpo"]
  WV -- Sí --> WS["Guardar crudo por webhook-id<br/>y responder 2xx"]
  WS --> WT["GET /transaction/transactionId:<br/>PAID, MXN, base, payableId"]
  WT --> WX{"¿IDC conocido, receptor,<br/>monto y estado coinciden?"}
  WX -- No --> WQ["Cuarentena o revisión;<br/>nunca marcar pagado"]
  WX -- Sí --> WP["Aplicar una vez por transactionId<br/>al ChargeIntent y al saldo de la orden"]
  WP --> WN["Aviso privado: recibiste $X por<br/>este cobro; saldo verificado y efectivo<br/>registrado por separado"]
  U -.-> WH
  P2 -.->|"el pago puede llegar igual"| WH
```

## Estados: alta de la cuenta receptora

Registro de la CLABE en pey. Solo `ACTIVE` habilita cobros reales; la activación puede tardar hasta cinco días hábiles.

![Estados: alta de la cuenta receptora](diagrams/estado-onboarding.svg)

Fuente: [`estado-onboarding.mmd`](diagrams/estado-onboarding.mmd) · [SVG](diagrams/estado-onboarding.svg) · [PNG](diagrams/estado-onboarding.png)

```mermaid
stateDiagram-v2
  direction TB
  [*] --> SinCuenta
  SinCuenta --> CapturandoDatos: el comerciante inicia en el chat de control
  CapturandoDatos --> ConfirmandoDatos: alias, nombre legal, CLABE de 18 dígitos y entity PERSON o BUSINESS
  ConfirmandoDatos --> CapturandoDatos: corrige un dato
  ConfirmandoDatos --> Registrando: consentimiento explícito versionado
  Registrando --> PENDING: 200 con codiStatus PENDING
  Registrando --> RechazoConocido: 400 INVALID_CLABE u otro definitivo
  Registrando --> RegistroIncierto: timeout, 5xx o caída
  RegistroIncierto --> RevisionManual: no existe búsqueda por CLABE documentada
  RevisionManual --> ConfirmandoDatos: humano decide reintentar
  RechazoConocido --> CapturandoDatos: corregir
  PENDING --> PROCESSING: GET /bank-account/id
  PENDING --> ACTIVE: webhook bank.account.updated o GET
  PROCESSING --> ACTIVE: webhook bank.account.updated o GET
  PENDING --> ERROR: GET con errorMessage
  PROCESSING --> ERROR: GET con errorMessage
  ERROR --> CapturandoDatos: corregir y volver a consentir
  ACTIVE --> [*]
  note right of PENDING
    Mensaje: la activación puede tardar
    hasta cinco días hábiles, te aviso
    cuando pey la confirme.
    Se pueden preparar órdenes,
    no se crean cobros reales.
  end note
  note right of ERROR
    ERROR no dispara webhook:
    se detecta solo con GET periódico.
  end note
```

## Estados: aprobación de un ChargeIntent

Cada cobro (anticipo, saldo o total) se aprueba por separado y queda ligado a un digest inmutable.

![Estados: aprobación de un ChargeIntent](diagrams/estado-aprobacion.svg)

Fuente: [`estado-aprobacion.mmd`](diagrams/estado-aprobacion.mmd) · [SVG](diagrams/estado-aprobacion.svg) · [PNG](diagrams/estado-aprobacion.png)

```mermaid
stateDiagram-v2
  direction TB
  [*] --> Detectado
  Detectado --> Aclarando: monto, cliente o partidas ambiguos
  Aclarando --> Detectado: el comerciante aclara en privado
  Detectado --> EsperandoCuenta: receptor aún no ACTIVE
  EsperandoCuenta --> Propuesto: receptor pasa a ACTIVE y sigue vigente
  Detectado --> Propuesto: pregunta privada natural, snapshot con digest
  Propuesto --> Aprobado: sí del dueño ligado a esta única pregunta abierta, digest igual, vigente
  Propuesto --> Rechazado: NO del comerciante
  Propuesto --> Expirado: vence la oferta local
  Propuesto --> Sustituido: cambia monto, partidas, cliente o receptor
  Aprobado --> Sustituido: cambio antes de iniciar la creación remota
  Aprobado --> [*]: entrega a la máquina de creación
  Rechazado --> [*]
  Expirado --> [*]
  Sustituido --> [*]: nueva versión con pregunta nueva
  note right of Propuesto
    Varios ChargeIntent pueden estar
    abiertos a la vez para el mismo
    cliente, por ejemplo anticipo y saldo.
    Con 2 o más preguntas abiertas plausibles,
    un sí simple pide aclaración.
    Texto de cliente nunca aprueba.
  end note
```

## Estados: creación del QR y entrega

Dos máquinas separadas. Los resultados inciertos van a revisión; no hay reintentos ciegos.

![Estados: creación del QR y entrega](diagrams/estado-creacion-entrega.svg)

Fuente: [`estado-creacion-entrega.mmd`](diagrams/estado-creacion-entrega.mmd) · [SVG](diagrams/estado-creacion-entrega.svg) · [PNG](diagrams/estado-creacion-entrega.png)

```mermaid
stateDiagram-v2
  direction TB
  state "Creación del QR en pey" as Creacion {
    [*] --> EnCola
    EnCola --> EnVuelo: worker marca intento antes del HTTP
    EnVuelo --> Creado: 201 con IDC y qrString
    EnVuelo --> FalloConocido: 400 definitivo
    EnVuelo --> CreacionIncierta: timeout, 5xx o caída
    CreacionIncierta --> RequiereNuevoSi: sin qrString no se envía nada
    FalloConocido --> [*]
    RequiereNuevoSi --> [*]
  }
  state "Entrega por WhatsApp" as Entrega {
    [*] --> Pendiente
    Pendiente --> IdReservado: ID de mensaje preasignado y persistido
    IdReservado --> Enviando: destinatario igual al de la aprobación
    Enviando --> Entregado: eco o ack con el ID reservado
    Enviando --> Pendiente: error claro antes de transmitir
    Enviando --> EntregaIncierta: sin ack tras reconexión
    EntregaIncierta --> Entregado: aparece eco con el ID reservado
    EntregaIncierta --> RevisionManual: vence la ventana de espera
    RevisionManual --> Pendiente: el comerciante autoriza reenviar
    Entregado --> [*]
  }
  Creado --> Entrega: encola entrega del mismo intent
  note right of Entrega
    Entregado no significa pagado.
    Un pago verificado puede llegar
    aunque la entrega siga incierta.
  end note
```

## Estados: pago por cobro y saldo de la orden

Un QR tiene monto fijo; el saldo se calcula a nivel WorkOrder sumando cobros verificados y, aparte, efectivo registrado.

![Estados: pago por cobro y saldo de la orden](diagrams/estado-pago-orden.svg)

Fuente: [`estado-pago-orden.mmd`](diagrams/estado-pago-orden.mmd) · [SVG](diagrams/estado-pago-orden.svg) · [PNG](diagrams/estado-pago-orden.png)

```mermaid
stateDiagram-v2
  direction TB
  state "Cobro individual: QR de monto fijo" as Cobro {
    [*] --> SinPago
    SinPago --> Pagado: transacción PAID verificada con base igual al monto
    SinPago --> MontoDistinto: base distinta al monto del QR
    Pagado --> PagoRepetido: otra transacción PAID del mismo IDC
    SinPago --> PagoTardio: pago en un intent sustituido o expirado
    MontoDistinto --> Revision
    PagoRepetido --> Revision
    PagoTardio --> Revision
    Pagado --> [*]
  }
  state "Saldo de la WorkOrder" as Orden {
    [*] --> TotalDesconocido
    TotalDesconocido --> TotalDesconocido: cobro verificado, se muestra solo lo cobrado
    TotalDesconocido --> PorCobrar: el comerciante fija el total
    PorCobrar --> PagoParcial: verificados más efectivo menor al total
    PagoParcial --> PagoParcial: otro cobro verificado o efectivo registrado
    PorCobrar --> Liquidada: verificados más efectivo igual al total
    PagoParcial --> Liquidada: verificados más efectivo igual al total
    PagoParcial --> Sobrepago: suma mayor al total
    Liquidada --> Sobrepago: entra dinero adicional
    Liquidada --> PagoParcial: nueva versión con total mayor
    Sobrepago --> RevisionSaldo: decisión humana
  }
  Pagado --> Orden: suma una vez por transactionId
  note right of Orden
    Fuentes separadas en cada aviso:
    pago verificado por pey,
    efectivo registrado por el comerciante,
    comprobante reportado sin verificar.
    Comprobantes no cambian el saldo.
    Evento repetido por webhook-id no suma.
  end note
```
