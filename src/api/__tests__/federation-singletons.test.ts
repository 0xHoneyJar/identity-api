/**
 * federation-singletons.test.ts — verify the lazy-build + test-seam contract of
 * the 3 federation port singletons (T2.1).
 *
 * Mirrors the implicit pattern at src/api/spine.ts (and the convention every
 * downstream test that needs spine seams already uses). These tests give the
 * federation-port singletons the same documented behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
// Mocks live under the adapters package's __tests__/ test seam (not exported
// via the package barrel — they're a test-only surface). Reach them via
// relative path so the import doesn't depend on path-mapping that's scoped
// to the package-export contract.
import { MockInventoryPort } from "../../../packages/adapters/src/__tests__/mock-inventory"
import { MockScorePort } from "../../../packages/adapters/src/__tests__/mock-score"
import { MockCodexPort } from "../../../packages/adapters/src/__tests__/mock-codex"
import {
  getInventory,
  __setInventoryForTest,
  __resetInventoryForTest,
} from "../inventory"
import {
  getScore,
  __setScoreForTest,
  __resetScoreForTest,
} from "../score"
import {
  getCodex,
  __setCodexForTest,
  __resetCodexForTest,
} from "../codex"

describe("federation singletons (T2.1)", () => {
  afterEach(() => {
    __resetInventoryForTest()
    __resetScoreForTest()
    __resetCodexForTest()
  })

  describe("inventory singleton", () => {
    it("getInventory returns a built adapter on first call (no DATABASE_URL-style fail-fast)", () => {
      const port = getInventory()
      expect(port).toBeDefined()
      expect(typeof port.getHoldings).toBe("function")
    })

    it("getInventory is cached: second call returns same instance", () => {
      const a = getInventory()
      const b = getInventory()
      expect(a).toBe(b)
    })

    it("__setInventoryForTest installs a mock that getInventory returns", () => {
      const mock = new MockInventoryPort()
      __setInventoryForTest(mock)
      const port = getInventory()
      expect(port).toBe(mock)
    })

    it("__resetInventoryForTest clears the cache (next call rebuilds)", () => {
      const mock = new MockInventoryPort()
      __setInventoryForTest(mock)
      expect(getInventory()).toBe(mock)
      __resetInventoryForTest()
      const port = getInventory()
      expect(port).not.toBe(mock)
    })
  })

  describe("score singleton", () => {
    it("getScore returns a built adapter on first call", () => {
      const port = getScore()
      expect(port).toBeDefined()
      expect(typeof port.getScore).toBe("function")
    })

    it("is cached + has test seam", () => {
      const mock = new MockScorePort()
      __setScoreForTest(mock)
      expect(getScore()).toBe(mock)
      __resetScoreForTest()
      expect(getScore()).not.toBe(mock)
    })
  })

  describe("codex singleton", () => {
    it("getCodex returns a built adapter on first call", () => {
      const port = getCodex()
      expect(port).toBeDefined()
      expect(typeof port.getMiberaTraits).toBe("function")
    })

    it("is cached + has test seam", () => {
      const mock = new MockCodexPort()
      __setCodexForTest(mock)
      expect(getCodex()).toBe(mock)
      __resetCodexForTest()
      expect(getCodex()).not.toBe(mock)
    })
  })
})
