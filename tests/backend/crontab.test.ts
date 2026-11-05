import { describe, expect, it } from "vitest";
import {
  addJob,
  checkSystemFile,
  cleanJob,
  deleteJob,
  parseJobs,
  parseSystemJobs,
  setJobEnabled,
  splitPercent,
  updateJob,
} from "../../src/backend/crontab.js";

const TAB = `# Edit this file to introduce tasks to be run by cron.
# m h  dom mon dow   command
MAILTO=admin@example.com

# Nightly backup
0 3 * * * /usr/local/bin/backup.sh   >> /var/log/backup.log 2>&1
# */10 * * * * /opt/check.sh
@reboot /opt/start.sh
`;

describe("crontab parsing", () => {
  it("finds jobs, off jobs and labels", () => {
    const jobs = parseJobs(TAB);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({
      enabled: true,
      schedule: "0 3 * * *",
      command: "/usr/local/bin/backup.sh   >> /var/log/backup.log 2>&1",
      label: "Nightly backup",
    });
    expect(jobs[1]).toMatchObject({
      enabled: false,
      schedule: "*/10 * * * *",
      label: "",
    });
    expect(jobs[2]).toMatchObject({ schedule: "@reboot", label: "" });
  });

  it("does not take a comment block as a label", () => {
    const jobs = parseJobs("# one\n# two\n0 1 * * * a\n");
    expect(jobs[0].label).toBe("");
  });

  it("gives duplicate lines their own ids", () => {
    const jobs = parseJobs("0 1 * * * a\n0 1 * * * a\n");
    expect(jobs[0].id).not.toBe(jobs[1].id);
  });
});

describe("crontab changes", () => {
  const job = (over: Record<string, unknown> = {}) =>
    cleanJob({ schedule: "*/5 * * * *", command: "/opt/x.sh", ...over });

  it("adds a job with its label and keeps everything else", () => {
    const out = addJob(TAB, job({ label: "Every five" }));
    expect(out.startsWith(TAB.trimEnd())).toBe(true);
    expect(out.endsWith("\n# Every five\n*/5 * * * * /opt/x.sh\n")).toBe(true);
    expect(addJob("", job())).toBe("*/5 * * * * /opt/x.sh\n");
  });

  it("changes a job and its label", () => {
    const [backup] = parseJobs(TAB);
    const out = updateJob(TAB, backup.id, job({ label: "Renamed" }));
    expect(out).toContain("# Renamed\n*/5 * * * * /opt/x.sh\n");
    expect(out).not.toContain("Nightly backup");
    expect(out).toContain("MAILTO=admin@example.com");
    const noLabel = updateJob(TAB, backup.id, job());
    expect(noLabel).not.toContain("# Nightly backup");
  });

  it("turns jobs off and on", () => {
    const [backup, check] = parseJobs(TAB);
    const off = setJobEnabled(TAB, backup.id, false);
    expect(off).toContain("# 0 3 * * * /usr/local/bin/backup.sh");
    const on = setJobEnabled(TAB, check.id, true);
    expect(on).toContain("\n*/10 * * * * /opt/check.sh\n");
  });

  it("deletes a job with its label", () => {
    const [backup] = parseJobs(TAB);
    const out = deleteJob(TAB, backup.id);
    expect(out).not.toContain("backup.sh");
    expect(out).not.toContain("Nightly backup");
    expect(parseJobs(out)).toHaveLength(2);
  });

  it("refuses a job that changed", () => {
    expect(() => deleteJob(TAB, "deadbeef")).toThrow(/changed/);
  });

  it("checks jobs", () => {
    expect(() => job({ schedule: "61 * * * *" })).toThrow(/schedule/);
    expect(() => job({ command: "" })).toThrow(/command/i);
    expect(() => job({ command: "a\nb" })).toThrow(/one line/);
  });
});

describe("percent signs", () => {
  it("splits the command from its input like cron", () => {
    expect(splitPercent("date +\\%F")).toEqual({ run: "date +%F", input: "" });
    expect(splitPercent("mail -s hi root%line one%line two")).toEqual({
      run: "mail -s hi root",
      input: "line one\nline two",
    });
  });
});

describe("system files", () => {
  it("reads jobs with a user", () => {
    const jobs = parseSystemJobs(
      "SHELL=/bin/sh\n17 * * * * root cd / && run-parts --report /etc/cron.hourly\n#0 1 * * * www-data php /var/www/cron.php\n",
    );
    expect(jobs).toEqual([
      {
        enabled: true,
        schedule: "17 * * * *",
        user: "root",
        command: "cd / && run-parts --report /etc/cron.hourly",
      },
      {
        enabled: false,
        schedule: "0 1 * * *",
        user: "www-data",
        command: "php /var/www/cron.php",
      },
    ]);
  });

  it("refuses a line without a user", () => {
    expect(() => checkSystemFile("0 1 * * * /opt/x.sh\n")).toThrow(/Line 1/);
    expect(() => checkSystemFile("0 1 * * *\n")).toThrow(/Line 1/);
    expect(() =>
      checkSystemFile("# c\nPATH=/bin\n0 1 * * * root x\n"),
    ).not.toThrow();
  });
});
