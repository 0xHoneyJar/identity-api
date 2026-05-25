/**
 * http-inventory-adapter.test.ts — adapter-specific shape tests (T2.1).
 *
 * The shared `federationHttpCall` helper has its own test suite covering
 * the 6 failure classifications + AbortSignal handling. Here we verify
 * the inventory-specific contract: URL shape, response Zod validation
 * against a realistic body, default baseUrl, override via config.
 */

import { describe, expect, it } from "bun:test"
import {
  HttpInventoryAdapter,
  DEFAULT_INVENTORY_BASE_URL,
} from "../http-inventory-adapter"

const SAMPLE_RESP = {
  holdings: [
    {
      contractAddress: "0x6666397dfe9a8c469bf65dc744cb1c733416c420",
      chainId: 80094,
      tokenCount: 2,
      tokenIds: ["42", "777"],
    },
  ],
  completeness: {
    as_of_block: 12345,
    holder_count: 9001,
    source: "sonar" as const,
    complete: true as const,
  },
}

describe("HttpInventoryAdapter (T2.1)", () => {
  it("default baseUrl per registry.yaml", () => {
    const adapter = new HttpInventoryAdapter()
    expect(adapter.baseUrl).toBe(DEFAULT_INVENTORY_BASE_URL)
    expect(DEFAULT_INVENTORY_BASE_URL).toBe("https://inventory.0xhoneyjar.xyz")
  })

  it("baseUrl override + trailing-slash normalization", () => {
    const adapter = new HttpInventoryAdapter({ baseUrl: "https://test.local/" })
    expect(adapter.baseUrl).toBe("https://test.local")
  })

  it("getHoldings calls GET /v1/holdings/:wallet on the configured baseUrl", async () => {
    let observedUrl = ""
    let observedMethod = ""
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      observedUrl = typeof input === "string" ? input : input.toString()
      observedMethod = init?.method ?? "GET"
      return new Response(JSON.stringify(SAMPLE_RESP), { status: 200 })
    }
    const adapter = new HttpInventoryAdapter({ baseUrl: "https://test.local" })
    const res = await adapter.getHoldings(
      { walletAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" },
      { fetchImpl: stub },
    )
    expect(observedMethod).toBe("GET")
    expect(observedUrl).toBe(
      "https://test.local/v1/holdings/0xAbCdEf0123456789AbCdEf0123456789AbCdEf01",
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.holdings.length).toBe(1)
  })

  it("validates the response against the InventoryGetHoldingsResp schema", async () => {
    const malformed = { holdings: "not-an-array", completeness: SAMPLE_RESP.completeness }
    const stub = async () => new Response(JSON.stringify(malformed), { status: 200 })
    const adapter = new HttpInventoryAdapter()
    const res = await adapter.getHoldings(
      { walletAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("parse_error")
  })

  it("404 → not_found", async () => {
    const stub = async () => new Response("not found", { status: 404 })
    const adapter = new HttpInventoryAdapter()
    const res = await adapter.getHoldings(
      { walletAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.kind).toBe("not_found")
  })

  it("preserves the 'degraded' completeness shape (string union member)", async () => {
    const degraded = {
      holdings: [],
      completeness: {
        as_of_block: 0,
        holder_count: 0,
        source: "sonar" as const,
        complete: "degraded" as const,
      },
    }
    const stub = async () => new Response(JSON.stringify(degraded), { status: 200 })
    const adapter = new HttpInventoryAdapter()
    const res = await adapter.getHoldings(
      { walletAddress: "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01" },
      { fetchImpl: stub },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.completeness.complete).toBe("degraded")
  })
})
