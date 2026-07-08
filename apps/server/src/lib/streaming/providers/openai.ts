import { createOpenAI } from "@ai-sdk/openai";
import { normalizeOpenAISttBaseUrl } from "@freestyle-voice/validations";
import { readSetting } from "../../db.js";
import type {
  TranscribeOptions,
  TranscribeResult,
  TranscriptionProvider,
} from "../types.js";
import { transcribeWithAiSdk } from "../utils.js";

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly providerId = "openai";

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const baseUrl = normalizeOpenAISttBaseUrl(
      readSetting("openai_stt_base_url") ?? "",
    );
    if (!baseUrl) {
      return transcribeWithAiSdk(opts, createOpenAI, this.providerId);
    }

    const createOpenAIWithBaseUrl = (config: { apiKey: string }) =>
      createOpenAI({ apiKey: config.apiKey, baseURL: baseUrl });

    return transcribeWithAiSdk(opts, createOpenAIWithBaseUrl, this.providerId);
  }
}
