import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  notionTemplateFixtureSchema,
  type NotionPropertyType,
  type NotionTemplateFixture,
} from "@/schemas/notion-template";

const fixturePath = path.resolve("tests/fixtures/notion/workspace.json");

const requiredTransactionProperties: Record<string, NotionPropertyType> = {
  Name: "title",
  "Transaction Date": "date",
  Type: "select",
  Category: "select",
  Account: "relation",
  "Billed Amount": "number",
  "Billed Currency": "select",
  Source: "select",
  "Import Batch": "relation",
  "Source Row ID": "rich_text",
  Fingerprint: "rich_text",
};

const requiredAccountProperties: Record<string, NotionPropertyType> = {
  "Account Name": "title",
  "Account Type": "select",
  "Last 4": "rich_text",
  "Primary Currency": "select",
  Active: "checkbox",
};

const requiredImportProperties: Record<string, NotionPropertyType> = {
  "Batch Name": "title",
  "Batch ID": "rich_text",
  "Statement Hash": "rich_text",
  Account: "relation",
  Status: "select",
  "Created On": "created_time",
  "Template Version": "rich_text",
};

let fixture: NotionTemplateFixture;

beforeAll(async () => {
  fixture = notionTemplateFixtureSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
});

describe("mock Notion workspace", () => {
  it("matches the versioned template contract", () => {
    expect(fixture.templateVersion).toBe("1.0.0");
    expect(fixture.dataSources.transactions.name).toBe("Transactions");
    expect(fixture.dataSources.accounts.name).toBe("Accounts");
    expect(fixture.dataSources.imports.name).toBe("Imports");
  });

  it("contains every required transaction property with the expected type", () => {
    for (const [name, type] of Object.entries(requiredTransactionProperties)) {
      expect(fixture.dataSources.transactions.properties[name]).toMatchObject({ type });
      expect(fixture.dataSources.transactions.properties[name].id).toBeTruthy();
    }
  });

  it("contains every required account and import property", () => {
    for (const [name, type] of Object.entries(requiredAccountProperties)) {
      expect(fixture.dataSources.accounts.properties[name]).toMatchObject({ type });
    }

    for (const [name, type] of Object.entries(requiredImportProperties)) {
      expect(fixture.dataSources.imports.properties[name]).toMatchObject({ type });
    }
  });

  it("exposes categories and active accounts for categorization and matching", () => {
    expect(fixture.categories).toContain("Groceries");
    expect(fixture.categories).toContain("Other");
    expect(fixture.accounts.some((account) => account.active)).toBe(true);
    expect(fixture.accounts.every((account) => account.last4?.length === 4)).toBe(true);
  });

  it("rejects a template missing a required data source", () => {
    const invalid = {
      ...fixture,
      dataSources: {
        transactions: fixture.dataSources.transactions,
        accounts: fixture.dataSources.accounts,
      },
    };

    expect(() => notionTemplateFixtureSchema.parse(invalid)).toThrow();
  });
});
