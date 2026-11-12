import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";

describe("configuration and secret boundaries", () => {
  it("fails clearly without configuration without printing supplied secrets", () => {
    expect(() => loadConfig({ PEY_API_KEY: "sensitive-api-key" })).toThrow(
      "DATA_DIR",
    );
    try {
      loadConfig({ PEY_API_KEY: "sensitive-api-key" });
    } catch (e) {
      expect(String(e)).not.toContain("sensitive-api-key");
    }
  });
  it("redacts arbitrary nested secrets, CLABE and errors", () => {
    let output = "";
    const logger = createLogger(["private-test-key"], {
      write(chunk: string) {
        output += chunk;
      },
    });
    logger.info(
      {
        nested: {
          clabe: "012180001234567899",
          token: "abc",
          raw: "{sensitive}",
          body: "raw body",
        },
        err: new Error("Bearer private-test-key"),
      },
      "whsec_ZXhhbXBsZQ== private-test-key 012180001234567899",
    );
    for (const secret of [
      "012180001234567899",
      "private-test-key",
      "whsec_",
      "{sensitive}",
      "raw body",
      "abc",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  });
  it("requires distinct merchant and product numbers and accepts the legacy SELF_JID alias", () => {
    const base = {
      DATA_DIR: "/tmp/x",
      SESSION_ENCRYPTION_KEY: "a".repeat(64),
      PEY_API_KEY: "k",
      PEY_API_KEY_ID: "id",
      PEY_WEBHOOK_SECRET: "whsec_x",
      PUBLIC_BASE_URL: "https://example.test",
    };
    const merchant = "5215550000001@s.whatsapp.net";
    const product = "5215550000009@s.whatsapp.net";
    expect(() =>
      loadConfig({ ...base, MERCHANT_JID: merchant, PRODUCT_JID: merchant }),
    ).toThrow("distinto");
    expect(
      loadConfig({ ...base, SELF_JID: merchant, PRODUCT_JID: product })
        .MERCHANT_JID,
    ).toBe(merchant);
    expect(() => loadConfig({ ...base, MERCHANT_JID: merchant })).toThrow(
      "PRODUCT_JID",
    );
  });
});
