import { describe, expect, it } from "vitest";
import { validateCandidateFacts } from "../src/extraction.js";
import type { CandidateFacts, Observation } from "../src/contracts.js";

const messages: Observation[] = [
  {
    chatJid: "1@s.whatsapp.net",
    messageId: "m1",
    fromMe: true,
    at: 1000,
    text: "Balatas 800 y mano de obra 400, total 1200. Anticipo 600.",
  },
];
const facts: CandidateFacts = {
  agreed: true,
  lines: [
    { description: "Balatas", amountText: "800" },
    { description: "mano de obra", amountText: "400" },
  ],
  totalText: "1200",
  requestedNowText: "600",
  kind: "DEPOSIT",
  ambiguities: [],
  evidence: ["m1"],
};

describe("candidate fact validation", () => {
  it("accepts grounded strict amounts", () =>
    expect(validateCandidateFacts(facts, messages).ambiguities).toEqual([]));
  it("requires real evidence and rejects ungrounded or malformed amounts", () => {
    const result = validateCandidateFacts(
      {
        ...facts,
        evidence: ["invented"],
        totalText: "1200.001",
        requestedNowText: "700",
      },
      messages,
    );
    expect(result.ambiguities).toEqual(
      expect.arrayContaining([
        expect.stringContaining("evidencia"),
        expect.stringContaining("ambiguo"),
        expect.stringContaining("sin evidencia"),
      ]),
    );
  });
  it("does not match an amount as a substring of another amount", () => {
    const result = validateCandidateFacts(
      { ...facts, lines: [], totalText: "200", requestedNowText: null },
      messages,
    );
    expect(result.ambiguities).toContain("Monto sin evidencia: 200");
  });
});
