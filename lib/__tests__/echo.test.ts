import { POST, GET, PUT, DELETE, PATCH } from "@/app/api/echo/route";
import { NextRequest } from "next/server";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/echo", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("/api/echo", () => {
  it("echoes once by default", async () => {
    const req = makeRequest({ message: "hello" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ echoed: "hello" });
  });

  it("echoes message N times separated by spaces", async () => {
    const req = makeRequest({ message: "hi", times: 3 });
    const res = await POST(req);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ echoed: "hi hi hi" });
  });

  it("returns 400 for invalid input (empty message)", async () => {
    const req = makeRequest({ message: "" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid input" });
  });

  it("returns 400 for invalid input (times out of range)", async () => {
    const req = makeRequest({ message: "ok", times: 10 });
    const res = await POST(req);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid input" });
  });

  it("returns 405 for non-POST methods", async () => {
    for (const handler of [GET, PUT, DELETE, PATCH]) {
      const res = await handler();
      expect(res.status).toBe(405);
      await expect(res.json()).resolves.toEqual({ error: "Method Not Allowed" });
    }
  });
});
