import translateLib from "google-translate-api-x";

/**
 * 한국어 텍스트를 영어로 번역. 350M 모델은 영어 입력/출력에서 훨씬 정확하므로
 * 안건·컨텍스트·의견 모두 영어로 처리한다.
 */
export async function toEnglish(text: string): Promise<string> {
  const res = await translateLib(text, { from: "ko", to: "en" });
  const out = Array.isArray(res) ? res.map((r) => r.text).join(" ") : res.text;
  return String(out || "").trim();
}

/**
 * 영어 텍스트를 한국어로 번역. 인격이 영어로 생성한 의견을 사용자에게 보여줄 때 사용.
 */
export async function toKorean(text: string): Promise<string> {
  const res = await translateLib(text, { from: "en", to: "ko" });
  const out = Array.isArray(res) ? res.map((r) => r.text).join(" ") : res.text;
  return String(out || "").trim();
}
