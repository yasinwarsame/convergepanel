import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const EchoSchema = z.object({
  message: z.string().min(1).max(200),
  times: z.number().int().min(1).max(5).optional().default(1),
});

function methodNotAllowed() {
  return NextResponse.json({ error: "Method Not Allowed" }, { status: 405 });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const PATCH = methodNotAllowed;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => {
      throw new Error("INVALID_JSON");
    });

    const { message, times } = EchoSchema.parse(body);
    const echoed = Array(times).fill(message).join(" ");

    return NextResponse.json({ echoed }, { status: 200 });
  } catch (err) {
    // Requirements: always return 400 + { error: "Invalid input" } for invalid requests
    if (err instanceof z.ZodError || (err as Error)?.message === "INVALID_JSON") {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    // Keep unexpected errors from leaking details; still follow the invalid input contract if you prefer.
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
}
