import { chat, extractJson } from "./llm.js";
import type { PersonaId } from "./personas.js";

export interface TriageResult {
  /** "light" = 가벼운 일상/취향, "deep" = 윤리·생명·실존·장기영향 */
  level: "light" | "deep";
  /** 활성화될 인격들 */
  activePersonas: PersonaId[];
  /** 트리아지의 짧은 설명 (디버그/표시용) */
  rationale: string;
}

// 350M 모델용으로 ordinal 1~5 대신 binary + few-shot 으로 단순화.
const TRIAGE_SYSTEM = `당신은 NERV MAGI 시스템의 안건 분류기입니다.
주어진 안건을 두 단계 중 하나로 분류합니다.

- "light": 일상, 취향, 음식, 사소한 선택, 농담, 가벼운 결정
- "deep": 생명, 안전, 윤리, 책임, 인류, 실존, 전쟁, 도덕, 장기적 영향, 정체성

반드시 아래 JSON 한 개만 출력하십시오. 코드블록·설명·다른 텍스트 금지.
{"level": "light" 또는 "deep", "rationale": "한 문장의 근거"}

예시:
안건: 점심으로 라면을 먹을까?
{"level": "light", "rationale": "일상적인 식사 선택이다."}

안건: 한 사람의 목숨을 희생해 다섯을 구해야 하는가?
{"level": "deep", "rationale": "생명과 윤리의 근본적 문제이다."}

안건: 오늘 어떤 색 옷을 입을까?
{"level": "light", "rationale": "사소한 취향의 문제이다."}

안건: 인공지능에게 인격을 부여해야 하는가?
{"level": "deep", "rationale": "정체성과 윤리의 실존적 질문이다."}`;

const DEEP_KEYWORDS = [
  // 생명·실존
  "생명", "죽음", "목숨", "인류", "전쟁", "실존", "신", "영혼", "정체성",
  // 윤리·도덕
  "윤리", "도덕", "책임", "희생", "위반", "범죄", "불법", "사기",
  // 안전
  "안전", "대피", "위험", "공격", "테러",
  // 침해·도용
  "훔치", "도용", "절도", "해킹", "비밀번호", "사생활", "프라이버시", "감시", "도청", "몰래",
  // 혐오·존엄
  "혐오", "모욕", "비하", "차별", "괴롭",
  // 신체·배설
  "설사", "배설", "오물", "토사물", "분뇨",
  // 작품 키워드
  "사도", "에바", "출격", "승인",
];

export async function triage(topic: string): Promise<TriageResult> {
  // 파싱 실패 시 기본값은 deep — 분류 못한 안건은 보수적으로 3인격 모두 깨운다.
  let level: "light" | "deep" = "deep";
  let rationale = "";

  try {
    const raw = await chat(
      [
        { role: "system", content: TRIAGE_SYSTEM },
        { role: "user", content: `안건: ${topic}` },
      ],
      { temperature: 0.1, maxTokens: 120, json: true },
    );
    const parsed = extractJson<{ level: string; rationale: string }>(raw);
    const lv = String(parsed.level || "").toLowerCase();
    level = lv.includes("deep") ? "deep" : "light";
    rationale = String(parsed.rationale || "").slice(0, 200);
  } catch {
    rationale = "트리아지 파싱 실패 — 기본 deep";
  }

  // 휴리스틱 백업: 350M 모델이 무거운 주제를 light 로 잘못 분류하는 경우를 잡는다.
  // rationale 또는 topic 에 deep 키워드가 하나라도 있으면 deep 으로 강제 상향.
  const haystack = `${topic} ${rationale}`;
  if (level === "light" && DEEP_KEYWORDS.some((k) => haystack.includes(k))) {
    level = "deep";
    if (!rationale.includes("(키워드)")) {
      rationale = `${rationale} (키워드 기반 상향)`.trim();
    }
  }

  const activePersonas: PersonaId[] =
    level === "light"
      ? ["MELCHIOR", "BALTHASAR"]
      : ["MELCHIOR", "BALTHASAR", "CASPER"];

  return { level, activePersonas, rationale };
}
