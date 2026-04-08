import translateLib from "google-translate-api-x";

/**
 * 한국어 텍스트를 영어로 번역. 350M 분류기가 한국어보다 영어에서 훨씬 정확하므로
 * Step 2 분류 단계 직전에 의견과 안건을 영어화한다.
 */
export async function toEnglish(text: string): Promise<string> {
  const res = await translateLib(text, { from: "ko", to: "en" });
  // 라이브러리는 단일/배열 둘 다 반환할 수 있어 string 으로 강제
  const out = Array.isArray(res) ? res.map((r) => r.text).join(" ") : res.text;
  return String(out || "").trim();
}
