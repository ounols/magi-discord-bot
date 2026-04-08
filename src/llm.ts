import { fetch } from "undici";
import { config } from "./config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** JSON object 강제 (지원 모델 한정) */
  json?: boolean;
}

/**
 * OpenWebUI의 OpenAI 호환 엔드포인트로 chat completion 호출.
 * 일부 OpenWebUI 배포는 `/api/chat/completions`, 다른 배포는 `/v1/chat/completions` 사용.
 * 여기서는 표준 OpenAI 경로(`/v1/chat/completions`)를 우선 시도하고 실패 시 `/api/chat/completions` 로 폴백한다.
 */
export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.llm.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 512,
    stream: false,
  };
  if (opts.json) {
    body.response_format = { type: "json_object" };
  }

  const paths = ["/api/chat/completions", "/v1/chat/completions"];
  let lastErr: unknown;
  for (const path of paths) {
    try {
      const res = await fetch(`${config.llm.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llm.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        lastErr = new Error(`LLM ${path} ${res.status}: ${text.slice(0, 200)}`);
        continue;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(`LLM 응답에 content 없음: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return content;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("LLM 호출 실패");
}

/** 응답에서 첫 JSON object 만 추출. 350M 모델이 가끔 앞뒤로 텍스트를 흘릴 때 대비. */
export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  // 1) 그대로 시도
  try {
    return JSON.parse(trimmed) as T;
  } catch {}
  // 2) ```json ... ``` 블록
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {}
  }
  // 3) 첫 { ... } 균형 매칭
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = trimmed.slice(start, i + 1);
          return JSON.parse(slice) as T;
        }
      }
    }
  }
  throw new Error(`JSON 추출 실패: ${raw.slice(0, 200)}`);
}
