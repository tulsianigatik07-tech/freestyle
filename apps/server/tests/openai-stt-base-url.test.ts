import { createOpenAI } from "@ai-sdk/openai";
import { normalizeOpenAISttBaseUrl } from "@freestyle-voice/validations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_KEYS } from "../../electron/src/shared/settings-keys.js";
import { getDb } from "../src/lib/db.js";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    transcription: vi.fn((id: string) => ({ id })),
  })),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    experimental_transcribe: vi.fn(async () => ({
      text: "mock transcript",
      segments: undefined,
      durationInSeconds: undefined,
    })),
  };
});

const { OpenAITranscriptionProvider } = await import(
  "../src/lib/streaming/providers/openai.js"
);

const opts = {
  audio: new Uint8Array([1, 2, 3, 4]),
  model: "whisper-1",
  apiKey: "test-key",
};

function createOpenAICallConfig(): unknown {
  return vi.mocked(createOpenAI).mock.calls[0]?.[0];
}

describe("OpenAI STT base URL setting", () => {
  beforeEach(() => {
    getDb()
      .prepare("DELETE FROM settings WHERE key = ?")
      .run(SETTINGS_KEYS.openaiSttBaseUrl);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("preserves default provider config when no setting is present", async () => {
    const provider = new OpenAITranscriptionProvider();

    const result = await provider.transcribe(opts);

    expect(result).toEqual({
      text: "mock transcript",
      segments: undefined,
      durationInSeconds: undefined,
    });
    expect(createOpenAICallConfig()).toEqual({ apiKey: "test-key" });
  });

  it("forwards normalized custom base URL to the OpenAI provider", async () => {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(SETTINGS_KEYS.openaiSttBaseUrl, "https://example.com");
    const provider = new OpenAITranscriptionProvider();

    const result = await provider.transcribe(opts);

    expect(result.text).toBe("mock transcript");
    expect(createOpenAICallConfig()).toEqual({
      apiKey: "test-key",
      baseURL: normalizeOpenAISttBaseUrl("https://example.com"),
    });
  });

  it("preserves default provider config when the setting is empty", async () => {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(SETTINGS_KEYS.openaiSttBaseUrl, "");
    const provider = new OpenAITranscriptionProvider();

    const result = await provider.transcribe(opts);

    expect(result.text).toBe("mock transcript");
    expect(createOpenAICallConfig()).toEqual({ apiKey: "test-key" });
  });

  it("normalizes whitespace and trailing slash before forwarding", async () => {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(SETTINGS_KEYS.openaiSttBaseUrl, "  http://localhost:10095/  ");
    const provider = new OpenAITranscriptionProvider();

    await provider.transcribe(opts);

    expect(createOpenAICallConfig()).toEqual({
      apiKey: "test-key",
      baseURL: normalizeOpenAISttBaseUrl("  http://localhost:10095/  "),
    });
  });
});
