import { describe, it, expect } from "vitest";
import { formatDriftRate, formatWatchLabel } from "./format";

describe("formatDriftRate", () => {
  it("renders null/NaN/Infinity as em-dash", () => {
    expect(formatDriftRate(null)).toBe("—");
    expect(formatDriftRate(Number.NaN)).toBe("—");
    expect(formatDriftRate(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("renders 0 without a sign", () => {
    expect(formatDriftRate(0)).toBe("0.0 s/d");
  });

  it("renders a positive rate with a leading +", () => {
    expect(formatDriftRate(0.5)).toBe("+0.5 s/d");
    expect(formatDriftRate(12.345)).toBe("+12.3 s/d");
  });

  it("renders a negative rate with a leading -", () => {
    expect(formatDriftRate(-1.2)).toBe("-1.2 s/d");
  });
});

describe("formatWatchLabel", () => {
  it("prefers Brand + Model when both exist", () => {
    expect(formatWatchLabel({ name: "n", brand: "Rolex", model: "126610LN" })).toBe(
      "Rolex 126610LN",
    );
  });

  it("falls back to name when brand+model are both null", () => {
    expect(formatWatchLabel({ name: "My Watch", brand: null, model: null })).toBe(
      "My Watch",
    );
  });

  it("uses just brand when model is missing", () => {
    expect(formatWatchLabel({ name: "n", brand: "Omega", model: null })).toBe("Omega");
  });
});
