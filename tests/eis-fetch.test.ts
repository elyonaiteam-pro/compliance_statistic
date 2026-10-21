import { describe, expect, it } from "vitest";
import { createEisFetch } from "@/lib/eis-fetch.mjs";

describe("createEisFetch", () => {
  it("uses plain fetch when no proxy is configured", () => {
    expect(createEisFetch(undefined)).toBe(fetch);
    expect(createEisFetch("")).toBe(fetch);
    expect(createEisFetch("   ")).toBe(fetch);
  });

  it("returns a dedicated, cached fetch when a proxy is configured", () => {
    const a = createEisFetch("http://user:pass@127.0.0.1:3128");
    const b = createEisFetch(" http://user:pass@127.0.0.1:3128 ");
    expect(a).not.toBe(fetch);
    expect(a).toBe(b);
    expect(createEisFetch("http://127.0.0.1:9999")).not.toBe(a);
  });

  it("actually sends requests through the proxy (CONNECT tunnel), never straight to the target", async () => {
    const http = await import("node:http");
    const seen: string[] = [];
    // A fake proxy that records the tunnel request and refuses it — no real network involved.
    const proxy = http.createServer();
    proxy.on("connect", (req, socket) => {
      seen.push(`CONNECT ${req.url}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const { port } = proxy.address() as { port: number };
    try {
      const proxied = createEisFetch(`http://127.0.0.1:${port}`);
      await expect(proxied("https://zakupki.gov.ru/")).rejects.toThrow();
      expect(seen).toEqual(["CONNECT zakupki.gov.ru:443"]);
    } finally {
      proxy.close();
    }
  });
});
