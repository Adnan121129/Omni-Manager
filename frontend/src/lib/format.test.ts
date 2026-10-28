import { afterEach, describe, expect, it } from "vitest";

import {
  daysUntil,
  fileSize,
  formatClock,
  formatDate,
  formatDuration,
  formatHours,
  formatMoney,
  formatMoneyList,
  isoDate,
  percent,
  setDisplayTimeZone,
  titleCase,
} from "./format";

afterEach(() => setDisplayTimeZone(undefined));

describe("formatMoney", () => {
  it("formats decimal strings from the API with two decimals", () => {
    expect(formatMoney("1234.5", "USD")).toMatch(/1,234\.50/);
    expect(formatMoney("0.10", "EUR")).toMatch(/0\.10/);
  });

  it("returns a dash for missing or invalid values", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney("")).toBe("—");
    expect(formatMoney("not-a-number")).toBe("—");
  });

  it("uses the currency of the amount", () => {
    expect(formatMoney("10", "GBP")).toContain("£");
    expect(formatMoney("10", "EUR")).toContain("€");
  });
});

describe("formatMoneyList", () => {
  it("lists each currency separately instead of summing across currencies", () => {
    const text = formatMoneyList([
      { currency: "USD", amount: "100.00" },
      { currency: "EUR", amount: "50.00" },
    ]);
    expect(text).toContain("$100.00");
    expect(text).toContain("€50.00");
    expect(text).toContain(" · ");
  });

  it("uses the empty label when there is nothing", () => {
    expect(formatMoneyList([], { empty: "Nothing due" })).toBe("Nothing due");
  });
});

describe("durations", () => {
  it("formats seconds as hours and minutes", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(45 * 60)).toBe("45m");
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe("3h 05m");
    expect(formatDuration(-20)).toBe("0m");
  });

  it("formats a running clock", () => {
    expect(formatClock(3723)).toBe("01:02:03");
    expect(formatClock(59.9)).toBe("00:00:59");
  });

  it("formats decimal hours", () => {
    expect(formatHours("24")).toBe("24h");
    expect(formatHours(1.25, 2)).toBe("1.25h");
    expect(formatHours(null)).toBe("—");
  });
});

describe("dates", () => {
  it("keeps plain calendar dates on the same day regardless of display timezone", () => {
    setDisplayTimeZone("Pacific/Kiritimati");
    expect(formatDate("2026-03-01")).toMatch(/Mar 1, 2026/);
    setDisplayTimeZone("Pacific/Pago_Pago");
    expect(formatDate("2026-03-01")).toMatch(/Mar 1, 2026/);
  });

  it("converts instants to the display timezone", () => {
    setDisplayTimeZone("Asia/Tokyo");
    expect(formatDate("2026-03-01T20:00:00Z")).toMatch(/Mar 2, 2026/);
    setDisplayTimeZone("America/New_York");
    expect(formatDate("2026-03-01T03:00:00Z")).toMatch(/Feb 28, 2026/);
  });

  it("counts days until a due date", () => {
    const today = new Date(2026, 9, 19);
    expect(daysUntil("2026-10-19", today)).toBe(0);
    expect(daysUntil("2026-10-22", today)).toBe(3);
    expect(daysUntil("2026-10-14", today)).toBe(-5);
    expect(daysUntil(null, today)).toBeNull();
  });

  it("produces local ISO dates", () => {
    expect(isoDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("misc", () => {
  it("formats percent, labels and file sizes", () => {
    expect(percent("82.4")).toBe("82%");
    expect(percent(null)).toBe("—");
    expect(titleCase("partially_paid")).toBe("Partially Paid");
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2 KB");
    expect(fileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
