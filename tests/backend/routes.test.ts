import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./helpers";

let s: TestServer | null = null;

afterEach(async () => {
  await s?.close();
  s = null;
});

const STATUS = `os=Debian GNU/Linux 13 (trixie)
user=deploy
root=1
installed=1
running=1
offset=+0100
timezone=Europe/Berlin
tab=root
tab=deploy
tab=www-data
`;

const TAB = "# Backup\n0 3 * * * /opt/backup.sh\n*/5 * * * * /opt/check.sh\n";

describe("status", () => {
  it("reports cron and the users", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "installed=", stdout: STATUS });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      user: "deploy",
      root: true,
      running: true,
      timezone: "Europe/Berlin",
      offsetMinutes: 60,
      users: ["deploy", "root", "www-data"],
      canEdit: true,
    });
  });

  it("hides other users from connect only callers", async () => {
    s = await startServer({ level: "connect" });
    s.ssh.replies.push({ match: "installed=", stdout: STATUS });
    const res = await s.request("GET", "/1/status");
    expect(res.body.users).toEqual([]);
    expect(res.body.canEdit).toBe(false);
  });

  it("refuses hosts with Cron turned off", async () => {
    s = await startServer({ settings: { enableCron: false } });
    const res = await s.request("GET", "/1/status");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("disabled");
  });
});

describe("jobs", () => {
  it("reads the login user's crontab without sudo", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "crontab -l", stdout: TAB });
    const res = await s.request("GET", "/1/jobs");
    expect(res.body.jobs).toHaveLength(2);
    expect(res.body.jobs[0].label).toBe("Backup");
    expect(s.ssh.calls[0].command).not.toContain("sudo");
  });

  it("needs edit access for another user's crontab", async () => {
    s = await startServer({ level: "connect" });
    const res = await s.request("GET", "/1/jobs?user=root");
    expect(res.status).toBe(403);
    expect(s.ssh.calls).toHaveLength(0);
  });

  it("reads another user's crontab as root", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "crontab -u", stdout: TAB });
    await s.request("GET", "/1/jobs?user=www-data");
    expect(s.ssh.calls[0].stdin).toContain("crontab -u 'www-data' -l");
    expect(s.ssh.calls[0].command).toContain("sudo");
  });

  it("refuses bad user names", async () => {
    s = await startServer();
    const res = await s.request("GET", "/1/jobs?user=a;b");
    expect(res.status).toBe(400);
  });

  it("adds a job by writing the crontab back", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "crontab -l", stdout: TAB });
    const res = await s.request("POST", "/1/jobs", {
      schedule: "0 1 * * *",
      command: "/opt/new.sh",
      label: "New",
    });
    expect(res.status).toBe(200);
    const write = s.ssh.calls.find((c) => c.stdin.includes("crontab -\n"));
    const b64 = write!.stdin.match(/printf '%s' '([^']+)'/)![1];
    const text = Buffer.from(b64, "base64").toString();
    expect(text).toBe(`${TAB}\n# New\n0 1 * * * /opt/new.sh\n`);
    expect(s.mock.audits.at(-1)).toMatchObject({
      action: "cron.add",
      success: true,
    });
  });

  it("refuses a bad schedule", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "crontab -l", stdout: TAB });
    const res = await s.request("POST", "/1/jobs", {
      schedule: "99 * * * *",
      command: "x",
    });
    expect(res.status).toBe(400);
  });

  it("needs edit access to change", async () => {
    s = await startServer({ level: "connect" });
    const res = await s.request("POST", "/1/jobs", {
      schedule: "0 1 * * *",
      command: "x",
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("HOST_EDIT_REQUIRED");
  });

  it("refuses changes on a read only host", async () => {
    s = await startServer({ settings: { readOnly: true } });
    const res = await s.request("DELETE", "/1/jobs/deadbeef");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("readOnly");
  });

  it("answers 409 when the job is gone", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "crontab -l", stdout: TAB });
    const res = await s.request("DELETE", "/1/jobs/deadbeef");
    expect(res.status).toBe(409);
  });

  it("runs a job now and returns its output", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "crontab -l", stdout: TAB });
    s.ssh.replies.push({
      match: "mktemp",
      stdout: "backup done\n@@TERMIX@@EXIT 0\n",
    });
    const jobs = (await s.request("GET", "/1/jobs")).body.jobs;
    const res = await s.request("POST", `/1/jobs/${jobs[0].id}/run`, {});
    expect(res.body).toEqual({ output: "backup done", code: 0 });
  });
});

describe("system files", () => {
  it("reads /etc/crontab, cron.d and scripts", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "/etc/cron.d/*",
      stdout: `@@TERMIX@@FILE /etc/crontab
SHELL=/bin/sh
17 * * * * root cd / && run-parts --report /etc/cron.hourly

@@TERMIX@@FILE /etc/cron.d/e2scrub_all
30 3 * * 0 root test -e /run/systemd/system || /usr/lib/x86_64-linux-gnu/e2fsprogs/e2scrub_all_cron

@@TERMIX@@SCRIPT daily apt-compat
@@TERMIX@@SCRIPT daily logrotate
@@TERMIX@@TIMERS 12
`,
    });
    const res = await s.request("GET", "/1/system");
    expect(res.body.files).toHaveLength(2);
    expect(res.body.files[0]).toMatchObject({
      path: "/etc/crontab",
      editable: false,
    });
    expect(res.body.files[1]).toMatchObject({
      name: "e2scrub_all",
      editable: true,
    });
    expect(res.body.files[1].jobs[0].user).toBe("root");
    expect(res.body.scripts.daily).toEqual(["apt-compat", "logrotate"]);
    expect(res.body.timers).toBe(12);
  });

  it("checks a cron.d file before writing it", async () => {
    s = await startServer();
    const bad = await s.request("PUT", "/1/system/backup", {
      text: "0 1 * * * \n",
    });
    expect(bad.status).toBe(400);
    const name = await s.request("PUT", "/1/system/bad.name", { text: "x" });
    expect(name.status).toBe(400);
    const ok = await s.request("PUT", "/1/system/backup", {
      text: "0 1 * * * root /opt/backup.sh",
    });
    expect(ok.status).toBe(200);
    expect(s.ssh.calls.at(-1)!.stdin).toContain(
      "install -m 644 -o root -g root",
    );
  });
});

describe("logs", () => {
  it("returns the lines and their source", async () => {
    s = await startServer();
    s.ssh.replies.push({
      match: "journalctl",
      stdout:
        "@@TERMIX@@SOURCE journal\n2026-11-04T10:00:01 host CRON[1]: (root) CMD (x)\n",
    });
    const res = await s.request("GET", "/1/logs?lines=50");
    expect(res.body.source).toBe("journal");
    expect(res.body.text).toContain("CMD (x)");
  });
});

describe("scripts", () => {
  const bash = spawnSync("bash", ["-c", "true"]).status === 0;

  it.skipIf(!bash)("every script parses as bash", async () => {
    s = await startServer();
    s.ssh.replies.push({ match: "crontab -l", stdout: TAB });
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/1/status"],
      ["GET", "/1/jobs"],
      ["GET", "/1/jobs?user=root"],
      [
        "POST",
        "/1/jobs",
        { schedule: "0 1 * * *", command: "echo 'hi' \"$HOME\"" },
      ],
      ["PUT", "/1/crontab", { user: "root", text: TAB }],
      ["GET", "/1/system"],
      ["PUT", "/1/system/backup", { text: "0 1 * * * root /opt/b.sh\n" }],
      ["DELETE", "/1/system/backup"],
      ["GET", "/1/logs"],
    ];
    for (const [method, path, body] of calls) {
      await s.request(method, path, body);
    }
    const jobs = (await s.request("GET", "/1/jobs")).body.jobs;
    await s.request("POST", `/1/jobs/${jobs[0].id}/run`, {});
    await s.request("POST", `/1/jobs/${jobs[0].id}/run`, { user: "root" });
    expect(s.ssh.calls.length).toBeGreaterThan(10);
    for (const call of s.ssh.calls) {
      const out = spawnSync("bash", ["-n"], { input: call.stdin });
      expect(out.status, `${call.stdin}\n${out.stderr}`).toBe(0);
    }
  });
});
