import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadMcpConfig } from "../src/mcp/config.js";
import { PeyClient } from "../src/pey.js";
import { SANDBOX_CLABE } from "../src/mcp/sandbox.js";
import {
  buildContext,
  createPeyMcpServer,
  MCP_SPEC_VERSION,
} from "../src/mcp/server.js";
import {
  localDate,
  maskClabe,
  normalizePhone,
  pesosToCents,
  type McpContext,
} from "../src/mcp/tools.js";

type Block = { type: string; text?: string };
const texto = (r: { content?: unknown }) =>
  ((r.content ?? []) as Block[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
const datos = (r: { structuredContent?: unknown }) =>
  (r.structuredContent ?? {}) as Record<string, any>;

async function connect(ctx: McpContext) {
  const server = createPeyMcpServer(ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, close: () => client.close() };
}

describe("configuración del MCP", () => {
  it("arranca en sandbox sin clave y sin tope práctico", () => {
    const c = loadMcpConfig({});
    expect(c).toMatchObject({
      mode: "sandbox",
      allowWrites: true,
      baseUrl: "https://api.pey.mx",
      timezone: "America/Mexico_City",
    });
    expect(c.maxAmountCents).toBe(100_000_000);
  });
  it("producción exige clave, escrituras explícitas y tope de $100 por defecto", () => {
    expect(() => loadMcpConfig({ PEY_MODE: "production" })).toThrow(
      /PEY_API_KEY/,
    );
    const c = loadMcpConfig({ PEY_MODE: "production", PEY_API_KEY: "k" });
    expect(c.allowWrites).toBe(false);
    expect(c.maxAmountCents).toBe(10_000);
    const abierto = loadMcpConfig({
      PEY_MODE: "production",
      PEY_API_KEY: "k",
      PEY_MCP_ALLOW_WRITES: "true",
      PEY_MCP_MAX_AMOUNT: "25.50",
    });
    expect(abierto).toMatchObject({ allowWrites: true, maxAmountCents: 2550 });
  });
  it("rechaza modos, topes y URLs inválidos", () => {
    expect(() => loadMcpConfig({ PEY_MODE: "prod" })).toThrow(/inválida/);
    expect(() => loadMcpConfig({ PEY_MCP_MAX_AMOUNT: "-5" })).toThrow();
    expect(() =>
      loadMcpConfig({ PEY_BASE_URL: "http://api.pey.mx" }),
    ).toThrow();
  });
});

describe("utilidades", () => {
  it("convierte pesos a centavos y rechaza más de dos decimales", () => {
    expect(pesosToCents(150)).toBe(15000);
    expect(pesosToCents(99.5)).toBe(9950);
    expect(pesosToCents(0.1 + 0.2)).toBe(30);
    expect(() => pesosToCents(10.123)).toThrow(/dos decimales/);
  });
  it("normaliza teléfonos mexicanos", () => {
    expect(normalizePhone("+52 55 1234 5678")).toBe("5512345678");
    expect(normalizePhone("55-1234-5678")).toBe("5512345678");
    expect(() => normalizePhone("12345")).toThrow(/10 dígitos/);
  });
  it("enmascara CLABEs", () => {
    expect(maskClabe(SANDBOX_CLABE)).toBe("**************7771");
  });
  it("calcula el día en hora de Ciudad de México", () => {
    const tz = "America/Mexico_City";
    // 05:59 UTC = 23:59 del día anterior en CDMX (UTC-6); 06:00 UTC ya es el día nuevo.
    expect(localDate(Date.parse("2026-11-15T05:59:00Z") / 1000, tz)).toBe(
      "2026-11-14",
    );
    expect(localDate(Date.parse("2026-11-15T06:00:00Z") / 1000, tz)).toBe(
      "2026-11-15",
    );
  });
});

describe("herramientas en sandbox", () => {
  let ctx: Awaited<ReturnType<typeof buildContext>>;
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ctx = await buildContext(loadMcpConfig({}));
    ({ client, close } = await connect(ctx));
  });
  afterAll(async () => {
    await close();
    await ctx.close();
  });
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });

  it("publica las herramientas y los cuatro prompts", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "conciliar_dia",
      "consultar_cuenta",
      "crear_cobro",
      "registrar_cuenta",
      "revisar_cobro",
      "simular_pago",
    ]);
    for (const t of tools) expect(t.description).toMatch(/[a-záéíóú]/i);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "cobra_al_cliente",
      "da_de_alta_mi_cuenta",
      "reconcilia_el_dia",
      "revisa_si_pago",
    ]);
  });

  it("crea un cobro QR, lo ve pendiente, lo simula pagado y lo concilia", async () => {
    const creado = await call("crear_cobro", {
      monto: 150,
      concepto: "Corte de cabello",
      alias_pagador: "Ana",
    });
    expect(creado.isError).toBeFalsy();
    const d = datos(creado);
    expect(d).toMatchObject({
      creado: true,
      metodo: "qr",
      monto: "$150.00 MXN",
      estado: "pendiente",
    });
    expect(d.cobro_id).toMatch(/^qr:/);
    const imagen = (creado.content as Block[]).find((b) => b.type === "image");
    expect(imagen).toBeTruthy();

    const antes = datos(await call("revisar_cobro", { cobro_id: d.cobro_id }));
    expect(antes).toMatchObject({ pagado: false, estado: "pendiente" });

    await call("simular_pago", { cobro_id: d.cobro_id });
    const despues = datos(
      await call("revisar_cobro", { cobro_id: d.cobro_id }),
    );
    expect(despues.pagado).toBe(true);
    expect(despues.pagos[0]).toMatchObject({
      monto: "$150.00 MXN",
      cuenta_destino: "**************7771",
    });
    // También acepta el id pelón, sin prefijo.
    const pelon = datos(
      await call("revisar_cobro", { cobro_id: d.cobro_id.slice(3) }),
    );
    expect(pelon.pagado).toBe(true);

    const dia = datos(await call("conciliar_dia", {}));
    expect(dia.total_recibido).toMatch(/^\$150\.00/);
    expect(dia).toMatchObject({
      num_pagos: 1,
      zona_horaria: "America/Mexico_City",
      completo: true,
    });
  });

  it("cobra con link y con solicitud push al celular", async () => {
    const link = datos(
      await call("crear_cobro", {
        monto: 99.5,
        concepto: "Pedido 12",
        metodo: "link",
      }),
    );
    expect(link.cobro_id).toMatch(/^link:/);
    expect(link.link).toMatch(/^https:\/\//);
    expect(
      datos(await call("revisar_cobro", { cobro_id: link.cobro_id })).estado,
    ).toBe("pendiente");
    await call("simular_pago", { cobro_id: link.cobro_id });
    expect(
      datos(await call("revisar_cobro", { cobro_id: link.cobro_id })).pagado,
    ).toBe(true);

    const push = await call("crear_cobro", {
      monto: 40,
      concepto: "Café",
      telefono_pagador: "+52 55 1234 5678",
    });
    const p = datos(push);
    expect(p).toMatchObject({ metodo: "push", telefono_pagador: "******5678" });
    expect(texto(push)).not.toContain("5512345678");
    expect(p.cobro_id).toMatch(/^tx:/);
    await call("simular_pago", { cobro_id: p.cobro_id });
    expect(
      datos(await call("revisar_cobro", { cobro_id: p.cobro_id })).pagado,
    ).toBe(true);
  });

  it("concilia solo el día pedido", async () => {
    const otroDia = datos(await call("conciliar_dia", { fecha: "2020-01-01" }));
    expect(otroDia).toMatchObject({ num_pagos: 0, completo: true });
    const hoy = datos(await call("conciliar_dia", {}));
    expect(hoy.num_pagos).toBeGreaterThanOrEqual(3);
    expect(hoy.por_metodo.CODI.pagos).toBe(hoy.num_pagos);
  });

  it("registra y consulta una cuenta sin revelar la CLABE", async () => {
    const clabe = "646180157034432952";
    const r = await call("registrar_cuenta", {
      alias: "Mi cuenta",
      nombre_legal: "Ana Pérez",
      clabe,
      tipo_persona: "persona_fisica",
    });
    expect(texto(r)).not.toMatch(/^Error/);
    expect(datos(r)).toMatchObject({
      registrada: true,
      estado: "PENDING",
      clabe: "**************2952",
    });
    expect(texto(r)).not.toContain(clabe);
    const c = await call("consultar_cuenta", {
      cuenta_id: datos(r).cuenta_id,
    });
    expect(datos(c)).toMatchObject({
      activa: false,
      tipo_persona: "persona_fisica",
      clabe: "**************2952",
    });
    expect(texto(c)).not.toContain(clabe);
  });

  it("explica en español los errores esperados", async () => {
    const clabeMala = await call("registrar_cuenta", {
      alias: "x",
      nombre_legal: "x",
      clabe: "646180157034432950",
      tipo_persona: "empresa",
    });
    expect(clabeMala.isError).toBe(true);
    expect(texto(clabeMala)).toMatch(/CLABE no es válida/);

    const decimales = await call("crear_cobro", {
      monto: 10.123,
      concepto: "x",
    });
    expect(texto(decimales)).toMatch(/dos decimales/);

    const sinTel = await call("crear_cobro", {
      monto: 10,
      concepto: "x",
      metodo: "push",
    });
    expect(texto(sinTel)).toMatch(/telefono_pagador/);

    const noExiste = await call("revisar_cobro", {
      cobro_id: "link:no-existe",
    });
    expect(noExiste.isError).toBe(true);
    expect(texto(noExiste)).toMatch(/No encontré ese cobro/);

    // Argumentos fuera del esquema los rechaza el SDK.
    const negativo = await call("crear_cobro", { monto: -1, concepto: "x" });
    expect(negativo.isError).toBe(true);
  });

  it("los prompts traen la skill con los datos del cobro", async () => {
    const p = await client.getPrompt({
      name: "cobra_al_cliente",
      arguments: { monto: "350", concepto: "Pastel", telefono: "5512345678" },
    });
    const msg = p.messages[0]!.content as Block;
    expect(msg.text).toContain("$350 MXN");
    expect(msg.text).toContain("«Pastel»");
    expect(msg.text).toContain("5512345678");
    expect(msg.text).toContain("# Cobra al cliente");
    expect(msg.text).not.toContain("name: cobra-al-cliente");
  });
});

describe("producción con tope y protección de escritura", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const path = new URL(String(url)).pathname;
      if (path === "/codi/qr")
        return Response.json({ id: "QR1", qrString: "000201CODI" });
      return Response.json({ message: "no" }, { status: 404 });
    },
  );
  const pey = new PeyClient({
    apiKey: "live-key-secreta",
    baseUrl: "https://api.pey.mx",
    fetch: fetcher as unknown as typeof fetch,
  });
  const base = {
    PEY_MODE: "production",
    PEY_API_KEY: "live-key-secreta",
  };
  const cliente = async (env: Record<string, string>) =>
    connect({ config: loadMcpConfig({ ...base, ...env }), pey });

  it("sin PEY_MCP_ALLOW_WRITES no escribe y no ofrece simular_pago", async () => {
    const { client, close } = await cliente({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("simular_pago");
    const r = await client.callTool({
      name: "crear_cobro",
      arguments: { monto: 10, concepto: "x", confirmar: true },
    });
    expect(r.isError).toBe(true);
    expect(texto(r)).toMatch(/PEY_MCP_ALLOW_WRITES/);
    expect(calls).toHaveLength(0);
    await close();
  });

  it("aplica el tope de $100 por defecto", async () => {
    const { client, close } = await cliente({ PEY_MCP_ALLOW_WRITES: "true" });
    const r = await client.callTool({
      name: "crear_cobro",
      arguments: { monto: 100.01, concepto: "x", confirmar: true },
    });
    expect(r.isError).toBe(true);
    expect(texto(r)).toMatch(/supera el tope/);
    expect(calls).toHaveLength(0);
    await close();
  });

  it("pide confirmación y solo entonces cobra de verdad", async () => {
    const { client, close } = await cliente({ PEY_MCP_ALLOW_WRITES: "true" });
    const previa = await client.callTool({
      name: "crear_cobro",
      arguments: {
        monto: 50,
        concepto: "Prueba",
        telefono_pagador: "5512345678",
      },
    });
    expect(datos(previa)).toMatchObject({ creado: false });
    expect(texto(previa)).toMatch(/VISTA PREVIA/);
    expect(texto(previa)).not.toContain("5512345678");
    expect(calls).toHaveLength(0);

    const real = await client.callTool({
      name: "crear_cobro",
      arguments: {
        monto: 50,
        concepto: "Prueba",
        metodo: "qr",
        confirmar: true,
      },
    });
    expect(datos(real)).toMatchObject({ creado: true, cobro_id: "qr:QR1" });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.pey.mx/codi/qr");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer live-key-secreta",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: 50,
      concept: "Prueba",
      generateImage: false,
    });
    // La clave nunca aparece en lo que ve el agente.
    expect(texto(real)).not.toContain("live-key-secreta");
    await close();
  });

  it("registrar_cuenta también exige confirmación", async () => {
    calls.length = 0;
    const { client, close } = await cliente({ PEY_MCP_ALLOW_WRITES: "true" });
    const r = await client.callTool({
      name: "registrar_cuenta",
      arguments: {
        alias: "Mi cuenta",
        nombre_legal: "Ana Pérez",
        clabe: SANDBOX_CLABE,
        tipo_persona: "empresa",
      },
    });
    expect(datos(r)).toMatchObject({ registrada: false });
    expect(texto(r)).not.toContain(SANDBOX_CLABE);
    expect(calls).toHaveLength(0);
    await close();
  });
});

describe("servidor por stdio", () => {
  it("habla el protocolo vigente y atiende una llamada real", async () => {
    expect(MCP_SPEC_VERSION).toBe("2026-07-28");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp.ts"],
      env: { ...(process.env as Record<string, string>), PEY_MODE: "sandbox" },
    });
    const client = new Client(
      { name: "test-stdio", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: MCP_SPEC_VERSION } } },
    );
    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      const r = await client.callTool({
        name: "crear_cobro",
        arguments: { monto: 20, concepto: "Prueba stdio" },
      });
      expect(datos(r)).toMatchObject({ creado: true, metodo: "qr" });
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("cliente de pey: listados y links con la forma real de la API", () => {
  const completa = (id: string, amount: number, datePaid: number) => ({
    id,
    status: "PAID",
    amount,
    amountBreakdown: { base: amount, tip: 0, fee: 2.5 },
    currency: "MXN",
    paymentMethod: "CARD",
    payableType: "PAYMENT_LINK",
    payableId: "L1",
    dateCreated: datePaid - 60,
    datePaid,
    metadata: { clabe: "000000000000000000", bankCode: 40012 },
  });
  it("lee el listado con transacciones completas y completa las que vengan solo con id", async () => {
    const urls: string[] = [];
    const fetcher = async (url: string | URL | Request) => {
      const u = new URL(String(url));
      urls.push(u.pathname + u.search);
      if (u.pathname === "/transaction/api-key")
        return Response.json({
          items: [completa("T1", 118.5, 1_790_000_000), { id: "T2" }],
          nextToken: "tok",
        });
      if (u.pathname === "/transaction/T2")
        return Response.json(completa("T2", 20, 1_789_999_000));
      return Response.json({ message: "no" }, { status: 404 });
    };
    const pey = new PeyClient({
      apiKey: "k",
      fetch: fetcher as unknown as typeof fetch,
    });
    const page = await pey.listTransactions({});
    expect(page.nextToken).toBe("tok");
    expect(page.transactions.map((t) => [t.id, t.amountCents])).toEqual([
      ["T1", 11850],
      ["T2", 2000],
    ]);
    expect(urls).toEqual(["/transaction/api-key", "/transaction/T2"]);
  });
  it("usa el listado por cuenta y lee el estado de un link", async () => {
    const urls: string[] = [];
    const fetcher = async (url: string | URL | Request) => {
      const u = new URL(String(url));
      urls.push(u.pathname + u.search);
      if (u.pathname === "/payment-link/L1")
        return Response.json({
          id: "L1",
          amount: 118.5,
          status: "partial",
          transactions: [
            {
              transactionId: "T1",
              paymentMethod: "CARD",
              amount: 50,
              datePaid: 1,
            },
          ],
        });
      return Response.json({ items: [], nextToken: null });
    };
    const pey = new PeyClient({
      apiKey: "k",
      fetch: fetcher as unknown as typeof fetch,
    });
    await pey.listTransactions({ bankAccountId: "ACC1" }, "abc");
    expect(urls[0]).toBe("/transaction/bank-account/ACC1?nextToken=abc");
    const link = await pey.getPaymentLink("L1");
    expect(link).toMatchObject({ status: "partial", amountCents: 11850 });
    expect(link.transactions[0]).toMatchObject({ id: "T1", amountCents: 5000 });
  });
});
