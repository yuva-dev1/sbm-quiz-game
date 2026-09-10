import { describe, expect, it } from "vitest";
import {
  BASE_POINTS,
  computeCorrectFraction,
  computePoints,
  computeRawReactionTimeMs,
  computeTrueReactionTimeMs,
} from "@/lib/scoring";

describe("computeRawReactionTimeMs", () => {
  it("is the wall-clock gap between broadcast and receipt", () => {
    expect(computeRawReactionTimeMs(1_000_010_000, 1_000_000_000)).toBe(10_000);
  });

  it("can be negative if inputs are malformed (caller/clamp responsibility, not this function's)", () => {
    expect(computeRawReactionTimeMs(1_000_000_000, 1_000_010_000)).toBe(-10_000);
  });
});

describe("computeTrueReactionTimeMs", () => {
  const timeLimitMs = 20_000;

  it("subtracts half the estimated latency", () => {
    // 5000ms raw, 2000ms latency -> 5000 - 1000 = 4000
    expect(computeTrueReactionTimeMs(5_000, 2_000, timeLimitMs)).toBe(4_000);
  });

  it("clamps to 0 when latency compensation would go negative", () => {
    // 500ms raw, 2000ms latency -> 500 - 1000 = -500 -> clamp to 0
    expect(computeTrueReactionTimeMs(500, 2_000, timeLimitMs)).toBe(0);
  });

  it("clamps to timeLimit when reaction time exceeds it even after compensation", () => {
    expect(computeTrueReactionTimeMs(30_000, 0, timeLimitMs)).toBe(timeLimitMs);
  });

  it("passes through unchanged with zero latency and an in-range reaction time", () => {
    expect(computeTrueReactionTimeMs(8_000, 0, timeLimitMs)).toBe(8_000);
  });
});

describe("computePoints", () => {
  const timeLimitMs = 20_000;

  it("scores 0 for a zero-credit answer regardless of speed", () => {
    expect(computePoints(0, 0, timeLimitMs)).toBe(0);
    expect(computePoints(0, timeLimitMs, timeLimitMs)).toBe(0);
  });

  it("scores 0 for a negative correctFraction (more wrong picks than right)", () => {
    expect(computePoints(-0.5, 0, timeLimitMs)).toBe(0);
  });

  it("scores full BASE_POINTS for a fully correct, instant answer", () => {
    expect(computePoints(1, 0, timeLimitMs)).toBe(BASE_POINTS);
  });

  it("scores half of BASE_POINTS for a fully correct answer at exactly the deadline", () => {
    // round(1000 * (1 - (20000/20000)/2)) = round(1000 * 0.5) = 500
    expect(computePoints(1, timeLimitMs, timeLimitMs)).toBe(500);
  });

  it("scores 3/4 of BASE_POINTS for a fully correct answer at the halfway point", () => {
    // round(1000 * (1 - (10000/20000)/2)) = round(1000 * 0.75) = 750
    expect(computePoints(1, timeLimitMs / 2, timeLimitMs)).toBe(750);
  });

  it("matches a hand-calculated non-round-number case", () => {
    // timeLimit=15000, trueReactionTime=6000
    // round(1000 * (1 - (6000/15000)/2)) = round(1000 * (1 - 0.2)) = round(800) = 800
    expect(computePoints(1, 6_000, 15_000)).toBe(800);
  });

  it("defaults to SPEED mode when no mode is passed", () => {
    expect(computePoints(1, timeLimitMs, timeLimitMs)).toBe(500);
  });

  it("scales points linearly for a partial-credit multi-select answer", () => {
    // half credit at the instant-answer full value of 1000 -> 500
    expect(computePoints(0.5, 0, timeLimitMs)).toBe(500);
  });

  describe("ACCURACY mode", () => {
    it("scores flat BASE_POINTS for a fully correct answer regardless of speed", () => {
      expect(computePoints(1, 0, timeLimitMs, "ACCURACY")).toBe(BASE_POINTS);
      expect(computePoints(1, timeLimitMs, timeLimitMs, "ACCURACY")).toBe(BASE_POINTS);
    });

    it("scores 0 for a zero-credit answer regardless of speed", () => {
      expect(computePoints(0, 0, timeLimitMs, "ACCURACY")).toBe(0);
      expect(computePoints(0, timeLimitMs, timeLimitMs, "ACCURACY")).toBe(0);
    });

    it("scales flat BASE_POINTS by a partial correctFraction", () => {
      expect(computePoints(0.5, 0, timeLimitMs, "ACCURACY")).toBe(500);
    });
  });
});

describe("computeCorrectFraction", () => {
  const choices = ["A", "B", "C", "D"];

  it("scores 1 for a single-select question answered correctly", () => {
    expect(computeCorrectFraction(choices, ["B"], [1])).toBe(1);
  });

  it("scores 0 for a single-select question answered incorrectly", () => {
    expect(computeCorrectFraction(choices, ["B"], [0])).toBe(0);
  });

  it("scores 1 for a multi-select question with every correct choice picked and nothing else", () => {
    expect(computeCorrectFraction(choices, ["A", "C"], [0, 2])).toBe(1);
  });

  it("gives pro-rata credit for picking only some of the correct choices and nothing wrong", () => {
    // 1 correct pick, 0 incorrect, out of 2 correct total -> 1/2 = 0.5
    expect(computeCorrectFraction(choices, ["A", "C"], [0])).toBe(0.5);
    // 2 correct picks, 0 incorrect, out of 3 correct total -> 2/3
    expect(computeCorrectFraction(["A", "B", "C", "D"], ["A", "B", "C"], [0, 1])).toBeCloseTo(2 / 3);
  });

  it("scores 0 when any incorrect choice is picked alongside correct ones", () => {
    // 1 correct (A), 1 incorrect (B) -> any wrong pick zeroes the answer
    expect(computeCorrectFraction(choices, ["A", "C"], [0, 1])).toBe(0);
  });

  it("scores 0 for every correct choice plus one wrong one (no partial credit for a superset)", () => {
    // A,B,C are correct; picking A,B,C,D adds a wrong pick -> 0, not 2/3
    expect(computeCorrectFraction(["A", "B", "C", "D"], ["A", "B", "C"], [0, 1, 2, 3])).toBe(0);
  });

  it("scores 0 when incorrect picks outweigh correct ones", () => {
    // 0 correct, 2 incorrect (B, D) -> 0
    expect(computeCorrectFraction(choices, ["A"], [1, 3])).toBe(0);
  });
});
