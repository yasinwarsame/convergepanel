import { z } from "zod";

export const echoRequestSchema = z.object({
  message: z.string().min(1).max(200),
  times: z.number().int().min(1).max(5).optional().default(1),
});

export type EchoRequest = z.infer<typeof echoRequestSchema>;
