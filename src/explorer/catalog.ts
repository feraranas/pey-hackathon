// Catalogue of pey's public API as documented at https://docs.pey.mx
// (OpenAPI reviewed 2026-11-07). The explorer proxy only ever calls entries
// listed here, so the browser can never reach an arbitrary upstream path.

export type StepId = "app" | "proxy" | "pey" | "banco" | "webhook" | "tuapp";
export type Risk = "lectura" | "escritura" | "dinero";
export type Param = {
  name: string;
  in: "path" | "query";
  label: string;
  required: boolean;
  /** Key of the context the UI fills from earlier responses. */
  ctx?:
    "bankAccountId" | "paymentLinkId" | "transactionId" | "qrId" | "nextToken";
  hint?: string;
};
export type Endpoint = {
  id: string;
  method: "GET" | "POST";
  path: string;
  title: string;
  description: string;
  group: "Cuentas" | "Cobros" | "Links de pago" | "Transacciones";
  risk: Risk;
  warning?: string;
  params: Param[];
  body?: Record<string, unknown>;
  response: unknown;
  /** Steps of the data journey this call lights up. */
  flow: StepId[];
  story: string[];
  /** What the sandbox lets you do next to complete the journey. */
  sandboxNext?: { action: SandboxAction; label: string; idFrom: string };
};
export type SandboxAction =
  "activate-account" | "pay-qr" | "pay-push" | "pay-link";

export type WebhookEvent = {
  type:
    | "bank.account.updated"
    | "codi.pn.payment_received"
    | "codi.qr.payment_received"
    | "payment_link.status_updated";
  title: string;
  description: string;
  when: string;
  payload: Record<string, unknown>;
};

const txSample = {
  id: "01HXYZTXN1234567890ABCDE00",
  status: "PAID",
  amount: 100,
  amountBreakdown: { base: 100, tip: 0, fee: 2.5 },
  currency: "MXN",
  paymentMethod: "CODI",
  payableType: "API_CODI_QR",
  payableId: "AB12CD34EF",
  dateCreated: 1704067200,
  datePaid: 1704067260,
  metadata: {
    clabe: "000000000000000000",
    bankCode: 40012,
    trackingKey: "0192191042",
  },
};
const listResponse = {
  items: [txSample],
  nextToken: "eyJQSyI6ICJUWE4jMDFIWFla…",
};
const nextToken: Param = {
  name: "nextToken",
  in: "query",
  label: "nextToken (página siguiente)",
  required: false,
  ctx: "nextToken",
  hint: "Déjalo vacío para la primera página.",
};

export const endpoints: Endpoint[] = [
  {
    id: "bank-account-get",
    method: "GET",
    path: "/bank-account/{id}",
    title: "Consultar cuenta",
    description:
      "Lee una cuenta registrada y su estado de activación para CoDi (PENDING, PROCESSING, ACTIVE o ERROR).",
    group: "Cuentas",
    risk: "lectura",
    params: [
      {
        name: "id",
        in: "path",
        label: "ID de la cuenta",
        required: true,
        ctx: "bankAccountId",
      },
    ],
    response: {
      id: "01JBAVWE4NS5TGXHWGMX3KH23Q",
      alias: "BBVA",
      name: "Pagos con Pey S.A. de C.V.",
      clabe: "012180001234567899",
      entity: "BUSINESS",
      taxId: "XAXX010101000",
      codiStatus: "ACTIVE",
      dateCreated: 1760000000,
    },
    flow: ["app", "proxy", "pey"],
    story: [
      "Tu navegador pide la cuenta al proxy; la clave nunca sale del servidor.",
      "El proxy añade Authorization: Bearer y llama a api.pey.mx.",
      "pey responde con el estado. Aquí la CLABE se muestra enmascarada.",
    ],
  },
  {
    id: "bank-account-register",
    method: "POST",
    path: "/bank-account",
    title: "Registrar cuenta",
    description:
      "Da de alta una CLABE bajo tu API key para recibir pagos CoDi. Queda PENDING; la activación tarda hasta 5 días hábiles.",
    group: "Cuentas",
    risk: "dinero",
    warning:
      "Registra una cuenta bancaria real ante Banxico. No se puede borrar desde la API.",
    params: [],
    body: {
      alias: "Prueba explorador",
      name: "Nombre legal del titular",
      clabe: "012180001234567899",
      entity: "PERSON",
    },
    response: { id: "01JBAVWE4NS5TGXHWGMX3KH23Q", codiStatus: "PENDING" },
    flow: ["app", "proxy", "pey", "banco", "webhook", "tuapp"],
    story: [
      "El proxy envía alias, nombre legal, CLABE y tipo de persona.",
      "pey valida el dígito verificador y registra la cuenta en CoDi (Banxico).",
      "Responde de inmediato con codiStatus PENDING y el id de la cuenta.",
      "Cuando el banco la activa (hasta 5 días hábiles) pey dispara bank.account.updated a tu webhook.",
    ],
    sandboxNext: {
      action: "activate-account",
      label: "Simular activación del banco",
      idFrom: "id",
    },
  },
  {
    id: "qr-create",
    method: "POST",
    path: "/codi/qr",
    title: "Crear QR CoDi",
    description:
      "Genera un QR CoDi para cobrar. Con monto 0 el pagador elige cuánto pagar; puede devolver la imagen en base64.",
    group: "Cobros",
    risk: "dinero",
    warning:
      "Crea un cobro real: quien escanee el QR puede pagar a tu cuenta. Usa montos mínimos.",
    params: [],
    body: {
      amount: 1,
      concept: "Prueba explorador",
      expiration: 600,
      numRef: "1",
      generateImage: true,
    },
    response: {
      id: "AB12CD34EF",
      qrString: '{"TYP":1,"v":"01","ic":0,"IDC":"AB12CD34EF"}',
      qrImage: "iVBORw0KGgoAAAANSUhEUgAAAooAAAKKAQAAAACq/MUf…",
    },
    flow: ["app", "proxy", "pey", "banco", "webhook", "tuapp"],
    story: [
      "El proxy pide el QR con monto, concepto, vigencia y referencia numérica.",
      "pey lo da de alta en Banxico y devuelve el id (IDC) y la cadena del QR.",
      "El cliente lo escanea con su app bancaria y paga por CoDi.",
      "pey confirma el pago con codi.qr.payment_received; solo ese webhook firmado cuenta como pagado.",
    ],
    sandboxNext: {
      action: "pay-qr",
      label: "Simular que el cliente paga",
      idFrom: "id",
    },
  },
  {
    id: "push-create",
    method: "POST",
    path: "/codi/pn",
    title: "Solicitar pago (push CoDi)",
    description:
      "Envía una solicitud de pago CoDi directo al teléfono del pagador (10 dígitos), sin que escanee nada.",
    group: "Cobros",
    risk: "dinero",
    warning:
      "Manda una notificación real al teléfono indicado. En producción se rechaza el número de ejemplo: usa uno tuyo.",
    params: [],
    body: {
      amount: 1,
      phoneNumber: "5512345678",
      concept: "Prueba explorador",
      expiration: 360,
      numRef: "1",
    },
    response: {
      transactionId: "01J5KXYZ1234567890ABCD",
      codiId: "12345678901234567890",
    },
    flow: ["app", "proxy", "pey", "banco", "webhook", "tuapp"],
    story: [
      "El proxy manda monto y teléfono del pagador.",
      "pey pide a Banxico/CoDi que notifique al banco del pagador.",
      "El pagador aprueba en su app bancaria.",
      "pey dispara codi.pn.payment_received con la transacción pagada.",
    ],
    sandboxNext: {
      action: "pay-push",
      label: "Simular que el pagador aprueba",
      idFrom: "transactionId",
    },
  },
  {
    id: "link-create",
    method: "POST",
    path: "/payment-link/create",
    title: "Crear link de pago",
    description:
      "Crea un link compartible con propina opcional y URLs de regreso (HTTPS) para éxito y cancelación.",
    group: "Links de pago",
    risk: "dinero",
    warning:
      "Crea un link de cobro real que cualquiera con la URL puede pagar (CoDi o tarjeta).",
    params: [],
    body: {
      amount: 1,
      successUrl: "https://example.com/success",
      backUrl: "https://example.com/cancel",
      hasTip: false,
      clientReferenceId: "explorador-1",
    },
    response: {
      id: "01HXYZ1234567890ABCDEFGH",
      url: "https://app.mipey.mx/payment-link/01HXYZ1234567890ABCDEFGH",
    },
    flow: ["app", "proxy", "pey", "webhook", "tuapp"],
    story: [
      "El proxy envía monto, URLs y tu referencia.",
      "pey crea el link y devuelve su id y la URL pública.",
      "El cliente abre la URL y paga; pey lo redirige a successUrl.",
      "pey avisa cada cambio de estado con payment_link.status_updated.",
    ],
    sandboxNext: {
      action: "pay-link",
      label: "Simular que el cliente paga el link",
      idFrom: "id",
    },
  },
  {
    id: "link-update",
    method: "POST",
    path: "/payment-link/update",
    title: "Cambiar monto del link",
    description:
      "Modifica únicamente el monto de un link, mientras siga en estado pending.",
    group: "Links de pago",
    risk: "dinero",
    warning: "Cambia el cobro de un link real que aún no se paga.",
    params: [],
    body: { paymentLinkId: "01HXYZ1234567890ABCDEFGH", amount: 2 },
    response: { id: "01HXYZ1234567890ABCDEFGH", amount: 2 },
    flow: ["app", "proxy", "pey"],
    story: [
      "El proxy envía el id del link y el nuevo monto (no admite otros campos).",
      "pey comprueba que sea tuyo y siga pending.",
      "Responde con el monto vigente; si ya no está pending, 409.",
    ],
  },
  {
    id: "link-get",
    method: "GET",
    path: "/payment-link/{id}",
    title: "Consultar link de pago",
    description:
      "Lee monto, estado (pending, processing, paid), métodos de pago y transacciones de un link tuyo.",
    group: "Links de pago",
    risk: "lectura",
    params: [
      {
        name: "id",
        in: "path",
        label: "ID del link",
        required: true,
        ctx: "paymentLinkId",
      },
    ],
    response: {
      id: "01KRFJJYPMP24MF3EFX1043RNC",
      amount: 100,
      status: "paid",
      successUrl: "https://pey.mx/",
      backUrl: "https://docs.pey.mx/cancel",
      hasTip: true,
      paymentMethods: ["CODI", "CARD"],
      dateCreated: 1778639272,
      clientReferenceId: "order-12345",
      transactions: [
        {
          transactionId: "01KRFJKXPJ543PN80P9BJQKGFX",
          paymentMethod: "CARD",
          datePaid: 1778639309,
          amount: 118.5,
        },
      ],
    },
    flow: ["app", "proxy", "pey"],
    story: [
      "El proxy consulta el link con tu API key.",
      "pey solo responde por links creados con esa clave.",
      "Verás el estado y las transacciones que lo liquidaron.",
    ],
  },
  {
    id: "transaction-get",
    method: "GET",
    path: "/transaction/{id}",
    title: "Consultar transacción",
    description:
      "Lee una transacción concreta. Su ID es distinto al ID del QR o del link que la originó.",
    group: "Transacciones",
    risk: "lectura",
    params: [
      {
        name: "id",
        in: "path",
        label: "ID de la transacción",
        required: true,
        ctx: "transactionId",
      },
    ],
    response: txSample,
    flow: ["app", "proxy", "pey"],
    story: [
      "El proxy pide la transacción por su id.",
      "pey responde estado, montos (base, propina, comisión) y método de pago.",
      "Es la verificación autoritativa de que un cobro está PAID.",
    ],
  },
  {
    id: "transactions-api-key",
    method: "GET",
    path: "/transaction/api-key",
    title: "Transacciones de la API key",
    description:
      "Lista todo lo recibido con tu clave, 80 por página. Usa nextToken para avanzar.",
    group: "Transacciones",
    risk: "lectura",
    params: [nextToken],
    response: listResponse,
    flow: ["app", "proxy", "pey"],
    story: [
      "pey identifica la clave por el encabezado Authorization; no hace falta ningún id.",
      "Devuelve hasta 80 transacciones y un nextToken si hay más.",
      "Pasa ese nextToken en la siguiente llamada para la página siguiente.",
    ],
  },
  {
    id: "transactions-bank-account",
    method: "GET",
    path: "/transaction/bank-account/{id}",
    title: "Transacciones de una cuenta",
    description:
      "Lista los pagos CoDi recibidos por una cuenta registrada, 80 por página, del más reciente al más antiguo.",
    group: "Transacciones",
    risk: "lectura",
    params: [
      {
        name: "id",
        in: "path",
        label: "ID de la cuenta",
        required: true,
        ctx: "bankAccountId",
      },
      nextToken,
    ],
    response: listResponse,
    flow: ["app", "proxy", "pey"],
    story: [
      "El proxy filtra por la cuenta registrada.",
      "pey devuelve solo pagos que llegaron a esa CLABE.",
      "Paginación con nextToken, igual que el listado por clave.",
    ],
  },
  {
    id: "transactions-qr",
    method: "GET",
    path: "/transaction/codi/qr/{id}",
    title: "Pagos de un QR",
    description:
      "Lista los pagos que recibió un QR CoDi concreto, 20 por página.",
    group: "Transacciones",
    risk: "lectura",
    params: [
      {
        name: "id",
        in: "path",
        label: "ID del QR (IDC)",
        required: true,
        ctx: "qrId",
      },
      nextToken,
    ],
    response: listResponse,
    flow: ["app", "proxy", "pey"],
    story: [
      "El proxy consulta por el id del QR (el IDC que devolvió POST /codi/qr).",
      "pey lista cada pago recibido por ese QR (un QR con monto 0 puede recibir varios).",
      "Paginación de 20 en 20 con nextToken.",
    ],
  },
];

const apiKeyId = "01M3QMMR6X9CBVDY1SF3G8QWNW";
export const webhookEvents: WebhookEvent[] = [
  {
    type: "bank.account.updated",
    title: "Cuenta activada",
    description:
      "pey avisa cuando una cuenta registrada pasa a ACTIVE y ya puede recibir pagos CoDi. Los otros estados no generan evento.",
    when: "Solo en la transición a ACTIVE.",
    payload: {
      type: "bank.account.updated",
      bankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23Q",
      name: "Empresa SA de CV",
      ownerType: "API_KEY",
      ownerId: apiKeyId,
      taxId: "XAXX010101000",
      codiStatus: "ACTIVE",
      clabe: "012180001234567899",
      entity: "BUSINESS",
    },
  },
  {
    type: "codi.pn.payment_received",
    title: "Pago por push recibido",
    description:
      "Se completó un pago pedido con notificación push CoDi: el pagador aprobó en su banco.",
    when: "Cuando el pagador aprueba la solicitud.",
    payload: {
      type: "codi.pn.payment_received",
      amount: 1,
      apiKeyId,
      bankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23Q",
      concept: "Prueba explorador",
      datePaid: 1790724758,
      metadata: {
        clabe: "000000000000000000",
        bankCode: 40012,
        accountType: 40,
        trackingKey: "0192191042",
      },
      numRef: "1",
      transactionId: "01M3QR5E7XHXMNZDEPFH3JAWS0",
    },
  },
  {
    type: "codi.qr.payment_received",
    title: "Pago de QR recibido",
    description:
      "Alguien pagó un QR CoDi creado por la API. Es la única señal que debe marcar un cobro como pagado.",
    when: "Cuando el pago del QR se liquida.",
    payload: {
      type: "codi.qr.payment_received",
      amount: 1,
      apiKeyId,
      bankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23Q",
      codiQrId: "35a13c183a",
      concept: "Prueba explorador",
      datePaid: 1790724818,
      metadata: {
        clabe: "000000000000000000",
        bankCode: 40012,
        accountType: 40,
        trackingKey: "0192191042",
      },
      numRef: "1",
      transactionId: "01M3QR8H0RH0XBCKYYD242YXNV",
    },
  },
  {
    type: "payment_link.status_updated",
    title: "Link de pago actualizado",
    description:
      "Cambia el estado de un link: pending, processing o paid. Incluye las transacciones que lo liquidaron.",
    when: "En cada cambio de estado del link.",
    payload: {
      type: "payment_link.status_updated",
      apiKeyId,
      paymentLinkId: "01HXYZ1234567890ABCDEFGH",
      status: "paid",
      clientReferenceId: "explorador-1",
      transactions: [
        {
          transactionId: "01HXYZTXN1234567890ABCDE",
          paymentMethod: "CODI",
          datePaid: 1715000000,
          amount: 1,
          amountBreakdown: { base: 1, tip: 0, fee: 0 },
          applicationFee: 0,
        },
      ],
    },
  },
];

export const endpointById = new Map(endpoints.map((e) => [e.id, e]));
