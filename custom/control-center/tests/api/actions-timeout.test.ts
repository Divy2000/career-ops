// A sync action that runs past its timeout is reported as a timeout (504), not as the action's own exit code or a
// generic 500 (FOLLOWUP-actions-timeout).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp, type TestApp } from "../helpers/app.js";
import { TIMEOUT_EXIT_CODE, type Exec } from "../../server/routes/system.js";

let t: TestApp;
// The exit code a timed-out run reports is the runner's; tests swap it to show that no action-level reading of the
// code (exitMap, findings) can win over the timeout.
let timedOutCode = TIMEOUT_EXIT_CODE;
const timedOutExec: Exec = async (cmd) => ({
  code: timedOutCode,
  stdout: "",
  stderr: `\n(--check)\n${cmd} timed out after 30 s`,
  timedOut: true,
});

beforeAll(async () => {
  t = await makeTestApp({}, { exec: timedOutExec });
});
afterAll(async () => {
  await t.close();
});

describe("sync action timeout", () => {
  it("maps a timed-out sync action to 504 with a timeout error", async () => {
    const r = await t.app.inject({
      method: "POST",
      url: "/api/actions/tracker.setStatus",
      headers: t.authedWrite,
      payload: { params: { row: 1, state: "Applied" } },
    });
    expect(r.statusCode, r.body).toBe(504);
    expect(r.json().error).toMatch(/timed out/);
  });

  it("reports a timeout even when the exit code is one the action's exitMap explains", async () => {
    timedOutCode = 1;
    const r = await t.app.inject({
      method: "POST",
      url: "/api/actions/tracker.setStatus",
      headers: t.authedWrite,
      payload: { params: { row: 1, state: "Applied" } },
    });
    timedOutCode = TIMEOUT_EXIT_CODE;
    expect(r.statusCode, r.body).toBe(504);
    expect(r.json().error).toMatch(/timed out/);
  });

  it("reports a timeout even when the action would read its output as findings", async () => {
    timedOutCode = 1;
    const r = await t.app.inject({
      method: "POST",
      url: "/api/actions/tracker.syncCheck",
      headers: t.authedWrite,
      payload: {},
    });
    timedOutCode = TIMEOUT_EXIT_CODE;
    expect(r.statusCode, r.body).toBe(504);
    expect(r.json().error).toMatch(/timed out/);
  });
});
