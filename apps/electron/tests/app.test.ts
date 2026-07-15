import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { _electron as electron } from "playwright";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let app: ElectronApplication | undefined;
let dashboardPage: Page;
let serverPort: number;

const DEFAULT_PORT = 4649;

interface HotkeyTestSnapshot {
  desired: { hold: string; toggle: string | null } | null;
  generation: number;
}

async function getHotkeyTestSnapshot(): Promise<HotkeyTestSnapshot> {
  return app.evaluate(() => {
    const testGlobal = globalThis as typeof globalThis & {
      __freestyleHotkeyManager?: {
        getDesiredBindings(): { hold: string; toggle: string | null } | null;
        getState(): { generation: number };
      };
    };
    const manager = testGlobal.__freestyleHotkeyManager;
    if (!manager) throw new Error("Hotkey manager test hook unavailable");
    return {
      desired: manager.getDesiredBindings(),
      generation: manager.getState().generation,
    };
  });
}

async function waitForHotkeyBindings(expected: {
  hold: string;
  toggle: string | null;
}): Promise<HotkeyTestSnapshot> {
  await expect
    .poll(async () => (await getHotkeyTestSnapshot()).desired)
    .toEqual(expected);
  return getHotkeyTestSnapshot();
}

/**
 * Wait for a window whose URL does NOT contain "pill" — that's the
 * dashboard / onboarding window. The pill window loads pill.html and
 * may appear first.
 */
async function waitForDashboardWindow(
  electronApp: ElectronApplication,
  timeoutMs = 10_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const win of electronApp.windows()) {
      const url = win.url();
      if (!url.includes("pill") && url.length > 0) {
        await win.waitForLoadState("domcontentloaded");
        return win;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  // Fallback: return whatever window we have
  return electronApp.windows()[0];
}

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "freestyle-e2e-"));
  const dbPath = join(userDataDir, "freestyle.db");

  try {
    app = await electron.launch({
      args: [resolve(__dirname, "../out/main/index.js")],
      env: {
        ...process.env,
        NODE_ENV: "development",
        FREESTYLE_DB_PATH: dbPath,
        FREESTYLE_E2E: "1",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });

    // Wait for the first window so Playwright's internal state is ready.
    await app.firstWindow();

    // Find the dashboard (non-pill) window.
    dashboardPage = await waitForDashboardWindow(app, 15_000);
    try {
      await dashboardPage.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      // Embedded server keeps connections open; networkidle may never fire.
      await dashboardPage.waitForLoadState("load", { timeout: 10_000 });
    }

    // Resolve the actual server port by probing the default port from the
    // main process. The server starts on DEFAULT_PORT and only falls back
    // to a random port when DEFAULT_PORT is already in use.
    const portResult = await app.evaluate(async (_electron, port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) return port;
      } catch {
        // port not available
      }
      return 0;
    }, DEFAULT_PORT);

    serverPort = portResult || DEFAULT_PORT;
  } catch (error) {
    console.error("Failed to launch Electron app:", error);
    if (app) {
      await app.close().catch(console.error);
      app = undefined;
    }
    throw error;
  }
});

test.afterAll(async () => {
  try {
    if (app) {
      await app.close();
    }
  } catch (error) {
    console.warn("Error closing app:", error);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("app launches and creates windows", async () => {
  const windows = app.windows();
  expect(windows.length).toBeGreaterThanOrEqual(1);
});

test("main process is responsive", async () => {
  const isPackaged = await app.evaluate(({ app }) => app.isPackaged);
  expect(isPackaged).toBe(false);
});

test("app name is Freestyle", async () => {
  const appName = await app.evaluate(({ app }) => app.getName());
  expect(appName).toBe("Freestyle");
});

test("app version is defined", async () => {
  const version = await app.evaluate(({ app }) => app.getVersion());
  expect(version).toBeTruthy();
  expect(version).toMatch(/^\d+\.\d+/);
});

test("dashboard window loads a valid route", async () => {
  const url = dashboardPage.url();
  const isValidRoute =
    url.includes("/today") ||
    url.includes("/onboarding") ||
    url.includes("index.html");
  expect(isValidRoute).toBe(true);
});

test("dashboard window has a reasonable viewport", async () => {
  const size = dashboardPage.viewportSize();
  if (size) {
    expect(size.width).toBeGreaterThanOrEqual(700);
    expect(size.height).toBeGreaterThanOrEqual(400);
  }
});

test("embedded server is running", async () => {
  const health = await app.evaluate(async (_electron, port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    return res.json() as Promise<{ status: string; name: string }>;
  }, serverPort);
  expect(health).toEqual({ status: "ok", name: "freestyle" });
});

test("settings API works via embedded server", async () => {
  await app.evaluate(async (_electron, port) => {
    await fetch(`http://127.0.0.1:${port}/api/settings/e2e_test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "hello" }),
    });
  }, serverPort);

  const result = await app.evaluate(async (_electron, port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/e2e_test`);
    return res.json() as Promise<{ key: string; value: string }>;
  }, serverPort);
  expect(result).toEqual({ key: "e2e_test", value: "hello" });
});

test("dual hotkey settings and legacy IPC preserve compatibility", async () => {
  const platform = await app.evaluate((_electron) => process.platform);
  const defaultHold = platform === "darwin" ? "Fn" : "Control+Alt+Space";
  await app.evaluate(async (_electron, port) => {
    await Promise.all(
      ["hotkey", "hotkey_toggle"].map((key) =>
        fetch(`http://127.0.0.1:${port}/api/settings/${key}`, {
          method: "DELETE",
        }),
      ),
    );
  }, serverPort);
  await dashboardPage.evaluate(() => window.api.reloadHotkey());
  await waitForHotkeyBindings({ hold: defaultHold, toggle: null });

  await app.evaluate(async (_electron, port) => {
    for (const [key, value] of [
      ["hotkey", "Control+Alt+F7"],
      ["hotkey_toggle", ""],
    ]) {
      await fetch(`http://127.0.0.1:${port}/api/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
    }
  }, serverPort);
  await dashboardPage.evaluate(() => window.api.reloadHotkey());
  await waitForHotkeyBindings({ hold: "Control+Alt+F7", toggle: null });

  await app.evaluate(async (_electron, port) => {
    await fetch(`http://127.0.0.1:${port}/api/settings/hotkey_toggle`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "Control+Alt+F8" }),
    });
  }, serverPort);
  await dashboardPage.evaluate(() => window.api.reloadHotkey());
  await waitForHotkeyBindings({
    hold: "Control+Alt+F7",
    toggle: "Control+Alt+F8",
  });

  await dashboardPage.evaluate(() => window.api.updateHotkey("Control+Alt+F9"));
  const updated = await waitForHotkeyBindings({
    hold: "Control+Alt+F9",
    toggle: "Control+Alt+F8",
  });
  await dashboardPage.evaluate(() => window.api.setHotkeyMode("toggle"));
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(await getHotkeyTestSnapshot()).toEqual(updated);
});

test("ordinary hotkey replacement preserves unrelated global shortcuts", async () => {
  const registered = await app.evaluate(({ globalShortcut }) =>
    globalShortcut.isRegistered("Escape")
      ? true
      : globalShortcut.register("Escape", () => {}),
  );
  expect(registered).toBe(true);

  const before = await getHotkeyTestSnapshot();
  await dashboardPage.evaluate(() => window.api.reloadHotkey());
  await expect
    .poll(async () => (await getHotkeyTestSnapshot()).generation)
    .toBeGreaterThan(before.generation);

  expect(
    await app.evaluate(({ globalShortcut }) =>
      globalShortcut.isRegistered("Escape"),
    ),
  ).toBe(true);
  await app.evaluate(({ globalShortcut }) => {
    globalShortcut.unregister("Escape");
  });
});

test("dashboard renders content", async () => {
  const body = dashboardPage.locator("body");

  if (dashboardPage.url().includes("/onboarding")) {
    await body.waitFor({ state: "visible" });
    expect((await body.innerText()).length).toBeGreaterThan(0);
    return;
  }

  await dashboardPage.waitForSelector("main, nav", { timeout: 10_000 });

  await body.waitFor({ state: "visible" });
  const bodyText = await body.innerText();
  expect(bodyText.length).toBeGreaterThan(0);
});

test("sidebar navigation is rendered", async () => {
  const url = dashboardPage.url();
  if (url.includes("/onboarding")) {
    // On onboarding page, there's no sidebar but there is content
    const body = await dashboardPage.locator("body").innerText();
    expect(body.length).toBeGreaterThan(0);
    return;
  }

  await dashboardPage.waitForSelector("nav", { timeout: 10_000 });
  const navLinks = await dashboardPage.locator("nav a").all();
  expect(navLinks.length).toBe(7);
});
