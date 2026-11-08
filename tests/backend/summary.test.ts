import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createSummaryCache } from "../../src/backend/summary.js";
import type { CronService } from "../../src/backend/service.js";

function setup(service: Partial<CronService>) {
  const ctx = {
    currentActor: () => "1",
    settings: { getAll: vi.fn(async () => ({ enableCron: true })) },
  } as unknown as PluginContext;
  return createSummaryCache(ctx, service as CronService);
}

describe("cron summary", () => {
  it("counts jobs and disabled jobs", async () => {
    const cache = setup({
      status: vi.fn(async () => ({ installed: true, running: true })) as never,
      crontab: vi.fn(async () => ({
        jobs: [{ enabled: true }, { enabled: false }],
      })) as never,
    });
    const result = await cache.check(1);
    expect(result).toMatchObject({ jobs: 2, disabled: 1, running: true });
  });

  it("keeps a host error as a result and caches it", async () => {
    const status = vi.fn(async () => {
      throw new Error("offline");
    });
    const cache = setup({ status: status as never });
    expect((await cache.check(1)).error).toBe("offline");
    await cache.check(1);
    expect(status).toHaveBeenCalledTimes(1);
  });
});
