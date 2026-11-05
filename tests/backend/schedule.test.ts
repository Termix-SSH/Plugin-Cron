import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  isValidSchedule,
  nextRuns,
  parseField,
} from "../../src/shared/schedule.js";

describe("schedule parsing", () => {
  it("accepts common schedules", () => {
    for (const expr of [
      "* * * * *",
      "*/5 * * * *",
      "0 3 * * *",
      "0 3 * * 1-5",
      "15,45 8-18/2 1 jan,jul mon",
      "0 0 1 1 7",
      "@daily",
      "@reboot",
      "5/10 * * * *",
    ]) {
      expect(isValidSchedule(expr), expr).toBe(true);
    }
  });

  it("refuses broken schedules", () => {
    for (const expr of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "*/0 * * * *",
      "5-1 * * * *",
      "@sometimes",
      "a b c d e",
      "* * * * * *",
    ]) {
      expect(isValidSchedule(expr), expr).toBe(false);
    }
  });

  it("expands steps and ranges", () => {
    expect([...parseField("*/15", 0, 59)!]).toEqual([0, 15, 30, 45]);
    expect([...parseField("1-5/2", 0, 59)!]).toEqual([1, 3, 5]);
    expect(parseField("10-5", 0, 59)).toBeNull();
  });
});

describe("next runs", () => {
  const from = new Date("2026-11-04T10:30:20Z");

  it("finds the next times in UTC", () => {
    expect(nextRuns("0 3 * * *", from, 2).map((d) => d.toISOString())).toEqual([
      "2026-11-05T03:00:00.000Z",
      "2026-11-06T03:00:00.000Z",
    ]);
    expect(nextRuns("*/15 * * * *", from, 1)[0].toISOString()).toBe(
      "2026-11-04T10:45:00.000Z",
    );
  });

  it("uses the host offset", () => {
    // 03:00 at UTC+1 is 02:00 UTC.
    expect(nextRuns("0 3 * * *", from, 1, 60)[0].toISOString()).toBe(
      "2026-11-05T02:00:00.000Z",
    );
  });

  it("runs on either day when both day fields are set", () => {
    // 1st of the month or a Friday. Nov 6 2026 is a Friday.
    const runs = nextRuns("0 0 1 * 5", from, 3).map((d) =>
      d.toISOString().slice(0, 10),
    );
    expect(runs).toEqual(["2026-11-06", "2026-11-13", "2026-11-20"]);
  });

  it("has no times for @reboot", () => {
    expect(nextRuns("@reboot", from, 3)).toEqual([]);
  });
});

describe("summary", () => {
  it("puts common schedules into words", () => {
    expect(describeSchedule("* * * * *").key).toBe("everyMinute");
    expect(describeSchedule("*/5 * * * *")).toEqual({
      key: "everyNMinutes",
      values: { n: 5 },
    });
    expect(describeSchedule("0 3 * * *")).toEqual({
      key: "dailyAt",
      values: { time: "03:00" },
    });
    expect(describeSchedule("30 6 * * 1-5").key).toBe("weekdaysAt");
    expect(describeSchedule("0 9 * * mon")).toEqual({
      key: "weeklyAt",
      values: { day: 1, time: "09:00" },
    });
    expect(describeSchedule("0 4 15 * *").key).toBe("monthlyAt");
    expect(describeSchedule("@daily").key).toBe("dailyAt");
    expect(describeSchedule("@reboot").key).toBe("reboot");
    expect(describeSchedule("0 3 1 jan *").key).toBe("custom");
    expect(describeSchedule("nope").key).toBe("invalid");
  });
});
