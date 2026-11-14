"use strict";

const NODES = [
  { id: "app", ico: "🖥️", name: "Tu navegador", sub: "esta página" },
  {
    id: "proxy",
    ico: "🛡️",
    name: "Proxy del explorador",
    sub: "guarda la API key",
  },
  { id: "pey", ico: "🔌", name: "api.pey.mx", sub: "Bearer <clave>" },
  { id: "banco", ico: "🏦", name: "Banco · CoDi", sub: "Banxico / SPEI" },
  {
    id: "webhook",
    ico: "✉️",
    name: "Webhook firmado",
    sub: "Standard Webhooks",
    hook: true,
  },
  { id: "tuapp", ico: "🧾", name: "Tu app", sub: "/webhooks/pey", hook: true },
];
const STEP_LABEL = Object.fromEntries(NODES.map((n) => [n.id, n.name]));
const state = {
  mode: "sandbox",
  boot: null,
  ctx: { sandbox: {}, production: {} },
  results: {},
};
const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (
      k === "open" ||
      k === "disabled" ||
      k === "checked" ||
      k === "hidden"
    )
      el[k] = !!v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity))
    if (kid != null && kid !== false)
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-explorer-request": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}

// ---------- JSON rendering (textContent only: nothing is trusted as HTML) ----------
function jsonNode(value, indent = 0) {
  const pad = "  ".repeat(indent);
  const frag = document.createDocumentFragment();
  if (value === null || typeof value !== "object") {
    const cls =
      typeof value === "string"
        ? "j-s"
        : typeof value === "number"
          ? "j-n"
          : "j-b";
    frag.append(h("span", { class: cls }, JSON.stringify(value)));
    return frag;
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
  if (!entries.length) {
    frag.append(isArr ? "[]" : "{}");
    return frag;
  }
  frag.append(isArr ? "[\n" : "{\n");
  entries.forEach(([k, v], i) => {
    frag.append(pad + "  ");
    if (!isArr)
      frag.append(h("span", { class: "j-k" }, JSON.stringify(k)), ": ");
    frag.append(jsonNode(v, indent + 1));
    frag.append(i < entries.length - 1 ? ",\n" : "\n");
  });
  frag.append(pad + (isArr ? "]" : "}"));
  return frag;
}
const jsonPre = (value) =>
  h("pre", {}, typeof value === "string" ? value : jsonNode(value));

// ---------- diagram ----------
function buildFlow() {
  const track = $("flow");
  track.replaceChildren();
  NODES.forEach((n, i) => {
    if (i) track.append(h("div", { class: "link", "data-link": n.id }));
    track.append(
      h(
        "div",
        { class: `node${n.hook ? " hook" : ""}`, "data-step": n.id },
        h("div", { class: "ico" }, n.ico),
        h("b", {}, n.name),
        h("span", {}, n.sub),
      ),
    );
  });
}
const nodeEl = (id) => document.querySelector(`.node[data-step="${id}"]`);
const linkEl = (id) => document.querySelector(`.link[data-link="${id}"]`);
const miniEls = (card, id) =>
  card.querySelectorAll(`.mini i[data-step="${id}"]`);
function setStep(card, id, cls) {
  for (const el of [nodeEl(id), ...miniEls(card, id)]) {
    if (!el) continue;
    el.classList.remove("on", "done", "err");
    if (cls) el.classList.add(cls);
  }
  const link = linkEl(id);
  if (link) link.classList.toggle("on", cls === "on");
}
function clearFlow(card) {
  for (const n of NODES) setStep(card, n.id, null);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function animateCall(card, ep, work) {
  const steps = ep.flow.filter((s) => s !== "webhook" && s !== "tuapp");
  card.classList.add("running");
  clearFlow(card);
  const story = card.querySelector("ol.story");
  let finished = false;
  const done = work().finally(() => {
    finished = true;
  });
  for (let i = 0; i < steps.length; i++) {
    if (finished && i >= steps.length - 1) break;
    setStep(card, steps[i], "on");
    $("flow-caption").textContent = ep.story[i] ?? "";
    story
      ?.querySelectorAll("li")
      .forEach((li, j) => li.classList.toggle("on", j === i));
    if (i > 0) setStep(card, steps[i - 1], "done");
    await sleep(420);
  }
  const result = await done;
  const failed = !result || result.failed;
  for (const s of steps)
    setStep(card, s, failed && s === steps[steps.length - 1] ? "err" : "done");
  $("flow-caption").textContent = failed
    ? "La llamada falló: mira el estado y el cuerpo de la respuesta en la tarjeta."
    : ep.flow.includes("webhook")
      ? "pey respondió. El resultado final llegará después como webhook firmado (en sandbox, pulsa «Simular…»)."
      : "pey respondió y el dato volvió por el mismo camino.";
  card.classList.remove("running");
  story?.querySelectorAll("li").forEach((li) => li.classList.remove("on"));
  setTimeout(() => clearFlow(card), 6000);
  return result;
}

// ---------- context chaining: ids found in responses prefill later cards ----------
function learn(ep, body) {
  const c = state.ctx[state.mode];
  const set = (k, v) => {
    if (typeof v === "string" && v) c[k] = v;
  };
  if (!body || typeof body !== "object") return;
  if (ep.id === "bank-account-register") set("bankAccountId", body.id);
  if (ep.id === "qr-create") set("qrId", body.id);
  if (ep.id === "push-create") set("transactionId", body.transactionId);
  if (ep.id === "link-create") set("paymentLinkId", body.id);
  if (ep.id === "transaction-get") {
    if (body.payableType === "API_CODI_QR") set("qrId", body.payableId);
    if (body.payableType === "PAYMENT_LINK")
      set("paymentLinkId", body.payableId);
  }
  if (Array.isArray(body.items)) {
    const first = body.items[0];
    if (first) {
      set("transactionId", first.id);
      if (first.payableType === "API_CODI_QR") set("qrId", first.payableId);
      if (first.payableType === "PAYMENT_LINK")
        set("paymentLinkId", first.payableId);
    }
    c.nextToken = typeof body.nextToken === "string" ? body.nextToken : "";
  }
  refreshInputs();
}
function refreshInputs() {
  document.querySelectorAll("input[data-ctx]").forEach((input) => {
    const v = state.ctx[state.mode][input.dataset.ctx] ?? "";
    if (input.dataset.touched !== "1" || !input.value) {
      input.value = v;
      input.dataset.touched = "";
    }
  });
}

// ---------- endpoint cards ----------
function requestSample(ep) {
  const path = ep.path.replace(/\{id\}/g, "ID");
  const lines = [
    `${ep.method} https://api.pey.mx${path}`,
    "Authorization: Bearer <PEY_API_KEY>",
  ];
  if (ep.body)
    lines.push(
      "Content-Type: application/json",
      "",
      JSON.stringify(ep.body, null, 2),
    );
  return lines.join("\n");
}
function endpointCard(ep) {
  const prod = state.mode === "production";
  const mutating = ep.risk !== "lectura";
  const inputs = ep.params.map((p) => {
    const input = h("input", {
      type: "text",
      spellcheck: "false",
      autocomplete: "off",
      "data-ctx": p.ctx,
      "data-name": p.name,
      placeholder: p.required ? "obligatorio" : "opcional",
      oninput: (e) => {
        e.target.dataset.touched = "1";
      },
    });
    return h(
      "label",
      { class: "field" },
      `${p.label}${p.required ? " *" : ""}`,
      input,
      p.hint ? h("small", {}, p.hint) : null,
    );
  });
  const textarea = ep.body
    ? h("textarea", { spellcheck: "false", "data-body": "1" })
    : null;
  if (textarea) textarea.value = JSON.stringify(ep.body, null, 2);
  const confirmBox = h("input", { type: "checkbox", "data-confirm": "1" });
  const send = h("button", { class: "primary", type: "button" }, "Enviar");
  const resultBox = h("div", { class: "result", hidden: true });
  const warnBox = mutating
    ? prod
      ? h(
          "div",
          { class: "warn" },
          h("b", {}, "⚠ Esto usa dinero/cuentas reales. "),
          ep.warning,
          h(
            "label",
            {},
            confirmBox,
            "Entiendo que se ejecuta contra producción con la clave real.",
          ),
        )
      : h(
          "div",
          { class: "sbx-note" },
          "Sandbox: no mueve dinero ni toca cuentas reales.",
        )
    : null;
  const card = h(
    "article",
    { class: "card", "data-group": ep.group, id: `ep-${ep.id}` },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: `method ${ep.method}` }, ep.method),
      h("span", { class: "path" }, ep.path),
      h(
        "span",
        { class: `risk ${mutating ? "dinero" : "lectura"}` },
        mutating ? "usa dinero/cuentas" : "solo lectura",
      ),
    ),
    h("h3", {}, ep.title),
    h("p", {}, ep.description),
    h(
      "div",
      { class: "mini" },
      ep.flow.map((s, i) => [
        i ? "→" : null,
        h(
          "i",
          {
            "data-step": s,
            class: s === "webhook" || s === "tuapp" ? "hook" : "",
          },
          STEP_LABEL[s],
        ),
      ]),
    ),
    inputs,
    textarea
      ? h("label", { class: "field" }, "Cuerpo JSON (editable)", textarea)
      : null,
    warnBox,
    h("div", { class: "row" }, send),
    resultBox,
    h(
      "details",
      {},
      h("summary", {}, "Ejemplo de petición y respuesta"),
      h(
        "div",
        { class: "inner" },
        h("div", { class: "lab" }, "Petición de ejemplo (docs.pey.mx)"),
        h("pre", {}, requestSample(ep)),
        h("div", { class: "lab" }, "Respuesta de ejemplo"),
        jsonPre(ep.response),
      ),
    ),
    h(
      "details",
      {},
      h("summary", {}, "Cómo se mueve el dato"),
      h(
        "div",
        { class: "inner" },
        h(
          "ol",
          { class: "story" },
          ep.story.map((s) => h("li", {}, s)),
        ),
      ),
    ),
  );
  const setSendLabel = () => {
    send.className = `primary${prod && mutating ? " prod" : ""}`;
    send.textContent = prod && mutating ? "Enviar (producción real)" : "Enviar";
  };
  setSendLabel();

  send.addEventListener("click", async () => {
    const params = {};
    card.querySelectorAll("input[data-name]").forEach((i) => {
      params[i.dataset.name] = i.value.trim();
    });
    let body;
    if (textarea) {
      try {
        body = JSON.parse(textarea.value);
      } catch {
        showError(resultBox, "El cuerpo no es JSON válido.");
        return;
      }
    }
    if (prod && mutating && !confirmBox.checked) {
      showError(
        resultBox,
        "Marca la casilla de confirmación: esta llamada usa dinero o cuentas reales.",
      );
      return;
    }
    send.disabled = true;
    const mode = state.mode;
    const result = await animateCall(card, ep, async () => {
      const t0 = performance.now();
      const { status, data } = await api("/api/call", {
        mode,
        endpointId: ep.id,
        params,
        ...(body ? { body } : {}),
        ...(prod && mutating ? { confirm: "REAL" } : {}),
      });
      const failed = !data || data.ok === false;
      renderResult(
        card,
        resultBox,
        ep,
        data,
        status,
        Math.round(performance.now() - t0),
      );
      if (!failed) learn(ep, data.response?.body);
      return { failed };
    });
    send.disabled = false;
    if (prod && mutating) confirmBox.checked = false;
    return result;
  });
  return card;
}
function showError(box, message) {
  box.hidden = false;
  box.replaceChildren(h("div", { class: "warn" }, message));
}
function renderResult(card, box, ep, data, httpStatus, roundTrip) {
  box.hidden = false;
  if (!data) {
    box.replaceChildren(
      h(
        "div",
        { class: "warn" },
        `Respuesta inesperada del proxy (HTTP ${httpStatus}).`,
      ),
    );
    return;
  }
  const kids = [];
  if (data.response) {
    const r = data.response;
    kids.push(
      h(
        "div",
        { class: "stat" },
        h(
          "span",
          { class: `badge ${r.status < 400 ? "ok" : "bad"}` },
          `${r.status} ${r.statusText || ""}`.trim(),
        ),
        h("span", { class: "badge info" }, `pey: ${r.latencyMs} ms`),
        h("span", { class: "badge info" }, `ida y vuelta: ${roundTrip} ms`),
        h(
          "span",
          { class: "muted" },
          state.mode === "production" ? "producción" : "sandbox",
        ),
      ),
    );
    kids.push(
      h("div", { class: "lab" }, "Petición enviada (clave oculta)"),
      jsonPre(data.request),
    );
    kids.push(
      h(
        "div",
        { class: "lab" },
        "Respuesta real (CLABE a 4 dígitos, secretos ocultos)",
      ),
      jsonPre(r.body),
    );
    if (r.qrImagePng)
      kids.push(
        h("img", {
          class: "qr",
          alt: "QR CoDi devuelto por pey",
          src: `data:image/png;base64,${r.qrImagePng}`,
        }),
      );
    if (state.mode === "sandbox" && ep.sandboxNext && r.status < 300) {
      const id = r.body?.[ep.sandboxNext.idFrom];
      if (typeof id === "string")
        kids.push(
          h(
            "div",
            { class: "row" },
            h(
              "button",
              {
                class: "ghost",
                type: "button",
                onclick: (e) => sandboxAct(e.currentTarget, ep, id, card),
              },
              `▶ ${ep.sandboxNext.label}`,
            ),
            h(
              "span",
              { class: "muted" },
              "el «banco» sandbox dispara un webhook firmado a este servidor",
            ),
          ),
        );
    }
  } else {
    kids.push(
      h(
        "div",
        { class: "stat" },
        h("span", { class: "badge bad" }, `HTTP ${httpStatus}`),
        h("span", { class: "badge warn" }, data.code ?? "error"),
      ),
    );
    kids.push(h("div", { class: "warn" }, data.message ?? "Error"));
    if (data.request)
      kids.push(
        h("div", { class: "lab" }, "Petición (no enviada o sin respuesta)"),
        jsonPre(data.request),
      );
  }
  box.replaceChildren(...kids);
}
async function sandboxAct(button, ep, id, card) {
  button.disabled = true;
  const { data } = await api("/api/sandbox/action", {
    action: ep.sandboxNext.action,
    id,
  });
  $("flow-caption").textContent = data?.ok
    ? "El banco sandbox confirmó: pey firmó el webhook y lo entregó a tu app (mira «Webhooks recibidos en vivo»)."
    : "No se pudo simular la acción.";
  button.disabled = false;
  button.after(
    h(
      "span",
      { class: `badge ${data?.ok ? "ok" : "bad"}` },
      data?.ok ? "webhook enviado" : "falló",
    ),
  );
}

// ---------- webhook cards ----------
function webhookCard(ev) {
  const variant = h(
    "select",
    {},
    h("option", { value: "valid" }, "Firma válida"),
    h("option", { value: "tampered" }, "Cuerpo alterado tras firmar"),
    h("option", { value: "stale" }, "Timestamp de hace 10 min"),
  );
  const textarea = h("textarea", { spellcheck: "false" });
  textarea.value = JSON.stringify(ev.payload, null, 2);
  const resultBox = h("div", { class: "result", hidden: true });
  let lastId = null;
  const again = h(
    "button",
    { class: "ghost", type: "button", disabled: true },
    "Reenviar el mismo webhook-id (idempotencia)",
  );
  const card = h(
    "article",
    { class: "card", id: `wh-${ev.type}` },
    h(
      "div",
      { class: "card-head" },
      h("span", { class: "method WEBHOOK" }, "WEBHOOK"),
      h("span", { class: "path" }, ev.type),
    ),
    h("h3", {}, ev.title),
    h("p", {}, ev.description),
    h("p", {}, h("b", {}, "Cuándo: "), ev.when),
    h(
      "div",
      { class: "mini" },
      ["pey", "webhook", "tuapp"].map((s, i) => [
        i ? "→" : null,
        h(
          "i",
          { "data-step": s, class: s === "pey" ? "" : "hook" },
          STEP_LABEL[s],
        ),
      ]),
    ),
    h(
      "details",
      {},
      h("summary", {}, "Payload de ejemplo (editable) y cabeceras"),
      h(
        "div",
        { class: "inner" },
        h("div", { class: "lab" }, "Cabeceras que firma pey"),
        h(
          "pre",
          {},
          "webhook-id: msg_…\nwebhook-timestamp: 1790724818\nwebhook-signature: v1,<HMAC-SHA256 base64>",
        ),
        h("div", { class: "lab" }, "Cuerpo JSON"),
        textarea,
      ),
    ),
    h("label", { class: "field" }, "Variante a enviar", variant),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { class: "primary", type: "button", onclick: () => run(false) },
        "Simular",
      ),
      again,
    ),
    resultBox,
  );
  again.addEventListener("click", () => run(true));
  async function run(reuse) {
    let payload;
    try {
      payload = JSON.parse(textarea.value);
    } catch {
      showError(resultBox, "El payload no es JSON válido.");
      return;
    }
    $("flow-caption").textContent =
      "Firmando localmente con tu secreto y enviando a /webhooks/pey de este servidor…";
    setStep(card, "pey", "on");
    await sleep(300);
    setStep(card, "pey", "done");
    setStep(card, "webhook", "on");
    await sleep(380);
    const { data } = await api("/api/webhooks/simulate", {
      type: ev.type,
      mode: state.mode,
      variant: variant.value,
      payload,
      ...(reuse && lastId ? { webhookId: lastId } : {}),
    });
    setStep(card, "webhook", "done");
    setStep(card, "tuapp", "on");
    box(data);
    await sleep(500);
    const ok = data?.response && data.response.status < 300;
    setStep(card, "tuapp", ok ? "done" : "err");
    $("flow-caption").textContent = ok
      ? "Tu app verificó la firma y respondió 2xx; pey no reintentará."
      : "Tu app rechazó el webhook (401): pey lo reintentaría; aquí no se procesó nada.";
    if (data?.webhookId) {
      lastId = data.webhookId;
      again.disabled = false;
    }
    setTimeout(() => clearFlow(card), 6000);
  }
  function box(data) {
    resultBox.hidden = false;
    if (!data || !data.request) {
      resultBox.replaceChildren(
        h("div", { class: "warn" }, data?.message ?? "No se pudo simular."),
      );
      return;
    }
    resultBox.replaceChildren(
      h(
        "div",
        { class: "stat" },
        h(
          "span",
          { class: `badge ${data.response.status < 300 ? "ok" : "bad"}` },
          `tu ruta respondió ${data.response.status}`,
        ),
        h("span", { class: "muted mono" }, data.webhookId),
      ),
      h(
        "ul",
        { class: "steps" },
        data.verification.map((v) =>
          h(
            "li",
            {},
            h("span", { class: "tick" }, v.ok ? "✅" : "⛔"),
            h("span", {}, h("b", {}, `${v.step}: `), v.detail),
          ),
        ),
      ),
      h("div", { class: "lab" }, "Petición firmada que recibió /webhooks/pey"),
      jsonPre(data.request),
    );
  }
  return card;
}

// ---------- live feed ----------
function feedItem(e) {
  const ok = e.outcome === "aceptado" || e.outcome === "duplicado";
  return h(
    "div",
    { class: "feed-item", "data-seq": e.seq },
    h(
      "div",
      { class: "meta" },
      h(
        "span",
        {
          class: `badge ${e.outcome === "aceptado" ? "ok" : e.outcome === "duplicado" ? "warn" : "bad"}`,
        },
        e.outcome,
      ),
      h("b", {}, e.type ?? "(sin verificar)"),
      h("span", { class: "badge info" }, `HTTP ${e.httpStatus}`),
      e.source ? h("span", { class: "muted" }, `firma ${e.source}`) : null,
      h("span", { class: "muted mono" }, e.webhookId ?? ""),
      h(
        "span",
        { class: "muted" },
        new Date(e.receivedAt).toLocaleTimeString("es-MX"),
      ),
    ),
    e.payload
      ? h(
          "details",
          {},
          h("summary", {}, "Payload verificado"),
          h("div", { class: "inner" }, jsonPre(e.payload)),
        )
      : h(
          "p",
          { class: "muted" },
          ok ? "" : "Rechazado antes de leer el cuerpo.",
        ),
  );
}
const seen = new Set();
function addFeed(e, live) {
  if (seen.has(e.seq)) return;
  seen.add(e.seq);
  $("feed-empty")?.remove();
  $("feed").prepend(feedItem(e));
  if (live && (e.outcome === "aceptado" || e.outcome === "duplicado"))
    flashWebhook(e);
}
async function flashWebhook(e) {
  const pseudo = document.createElement("div");
  setStep(pseudo, "webhook", "on");
  await sleep(500);
  setStep(pseudo, "webhook", "done");
  setStep(pseudo, "tuapp", "on");
  $("flow-caption").textContent =
    `Llegó ${e.type}: firma verificada y registrado (${e.outcome}).`;
  await sleep(1200);
  setStep(pseudo, "tuapp", "done");
  setTimeout(() => clearFlow(pseudo), 4000);
}
function connectFeed() {
  const es = new EventSource("/api/webhooks/stream");
  es.onopen = () => {
    $("feed-state").textContent = "● conectado";
  };
  es.onerror = () => {
    $("feed-state").textContent = "reconectando…";
  };
  es.onmessage = (m) => {
    try {
      addFeed(JSON.parse(m.data), true);
    } catch {
      /* ignore */
    }
  };
}

// ---------- shell ----------
function renderMode() {
  const m = state.boot.modes;
  const mk = (id, label, avail) =>
    h(
      "button",
      {
        type: "button",
        class: id === "production" ? "prod" : "",
        "aria-pressed": String(state.mode === id),
        disabled: !avail,
        title: avail ? "" : "No configurado en el servidor",
        onclick: () => {
          state.mode = id;
          render();
        },
      },
      label,
    );
  $("mode").replaceChildren(
    mk("sandbox", "Sandbox", m.sandbox.available),
    mk("production", "Producción", m.production.available),
  );
  const banner = $("banner");
  banner.hidden = false;
  if (state.mode === "production") {
    banner.className = "banner prod";
    banner.textContent = m.production.postsEnabled
      ? `PRODUCCIÓN con clave real. Las lecturas son libres; las escrituras requieren confirmación y están limitadas a ${m.production.maxAmount} MXN.`
      : "PRODUCCIÓN con clave real. Solo lectura: las escrituras (POST) están bloqueadas en este servidor.";
  } else {
    banner.className = "banner sbx";
    banner.textContent =
      "SANDBOX local: imita a api.pey.mx con datos de ejemplo. No mueve dinero y firma sus webhooks de verdad.";
  }
}
let group = "Todos";
function render() {
  const b = state.boot;
  renderMode();
  const groups = ["Todos", ...new Set(b.endpoints.map((e) => e.group))];
  $("filters").replaceChildren(
    ...groups.map((g) =>
      h(
        "button",
        {
          class: "chip-btn",
          type: "button",
          "aria-pressed": String(g === group),
          onclick: () => {
            group = g;
            render();
          },
        },
        g,
      ),
    ),
  );
  $("endpoints").replaceChildren(
    ...b.endpoints
      .filter((e) => group === "Todos" || e.group === group)
      .map(endpointCard),
  );
  $("webhooks").replaceChildren(...b.webhooks.map(webhookCard));
  refreshInputs();
}
async function main() {
  buildFlow();
  const { data } = await api("/api/bootstrap");
  if (!data) {
    $("flow-caption").textContent = "No se pudo cargar el explorador.";
    return;
  }
  state.boot = data;
  state.mode = data.defaultMode;
  state.ctx.sandbox = { ...data.modes.sandbox.seed, nextToken: "" };
  render();
  [...data.feed].forEach((e) => addFeed(e, false));
  connectFeed();
}
main();
