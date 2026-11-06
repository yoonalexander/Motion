import { z } from "zod";
import { currencyCodeSchema } from "./transaction";

export const notionPropertyTypeSchema = z.enum([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "date",
  "relation",
  "checkbox",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "formula",
  "rollup",
  "status",
  "unique_id",
  "url",
  "email",
  "phone_number",
]);

export const notionPropertySchema = z
  .object({
    id: z.string().min(1),
    type: notionPropertyTypeSchema,
  })
  .strict();

export const notionDataSourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    properties: z.record(z.string().min(1), notionPropertySchema),
  })
  .strict();

export const notionTemplateSchema = z
  .object({
    templateVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Expected a semantic version"),
    workspaceId: z.string().min(1),
    dataSources: z
      .object({
        transactions: notionDataSourceSchema,
        accounts: notionDataSourceSchema,
        imports: notionDataSourceSchema,
      })
      .strict(),
  })
  .strict();

export const mockNotionAccountSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    currency: currencyCodeSchema,
    type: z.enum(["credit_card", "chequing", "savings"]),
    last4: z
      .string()
      .regex(/^\d{4}$/, "Expected the last four account digits")
      .optional(),
    active: z.boolean(),
  })
  .strict();

export const notionTemplateFixtureSchema = notionTemplateSchema
  .extend({
    categories: z.array(z.string().min(1)).min(1),
    accounts: z.array(mockNotionAccountSchema).min(1),
  })
  .strict();

export type NotionPropertyType = z.infer<typeof notionPropertyTypeSchema>;
export type NotionProperty = z.infer<typeof notionPropertySchema>;
export type NotionDataSource = z.infer<typeof notionDataSourceSchema>;
export type NotionTemplate = z.infer<typeof notionTemplateSchema>;
export type MockNotionAccount = z.infer<typeof mockNotionAccountSchema>;
export type NotionTemplateFixture = z.infer<typeof notionTemplateFixtureSchema>;
