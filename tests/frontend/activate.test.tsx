import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

const status = {
  os: "Debian GNU/Linux 13",
  user: "deploy",
  root: true,
  installed: true,
  running: true,
  timezone: "UTC",
  offsetMinutes: 0,
  users: ["deploy", "root"],
  canEdit: true,
  readOnly: false,
};

const jobs = {
  user: "",
  raw: "",
  jobs: [
    {
      id: "aaaaaaaa",
      enabled: true,
      schedule: "0 3 * * *",
      command: "/opt/backup.sh",
      label: "Nightly backup",
    },
    {
      id: "bbbbbbbb",
      enabled: false,
      schedule: "*/5 * * * *",
      command: "/opt/check.sh",
      label: "",
    },
  ],
};

function api(current: unknown) {
  return {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith("/status")
        ? current
        : url.includes("/jobs")
          ? jobs
          : url.includes("/system")
            ? {
                files: [],
                scripts: {
                  hourly: [],
                  daily: ["logrotate"],
                  weekly: [],
                  monthly: [],
                },
                timers: 3,
              }
            : { text: "", source: "none" },
    })),
  } as never;
}

const host = { id: 1, name: "web", enableSsh: true };

describe(`${manifest.id} activate`, () => {
  it("registers the host tab", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.tabs()).toEqual(["cron"]);
  });

  it("registers its dashboard card and shows cron state per host", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["cron.use"],
      hosts: [{ id: "1", name: "web", ip: "10.0.0.1", port: 22 }],
      api: {
        get: vi.fn(async () => ({
          data: [
            {
              hostId: 1,
              checkedAt: "2026-11-05T00:00:00.000Z",
              installed: true,
              running: false,
              jobs: 3,
              disabled: 1,
            },
          ],
        })),
      } as never,
    });
    expect(rendered.registered.dashboardCards()).toEqual(["cron-hosts"]);
    rendered.renderDashboardCard("cron-hosts");
    expect(await screen.findByText("web")).toBeTruthy();
    expect(screen.getByText(locales.card.stopped)).toBeTruthy();
  });

  it("lists jobs with their schedule in words", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("cron", { isVisible: true, host });
    expect(await screen.findByText("Nightly backup")).toBeTruthy();
    expect(screen.getByText("/opt/check.sh")).toBeTruthy();
    expect(screen.getByText(locales.jobs.off)).toBeTruthy();
    expect(screen.getAllByText(/Every day at 03:00/).length).toBeGreaterThan(0);
  });

  it("opens the job form", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("cron", { isVisible: true, host });
    fireEvent.click(await screen.findByText("Nightly backup"));
    expect(await screen.findByText(locales.form.editTitle)).toBeTruthy();
    expect(screen.getByDisplayValue("/opt/backup.sh")).toBeTruthy();
  });

  it("shows the system scripts", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api(status),
    });
    rendered.renderTab("cron", { isVisible: true, host });
    fireEvent.click(await screen.findByText(locales.tab.viewSystem));
    expect(await screen.findByText("logrotate")).toBeTruthy();
  });

  it("explains when cron is missing", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: api({ ...status, installed: false }),
    });
    rendered.renderTab("cron", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.notInstalledTitle)).toBeTruthy();
  });

  it("shows an error when the host cannot be read", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: {
        get: vi.fn(async () => {
          throw new Error("offline");
        }),
      } as never,
    });
    rendered.renderTab("cron", { isVisible: true, host });
    expect(await screen.findByText(locales.tab.error)).toBeTruthy();
  });
});
