import { z } from "zod";

const OPENAI_STT_BASE_URL_MAX = 2048;

interface ParsedUrl {
  protocol: string;
  search: string;
  hash: string;
  origin: string;
  pathname: string;
}
declare const URL: { new (input: string): ParsedUrl };

function parseHttpUrl(value: string): ParsedUrl | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export const openaiSttBaseUrlSchema = z
  .string()
  .max(OPENAI_STT_BASE_URL_MAX)
  .refine(
    (value) => {
      const trimmed = value.trim();
      if (trimmed === "") return true;

      const url = parseHttpUrl(trimmed);
      return !!url && !url.search && !url.hash;
    },
    {
      message:
        "OpenAI STT base URL must be a valid http:// or https:// URL without query strings or hashes (or empty to disable)",
    },
  );

export function normalizeOpenAISttBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === "") return undefined;

  const url = parseHttpUrl(trimmed);
  if (!url) {
    throw new Error(
      "OpenAI STT base URL must be a valid http:// or https:// URL",
    );
  }
  if (url.search || url.hash) {
    throw new Error(
      "OpenAI STT base URL must not include a query string or hash",
    );
  }

  const canonical = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return canonical.endsWith("/v1") ? canonical : `${canonical}/v1`;
}
