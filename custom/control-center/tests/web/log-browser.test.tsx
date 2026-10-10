// Runs & Schedule > Job logs: a dated log that fails to load shows an error with Retry, not a blank panel (R18-feat-b-X-04).
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { until } from "../helpers/until";
import { LogBrowser } from "@web/features/runs/ScheduleCards";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let dated: "ok" | "missing";

const LOG = {
  status: "ok",
  startedAt: "08:00",
  finishedAt: "08:05",
  problems: [],
  steps: [],
  raw: "daily log body",
};

beforeEach(async () => {
  dated = "missing";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/schedule/logs?"))
        return new Response(
          JSON.stringify({
            job: "immigration-watch",
            dates: ["2026-10-10"],
            latest: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (url.startsWith("/api/schedule/logs/2026-10-10")) {
        return dated === "ok"
          ? new Response(JSON.stringify(LOG), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ error: "no log for 2026-10-10" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(LogBrowser),
      ),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("log browser", () => {
  it("shows the dated-log fetch failure with Retry, and Retry loads the log once it is back", async () => {
    const alert = await until(
      () => host.querySelector('[role="alert"]'),
      "the load error",
    );
    expect(alert.textContent).toContain("Could not load");
    dated = "ok";
    const retry = [...alert.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Retry",
    )!;
    await act(async () => retry.click());
    await until(
      () => host.querySelector('pre[aria-label="Log 2026-10-10"]'),
      "the log",
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("daily log body");
  });
});
