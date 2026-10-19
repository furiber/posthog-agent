import { z } from "zod";

/** POST /run body. pageBudget is capped (hard max 200) by the run handler. */
export const RunRequestSchema = z.object({
  url: z
    .url()
    .refine(
      (value) => {
        try {
          const u = new URL(value);
          if (u.protocol !== "https:" && u.protocol !== "http:") return false;
          return !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(u.hostname);
        } catch {
          return false;
        }
      },
      { message: "url must be a public http(s) URL" },
    ),
  pageBudget: z.number().int().min(1).max(200).optional(),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;

export const RunResponseMetaSchema = z.object({
  runId: z.string(),
  site: z.string(),
  pageBudget: z.number(),
});

export type RunResponseMeta = z.infer<typeof RunResponseMetaSchema>;
