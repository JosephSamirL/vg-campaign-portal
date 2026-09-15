// Story 2.2 — dialect parser + COPY line encoding. Pure functions, no DB.
import { describe, expect, it } from "vitest";
import { CANONICAL, DIALECTS, normalizeHeader, type FileDialect } from "@/scripts/seed/dialects";
import { parseSeedFile, toArrayLiteral, toCopyLine } from "@/scripts/seed/stage";

const dialect = (file: string): FileDialect => {
  const d = DIALECTS.find((x) => x.file === file);
  if (!d) throw new Error(`no dialect for ${file}`);
  return d;
};

const KILELE_HEADER = CANONICAL.contacts.join(",");
const kilele = dialect("kilele-contacts.csv");

describe("dialects", () => {
  it("lists the 11 seed files with hard-coded as_of / file_rank", () => {
    expect(DIALECTS).toHaveLength(11);
    expect(new Set(DIALECTS.map((d) => d.file)).size).toBe(11);
    const delta = dialect("kilele-contacts-delta-2026-09-01.csv");
    expect(delta.asOf).toBe("2026-09-01");
    expect(delta.fileRank).toBe(20);
    for (const d of DIALECTS.filter((x) => x !== delta)) {
      expect(d.asOf).toBe("2026-08-01");
      expect(d.fileRank).toBe(10);
    }
    expect(dialect("karoo-contacts.csv").encoding).toBe("windows-1252");
    for (const d of DIALECTS) {
      expect(d.delimiter).toBe(d.file.startsWith("marrakech-") ? ";" : ",");
      expect(d.expectedCols).toBe(CANONICAL[d.entity].length);
    }
    expect(dialect("marrakech-campaigns.csv").decimalCommaColumns).toEqual(["spend"]);
  });

  it("normalizeHeader strips BOM, trims, lower-cases, spaces→_, then maps", () => {
    expect(normalizeHeader("\uFEFFexternal_id", {})).toBe("external_id");
    expect(normalizeHeader("  Full Name ", {})).toBe("full_name");
    expect(normalizeHeader("Signup At", {})).toBe("signup_at");
    expect(normalizeHeader("e_mail", { e_mail: "email" })).toBe("email");
    expect(normalizeHeader("Pays", { pays: "country" })).toBe("country");
  });
});

describe("parseSeedFile", () => {
  it("strips the UTF-8 BOM so the first header is external_id", () => {
    const buf = Buffer.from(`\uFEFF${KILELE_HEADER}\nCT-1,A,a@x.test,,KE,Nairobi,2026-01-01T00:00:00Z,active,true,,,KILELE,\n`, "utf8");
    const { records, summary } = parseSeedFile(kilele, buf);
    expect(records).toHaveLength(1);
    expect(records[0].cols[0]).toBe("CT-1");
    expect(summary.records).toBe(1);
  });

  it("strips NUL bytes and flags had_nul", () => {
    const buf = Buffer.from(`${KILELE_HEADER}\nCT-1,Nul\0Byte,a@x.test,,KE,Nairobi,2026-01-01T00:00:00Z,active,true,,,KILELE,\nCT-2,Clean,b@x.test,,KE,,,,,,,KILELE,\n`, "utf8");
    const { records, summary } = parseSeedFile(kilele, buf);
    expect(records[0].hadNul).toBe(true);
    expect(records[0].cols[1]).toBe("NulByte");
    expect(records[0].cols.some((c) => c.includes("\0"))).toBe(false);
    expect(records[1].hadNul).toBe(false);
    expect(summary.hadNul).toBe(1);
  });

  it("reads a ; file with e_mail/mobile/pays headers into canonical order", () => {
    const d = dialect("marrakech-contacts.csv");
    const buf = Buffer.from(
      "external_id;full_name;e_mail;mobile;pays;city;signup_at;status;consent_marketing;deleted_at;suppressed_until;brand_code;notes\n" +
        "CT-9;Layla;l@x.test;+212 6;MA;Tanger;2026-03-17T18:22:17Z;active;TRUE;;;MARRAKECH;\n",
      "utf8",
    );
    const { records } = parseSeedFile(d, buf);
    expect(records[0].ncols).toBe(13);
    expect(records[0].cols).toEqual(["CT-9", "Layla", "l@x.test", "+212 6", "MA", "Tanger", "2026-03-17T18:22:17Z", "active", "TRUE", "", "", "MARRAKECH", ""]);
  });

  it("keeps a quoted comma inside one cell", () => {
    const buf = Buffer.from(`${KILELE_HEADER}\nCT-1,A,a@x.test,,KE,"Nairobi, Kenya",,,,,,KILELE,\n`, "utf8");
    const { records } = parseSeedFile(kilele, buf);
    expect(records[0].ncols).toBe(13);
    expect(records[0].cols[5]).toBe("Nairobi, Kenya");
  });

  it("keeps a quoted embedded newline as one record with row_no = its first line", () => {
    const buf = Buffer.from(
      `${KILELE_HEADER}\nCT-1,A,a@x.test,,KE,,,,,,,KILELE,"VIP customer\nfollow up"\nCT-2,B,b@x.test,,KE,,,,,,,KILELE,\n`,
      "utf8",
    );
    const { records, summary } = parseSeedFile(kilele, buf);
    expect(records).toHaveLength(2);
    expect(records[0].cols[12]).toBe("VIP customer\nfollow up");
    expect(records[0].rowNo).toBe(2);
    expect(records[1].rowNo).toBe(4);
    expect(summary.multiLine).toBe(1);
  });

  it("records ncols for ragged rows and keeps their raw order; blank lines are skipped and counted", () => {
    const buf = Buffer.from(
      `${KILELE_HEADER}\nCT-1,A,a@x.test,,KE,Nairobi,x\n\n\nCT-2,B,b@x.test,,KE,Nairobi,x,y,z\n${KILELE_HEADER}\n`,
      "utf8",
    );
    const { records, summary } = parseSeedFile(kilele, buf);
    expect(records.map((r) => r.ncols)).toEqual([7, 9, 13]);
    expect(records[0].cols).toEqual(["CT-1", "A", "a@x.test", "", "KE", "Nairobi", "x"]);
    expect(records[0].rowNo).toBe(2);
    expect(records[1].rowNo).toBe(5);
    // the repeated header is a normal 13-column record (SQL rejects it, not TS)
    expect(records[2].cols[0]).toBe("external_id");
    expect(records[2].rowNo).toBe(6);
    expect(summary.ragged).toBe(2);
    expect(summary.blankLinesSkipped).toBe(2);
    expect(summary.records).toBe(3);
  });

  it("reorders the Karoo title-case layout into canonical order", () => {
    const d = dialect("karoo-contacts.csv");
    const buf = Buffer.from(
      "Full Name,Email,External Id,Phone,Country,Status,City,Signup At,Consent Marketing,Brand Code,Deleted At,Suppressed Until,Notes\n" +
        "Johan Wafula,j@x.test,CT-5760,254-731,ZA,active,Gqeberha,2026-02-06T15:39:07Z,no,KAROO,,,note\n",
      "latin1",
    );
    const { records } = parseSeedFile(d, buf);
    expect(records[0].cols).toEqual(["CT-5760", "Johan Wafula", "j@x.test", "254-731", "ZA", "Gqeberha", "2026-02-06T15:39:07Z", "active", "no", "", "", "KAROO", "note"]);
  });

  it("does not reorder a ragged Karoo row", () => {
    const d = dialect("karoo-contacts.csv");
    const buf = Buffer.from(
      "Full Name,Email,External Id,Phone,Country,Status,City,Signup At,Consent Marketing,Brand Code,Deleted At,Suppressed Until,Notes\n" +
        "Johan Wafula,j@x.test,CT-5760,254-731\n",
      "latin1",
    );
    const { records } = parseSeedFile(d, buf);
    expect(records[0].ncols).toBe(4);
    expect(records[0].cols).toEqual(["Johan Wafula", "j@x.test", "CT-5760", "254-731"]);
  });

  it("turns a decimal comma into a point only in declared columns", () => {
    const d = dialect("marrakech-campaigns.csv");
    const buf = Buffer.from(
      "external_id;campaign_name;channel;target_country;reported_sent;reported_delivered;reported_bounced;reported_opens;reported_clicks;spend;sent_at_utc;send_local_time;parent_campaign_id\n" +
        "MAR-1;Campagne 1,5;sms;;282;267;15;93;42;221,09;2026-03-21T21:37:05Z;2026-03-21 22:37;\n",
      "utf8",
    );
    const { records } = parseSeedFile(d, buf);
    expect(records[0].cols[9]).toBe("221.09");
    expect(records[0].cols[1]).toBe("Campagne 1,5");
  });

  it("decodes windows-1252 (0x96 → en dash)", () => {
    const d = dialect("karoo-contacts.csv");
    const header = Buffer.from("Full Name,Email,External Id,Phone,Country,Status,City,Signup At,Consent Marketing,Brand Code,Deleted At,Suppressed Until,Notes\n", "latin1");
    const row = Buffer.concat([Buffer.from([0x41, 0x6e, 0x6e, 0x96]), Buffer.from(",a@x.test,CT-1,,ZA,active,,,,KAROO,,,\n", "latin1")]);
    const { records } = parseSeedFile(d, Buffer.concat([header, row]));
    expect(records[0].cols[1]).toBe("Ann–");
  });

  it("throws on an invalid UTF-8 byte in a utf-8 dialect (wrong encoding, never a silent fallback)", () => {
    const buf = Buffer.concat([Buffer.from(`${KILELE_HEADER}\nCT-1,Ann`, "utf8"), Buffer.from([0x96]), Buffer.from(",a@x.test\n", "utf8")]);
    expect(() => parseSeedFile(kilele, buf)).toThrow();
  });

  it("throws when a canonical column is missing from the header", () => {
    const buf = Buffer.from("external_id,full_name\nCT-1,A\n", "utf8");
    expect(() => parseSeedFile(kilele, buf)).toThrow(/email/);
  });

  it("trims surrounding spaces, tabs, CR and LF from every cell", () => {
    const buf = Buffer.from(`${KILELE_HEADER}\r\n CT-1 ,\tA\t,a@x.test ,,KE,,,,,,,KILELE,\r\n`, "utf8");
    const { records } = parseSeedFile(kilele, buf);
    expect(records[0].cols[0]).toBe("CT-1");
    expect(records[0].cols[1]).toBe("A");
    expect(records[0].cols[2]).toBe("a@x.test");
    expect(records[0].ncols).toBe(13);
  });
});

describe("COPY encoding", () => {
  it("builds a Postgres text[] literal with every element quoted", () => {
    expect(toArrayLiteral([])).toBe("{}");
    expect(toArrayLiteral(["", "a"])).toBe('{"","a"}');
    expect(toArrayLiteral(['He said "hi"'])).toBe('{"He said \\"hi\\""}');
    expect(toArrayLiteral(["back\\slash"])).toBe('{"back\\\\slash"}');
    expect(toArrayLiteral(["NULL"])).toBe('{"NULL"}');
  });

  it("CSV-quotes the array literal (story example) and writes one line per record", () => {
    const line = toCopyLine(
      { runId: "00000000-0000-0000-0000-000000000001", sourceFile: "kilele-contacts.csv", fileBrand: "KILELE", asOf: "2026-08-01", fileRank: 10 },
      { rowNo: 2, ncols: 1, cols: ['He said "hi"'], hadNul: true },
    );
    expect(line).toBe('00000000-0000-0000-0000-000000000001,"kilele-contacts.csv","KILELE",2,1,"{""He said \\""hi\\""""}",t,2026-08-01,10\n');
  });

  it("keeps a newline inside the quoted cols field", () => {
    const line = toCopyLine(
      { runId: "00000000-0000-0000-0000-000000000001", sourceFile: "f.csv", fileBrand: "KILELE", asOf: "2026-08-01", fileRank: 10 },
      { rowNo: 750, ncols: 1, cols: ["VIP customer\nfollow up"], hadNul: false },
    );
    expect(line).toContain('"{""VIP customer\nfollow up""}",f,');
  });
});

describe("pnpm seed flags", () => {
  it("parses --only / --sample / --file and rejects unknown values", async () => {
    const { parseArgs } = await import("@/scripts/seed/index");
    expect(parseArgs([])).toEqual({ only: "all" });
    expect(parseArgs(["--only=stage", "--sample=10", "--file=kilele-contacts.csv"])).toEqual({ only: "stage", sample: 10, file: "kilele-contacts.csv" });
    expect(() => parseArgs(["--only=events"])).toThrow(/--only/);
    expect(() => parseArgs(["--sample=ten"])).toThrow(/--sample/);
    expect(() => parseArgs(["--file=nope.csv"])).toThrow(/--file/);
    expect(() => parseArgs(["--truncate"])).toThrow(/unknown argument/);
    // Story 2.3: the import step
    expect(parseArgs(["--only=import"])).toEqual({ only: "import" });
    expect(parseArgs(["--only=import", "--entity=contacts"])).toEqual({ only: "import", entity: "contacts" });
    expect(() => parseArgs(["--entity=users"])).toThrow(/--entity/);
    expect(() => parseArgs(["--only=import", "--entity=campaigns"])).toThrow(/Story 2\.4/);
  });
});
