import { expect, test } from "@playwright/test";
import { runFactoryResetLifecycle } from "../src/main/factory-reset-lifecycle";
import {
  HotkeyManager,
  type HotkeyManagerDependencies,
  type ManagedHotkeyListener,
  type ManagedHotkeyListenerOptions,
} from "../src/main/hotkey-manager";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void = () => {};

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeListener implements ManagedHotkeyListener {
  startCalls = 0;
  stopCalls = 0;
  isRunning = false;

  constructor(
    readonly options: ManagedHotkeyListenerOptions,
    private readonly startResult: boolean | Promise<boolean>,
  ) {}

  async start(): Promise<boolean> {
    this.startCalls++;
    const started = await this.startResult;
    this.isRunning = started;
    return started;
  }

  stop(): void {
    this.stopCalls++;
    this.isRunning = false;
  }
}

interface Harness {
  manager: HotkeyManager;
  listeners: FakeListener[];
  events: string[];
  fallbackCallbacks: Map<string, () => void>;
  fallbackAttempts: string[];
  unregisteredFallbacks: string[];
  holdErrors: string[];
  toggleErrors: string[];
  logs: string[];
  timers: Map<number, () => void>;
}

function createHarness(options?: {
  startResults?: Array<boolean | Promise<boolean>>;
  fallbackResult?: string | null;
}): Harness {
  const listeners: FakeListener[] = [];
  const events: string[] = [];
  const fallbackCallbacks = new Map<string, () => void>();
  const fallbackAttempts: string[] = [];
  const unregisteredFallbacks: string[] = [];
  const holdErrors: string[] = [];
  const toggleErrors: string[] = [];
  const logs: string[] = [];
  const timers = new Map<number, () => void>();
  const startResults = [...(options?.startResults ?? [])];
  let nextTimer = 1;

  const dependencies: HotkeyManagerDependencies = {
    createListener: (listenerOptions) => {
      const listener = new FakeListener(
        listenerOptions,
        startResults.shift() ?? true,
      );
      listeners.push(listener);
      return listener;
    },
    registerFallback: (accelerator, callback) => {
      fallbackAttempts.push(accelerator);
      const registered = options?.fallbackResult ?? accelerator;
      if (registered) fallbackCallbacks.set(registered, callback);
      return registered;
    },
    unregisterFallback: (accelerator) => {
      unregisteredFallbacks.push(accelerator);
      fallbackCallbacks.delete(accelerator);
    },
    sendHotkeyDown: () => events.push("down"),
    sendHotkeyUp: () => events.push("up"),
    surfaceHoldUnavailableError: (accelerator) => holdErrors.push(accelerator),
    surfaceToggleUnavailableError: (accelerator) =>
      toggleErrors.push(accelerator),
    log: (message) => logs.push(message),
    setTimer: (callback) => {
      const timer = nextTimer++;
      timers.set(timer, callback);
      return timer;
    },
    clearTimer: (timer) => {
      timers.delete(timer as number);
    },
  };

  return {
    manager: new HotkeyManager(dependencies),
    listeners,
    events,
    fallbackCallbacks,
    fallbackAttempts,
    unregisteredFallbacks,
    holdErrors,
    toggleErrors,
    logs,
    timers,
  };
}

function listenerFor(
  harness: Harness,
  binding: "hold" | "toggle",
  index = 0,
): FakeListener {
  return harness.listeners.filter(
    (listener) => listener.options.binding === binding,
  )[index];
}

test("HotkeyManager constructs with injected dependencies and empty state", () => {
  const harness = createHarness();

  expect(harness.manager.getState()).toEqual({
    bindings: {
      hold: {
        accelerator: null,
        listener: null,
        fallbackAccelerator: null,
      },
      toggle: {
        accelerator: null,
        listener: null,
        fallbackAccelerator: null,
      },
    },
    generation: 0,
    paused: false,
    destroyed: false,
    recording: {
      active: false,
      holdKeyDown: false,
      startedBy: null,
    },
  });
});

test("distinct bindings start two native listeners concurrently", async () => {
  const holdStart = new Deferred<boolean>();
  const toggleStart = new Deferred<boolean>();
  const harness = createHarness({
    startResults: [holdStart.promise, toggleStart.promise],
  });

  const registration = harness.manager.registerBindings({
    hold: "Control+Alt+Space",
    toggle: "F8",
  });

  expect(harness.listeners).toHaveLength(2);
  expect(harness.listeners.map((listener) => listener.startCalls)).toEqual([
    1, 1,
  ]);
  holdStart.resolve(true);
  toggleStart.resolve(true);
  await registration;

  expect(harness.manager.getState().bindings.hold.listener).not.toBeNull();
  expect(harness.manager.getState().bindings.toggle.listener).not.toBeNull();
});

test("null or empty toggle creates no toggle listener", async () => {
  for (const toggle of [null, ""]) {
    const harness = createHarness();
    await harness.manager.registerBindings({ hold: "F7", toggle });

    expect(harness.listeners).toHaveLength(1);
    expect(harness.manager.getState().bindings.toggle.accelerator).toBeNull();
  }
});

test("canonical duplicate keeps hold and leaves toggle inert", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({
    hold: "Control+Alt+Space",
    toggle: "Alt+Ctrl+Space",
  });

  expect(harness.listeners).toHaveLength(1);
  expect(harness.manager.getState().bindings.hold.accelerator).toBe(
    "Control+Alt+Space",
  );
  expect(harness.manager.getState().bindings.toggle.accelerator).toBeNull();
  expect(harness.logs).toHaveLength(1);
});

test("hold down and up are synchronous and idempotent", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: null });
  const hold = listenerFor(harness, "hold");

  hold.options.onKeyUp();
  hold.options.onKeyDown();
  hold.options.onKeyDown();
  hold.options.onKeyUp();
  hold.options.onKeyUp();

  expect(harness.events).toEqual(["down", "up"]);
});

test("toggle alternates recording and ignores key up", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  const toggle = listenerFor(harness, "toggle");

  toggle.options.onKeyDown();
  toggle.options.onKeyUp();
  toggle.options.onKeyDown();

  expect(harness.events).toEqual(["down", "up"]);
});

test("either applicable stop condition stops the shared session", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  const hold = listenerFor(harness, "hold");
  const toggle = listenerFor(harness, "toggle");

  hold.options.onKeyDown();
  toggle.options.onKeyDown();
  toggle.options.onKeyDown();
  hold.options.onKeyDown();
  hold.options.onKeyUp();

  expect(harness.events).toEqual(["down", "up", "down", "up"]);
});

test("near-simultaneous starts cannot emit overlapping down events", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });

  listenerFor(harness, "hold").options.onKeyDown();
  listenerFor(harness, "toggle").options.onKeyDown();

  expect(harness.events).toEqual(["down", "up"]);
  expect(harness.manager.getState().recording.active).toBe(false);
});

test("re-registration stops both listeners and releases once", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  const firstHold = listenerFor(harness, "hold");
  const firstToggle = listenerFor(harness, "toggle");
  firstHold.options.onKeyDown();

  await harness.manager.registerBindings({ hold: "F9", toggle: "F10" });

  expect(firstHold.stopCalls).toBe(1);
  expect(firstToggle.stopCalls).toBe(1);
  expect(harness.events).toEqual(["down", "up"]);
});

test("replacement unregisters only its tracked fallback", async () => {
  const harness = createHarness({ startResults: [true, false, true] });
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });

  await harness.manager.registerBindings({ hold: "F9", toggle: null });

  expect(harness.unregisteredFallbacks).toEqual(["F8"]);
});

test("hold startup failure has no fallback and leaves toggle active", async () => {
  const harness = createHarness({ startResults: [false, true] });
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });

  expect(harness.fallbackAttempts).toEqual([]);
  expect(harness.holdErrors).toEqual(["F7"]);
  expect(harness.manager.getState().bindings.hold.listener).toBeNull();
  expect(harness.manager.getState().bindings.toggle.listener).not.toBeNull();
});

test("toggle startup failure installs fallback and leaves hold active", async () => {
  const harness = createHarness({ startResults: [true, false] });
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });

  expect(harness.fallbackAttempts).toEqual(["F8"]);
  expect(harness.manager.getState().bindings.hold.listener).not.toBeNull();
  expect(harness.manager.getState().bindings.toggle.fallbackAccelerator).toBe(
    "F8",
  );
  harness.fallbackCallbacks.get("F8")?.();
  expect(harness.events).toEqual(["down"]);
});

test("permanent failure only replaces the failing slot", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  const hold = listenerFor(harness, "hold");
  const toggle = listenerFor(harness, "toggle");

  toggle.options.onPermanentFailure?.();
  expect(hold.stopCalls).toBe(0);
  expect(harness.manager.getState().bindings.hold.listener).toBe(hold);
  expect(harness.manager.getState().bindings.toggle.listener).toBeNull();
  expect(harness.manager.getState().bindings.toggle.fallbackAccelerator).toBe(
    "F8",
  );

  hold.options.onPermanentFailure?.();
  hold.options.onPermanentFailure?.();
  expect(harness.holdErrors).toEqual(["F7"]);
  expect(harness.manager.getState().bindings.toggle.fallbackAccelerator).toBe(
    "F8",
  );
});

test("stale startup and callbacks cannot mutate the current generation", async () => {
  const oldStart = new Deferred<boolean>();
  const harness = createHarness({ startResults: [oldStart.promise, true] });
  const oldRegistration = harness.manager.registerBindings({
    hold: "F7",
    toggle: null,
  });
  const oldHold = listenerFor(harness, "hold");

  await harness.manager.registerBindings({ hold: "F8", toggle: null });
  const currentHold = listenerFor(harness, "hold", 1);
  oldHold.options.onKeyDown();
  oldHold.options.onPermanentFailure?.();
  oldStart.resolve(true);
  await oldRegistration;

  expect(oldHold.stopCalls).toBeGreaterThan(0);
  expect(harness.events).toEqual([]);
  expect(harness.holdErrors).toEqual([]);
  expect(harness.manager.getState().bindings.hold.listener).toBe(currentHold);
});

test("pause and resume preserve both desired bindings", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  const firstHold = listenerFor(harness, "hold");
  const firstToggle = listenerFor(harness, "toggle");

  harness.manager.pause();
  expect(firstHold.stopCalls).toBe(1);
  expect(firstToggle.stopCalls).toBe(1);
  expect(harness.manager.getDesiredBindings()).toEqual({
    hold: "F7",
    toggle: "F8",
  });

  await harness.manager.resume();
  expect(harness.listeners).toHaveLength(4);
  expect(harness.manager.getState().paused).toBe(false);
});

test("hold watchdog forces one release and clears physical state", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: null });
  listenerFor(harness, "hold").options.onKeyDown();
  const watchdog = [...harness.timers.values()][0];

  watchdog();

  expect(harness.events).toEqual(["down", "up"]);
  expect(harness.manager.getState().recording).toEqual({
    active: false,
    holdKeyDown: false,
    startedBy: null,
  });
});

test("watchdog and final stop clean all owned state", async () => {
  const harness = createHarness({ startResults: [true, false] });
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  listenerFor(harness, "hold").options.onKeyDown();
  expect(harness.timers.size).toBe(1);

  harness.manager.stop();

  expect(harness.events).toEqual(["down", "up"]);
  expect(harness.timers.size).toBe(0);
  expect(harness.unregisteredFallbacks).toEqual(["F8"]);
  expect(harness.manager.getState().destroyed).toBe(true);
  expect(harness.manager.getState().bindings.hold.listener).toBeNull();
  expect(harness.manager.getState().bindings.toggle.listener).toBeNull();
});

test("factory reset pauses during work and permanently stops before relaunch", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  listenerFor(harness, "hold").options.onKeyDown();
  const lifecycle: string[] = [];

  await runFactoryResetLifecycle({
    manager: harness.manager,
    performReset: async () => {
      lifecycle.push("reset");
      expect(harness.manager.getState().paused).toBe(true);
      expect(harness.manager.getState().destroyed).toBe(false);
      expect(harness.manager.getDesiredBindings()).toEqual({
        hold: "F7",
        toggle: "F8",
      });
      expect(harness.events).toEqual(["down", "up"]);
    },
    scheduleRelaunch: () => {
      lifecycle.push("relaunch");
      expect(harness.manager.getState().destroyed).toBe(true);
    },
    exit: () => {
      lifecycle.push("exit");
      expect(harness.manager.getState().destroyed).toBe(true);
    },
    logResumeFailure: () => {},
  });

  expect(lifecycle).toEqual(["reset", "relaunch", "exit"]);
  expect(harness.manager.getState().destroyed).toBe(true);
});

test("factory reset failure resumes preserved bindings and rethrows the original error", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  const resetError = new Error("reset failed");

  await expect(
    runFactoryResetLifecycle({
      manager: harness.manager,
      performReset: async () => {
        expect(harness.manager.getState().paused).toBe(true);
        throw resetError;
      },
      scheduleRelaunch: () => {
        throw new Error("must not relaunch");
      },
      exit: () => {
        throw new Error("must not exit");
      },
      logResumeFailure: () => {},
    }),
  ).rejects.toBe(resetError);

  expect(harness.manager.getState().destroyed).toBe(false);
  expect(harness.manager.getState().paused).toBe(false);
  expect(harness.manager.getDesiredBindings()).toEqual({
    hold: "F7",
    toggle: "F8",
  });
  expect(harness.listeners).toHaveLength(4);
});

test("factory reset recovery logs resume failure without hiding the reset error", async () => {
  const harness = createHarness();
  await harness.manager.registerBindings({ hold: "F7", toggle: "F8" });
  const resetError = new Error("reset failed");
  const resumeError = new Error("resume failed");
  const loggedErrors: unknown[] = [];
  harness.manager.resume = async () => {
    throw resumeError;
  };

  await expect(
    runFactoryResetLifecycle({
      manager: harness.manager,
      performReset: async () => {
        throw resetError;
      },
      scheduleRelaunch: () => {},
      exit: () => {},
      logResumeFailure: (error) => loggedErrors.push(error),
    }),
  ).rejects.toBe(resetError);

  expect(loggedErrors).toEqual([resumeError]);
  expect(harness.manager.getState().destroyed).toBe(false);
  expect(harness.manager.getState().paused).toBe(true);
  expect(harness.manager.getDesiredBindings()).toEqual({
    hold: "F7",
    toggle: "F8",
  });
});
