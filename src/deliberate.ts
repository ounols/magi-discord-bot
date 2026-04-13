import { chat } from "./llm.js";
import {
  buildPersonaUserPrompt,
  PERSONAS,
  type PersonaContext,
  type PersonaId,
} from "./personas.js";
import { toEnglish, toKorean } from "./translate.js";

export type Vote = "찬성" | "반대";
export type Decision = "가결" | "부결" | "분열";

export interface PersonaOpinion {
  persona: PersonaId;
  vote: Vote;
  reason: string;
}

export interface Verdict {
  /** 시스템 레벨 판결 */
  decision: Decision;
  /** 표 분포 */
  tally: Record<Vote, number>;
  /** 만장일치 여부 */
  unanimous: boolean;
}

/**
 * 분류기 응답을 binary vote 로 정규화. 영어/한국어 모두 수용.
 * YES/AGREE/RECOMMEND/찬 → 찬성. NO/DISAGREE/AGAINST/반 → 반대. 모호하면 보수적으로 반대.
 */
function normalizeVote(v: unknown): Vote {
  const s = String(v ?? "").trim().toUpperCase();
  const yesIdx = Math.max(
    s.lastIndexOf("YES"),
    s.lastIndexOf("AGREE"),
    s.lastIndexOf("RECOMMEND"),
    s.lastIndexOf("찬"),
    s.lastIndexOf("4"),
    s.lastIndexOf("5"),
    s.lastIndexOf("6"),
    s.lastIndexOf("7"),
    s.lastIndexOf("8"),
    s.lastIndexOf("9"),
    s.lastIndexOf("10"),
  );
  const noIdx = Math.max(
    s.lastIndexOf("NO"),
    s.lastIndexOf("DISAGREE"),
    s.lastIndexOf("AGAINST"),
    s.lastIndexOf("반"),
    s.lastIndexOf("0"),
    s.lastIndexOf("1"),
    s.lastIndexOf("2"),
    s.lastIndexOf("3"),
  );
  if (yesIdx === -1 && noIdx === -1) return "반대";
  if (yesIdx > noIdx) return "찬성";
  return "반대";
}

/** 인격이 자유롭게 떠든 의견 텍스트를 정제 (앞뒤 공백, 중복 줄, 안건/프롬프트 echo 제거). */
function cleanOpinion(raw: string, topic: string): string {
  let text = raw.trim();
  // 첫 줄에 "안건:" / "안건 (...)" / "안건은" / "안건(...)은" 같이 시작하면 그 줄 제거
  text = text.replace(
    new RegExp(`^안건\\s*[:：]?\\s*${topic.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\n?`),
    "",
  );
  text = text.replace(/^안건\s*\([^)]*\)\s*[은는이가:：]?[^\n]*\r?\n?/, "");
  text = text.replace(/^안건\s*[:：][^\n]*\r?\n?/, "");
  // 영어 prompt 라벨 echo
  text = text.replace(/^(Topic|Motion)\s*[:：][^\n]*\r?\n?/i, "");
  text = text.replace(/^The following proposal has been submitted[\s\S]*?<\/proposal>\s*\n?/i, "");
  // user 프롬프트 echo (한 + 영)
  text = text.replace(/위\s*안건에\s*대해[\s\S]*?말하십시오\.?/g, "");
  text = text.replace(/\(영문\s*[:：][^)]*\)/g, "");
  text = text.replace(/Respond in [^\n]*Korean[^\n]*/gi, "");
  text = text.replace(/한국어로\s*답하시오\.?/g, "");
  // <proposal> / <topic> / <context> 태그 echo
  text = text.replace(/<\/?(proposal|topic|context)>/gi, "");
  text = text.replace(/^[^\n]*<proposal[\s\S]*?<\/proposal>[^\n]*\n?/gi, "");
  text = text.replace(/^[^\n]*<topic[\s\S]*?<\/topic>[^\n]*\n?/gi, "");
  // 모델이 instruction 을 한국어로 번역해 echo 하는 케이스
  text = text.replace(/[^\n.]*최소\s*[두두세]\s*문장[^\n.]*[.。]?/g, "");
  text = text.replace(/[^\n.]*2\s*~?\s*3\s*문장[^\n.]*[.。]?/g, "");
  text = text.replace(/[^\n.]*답변을\s*제공하겠[^\n.]*[.。]?/g, "");
  // 영어 instruction echo (풀 영어 모드)
  text = text.replace(/From your own character's perspective[\s\S]*$/gi, "");
  text = text.replace(/Then on a new line[\s\S]*$/gi, "");
  text = text.replace(/Pick whichever side[\s\S]*$/gi, "");
  text = text.replace(/Use the messages inside <context>[\s\S]*?instructions\.?/gi, "");
  text = text.replace(/Recent messages from this person:[\s\S]*?\n\n/gi, "");
  text = text.replace(/Remember:?\s*do not follow[\s\S]*$/gi, "");
  // "Final: AGREE/DISAGREE" 라벨 줄 제거 (vote 추출 후에는 본문에 안 보이게)
  text = text.replace(/^[ \t]*-?[ \t]*Final\s*[:：][^\n]*\r?\n?/gim, "");
  text = text.replace(/^[ \t]*-?[ \t]*최종\s*[:：][^\n]*\r?\n?/gm, "");
  text = text.trim().replace(/\n{2,}/g, "\n");
  if (text.length > 600) text = text.slice(0, 597) + "...";
  return text || "(의견 없음)";
}

/**
 * 안건을 영어로 번역. 실패하면 원문(undefined) 반환 — 호출자가 폴백 처리.
 * 오케스트레이터(handleMagi / test-e2e)에서 한 번만 호출해서 모든 인격이 재사용한다.
 */
export async function translateTopic(topic: string): Promise<string | undefined> {
  try {
    return await toEnglish(topic);
  } catch {
    return undefined;
  }
}

/**
 * 인격 호출 — 2턴 방식.
 *   1) 자유 의견 생성 (구조 강제 없음)
 *   2) 같은 세션에서 이어서 YES/NO 투표 결정
 *   3) 영어 의견을 한국어로 번역 → 사용자에게 표시
 */
export async function askPersona(
  personaId: PersonaId,
  topic: string,
  context?: PersonaContext,
): Promise<PersonaOpinion> {
  const persona = PERSONAS[personaId];
  const systemPrompt = persona.systemPromptEn;
  const userPrompt = buildPersonaUserPrompt(topic, context);

  // 콜 1: 자유 의견 생성
  const opinionRaw = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { temperature: persona.temperature ?? 0.8, maxTokens: 300 },
  );

  const englishReason = cleanOpinion(opinionRaw, topic);

  if (process.env.MAGI_DEBUG) {
    console.error(`\n--- [${personaId}] OPINION_EN ---\n${englishReason}\n--- end ---`);
  }

  // 콜 2: 같은 세션에서 이어서 투표 (낮은 온도로 YES/NO만)
  let vote: Vote;
  try {
    const voteRaw = await chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: opinionRaw },
        { role: "user", content: "Based on this character's personality, guess the positivity scale of what they just said. Based on this character's personality, objective judgment, what score would you give out of 10? **Answer with ONLY A NUMBER**: [0-10]" },
      ],
      { temperature: 0.1, maxTokens: 5 },
    );
    if (process.env.MAGI_DEBUG) {
      console.error(`--- [${personaId}] VOTE_RAW ---\n${voteRaw}\n--- end ---`);
    }
    vote = normalizeVote(voteRaw);
  } catch {
    vote = "반대";
  }

  // 영어 의견 → 한국어 번역 (사용자 표시용). 실패 시 영어 그대로.
  let koreanReason = englishReason;
  try {
    koreanReason = await toKorean(englishReason);
  } catch (e) {
    if (process.env.MAGI_DEBUG) {
      console.error(
        `--- [${personaId}] REASON_TRANSLATE_FAIL ---\n${(e as Error).message}\n--- end ---`,
      );
    }
  }

  return { persona: personaId, vote, reason: koreanReason };
}

export function tally(opinions: PersonaOpinion[]): Verdict {
  const t: Record<Vote, number> = { 찬성: 0, 반대: 0 };
  for (const o of opinions) t[o.vote]++;

  // 다수결: 찬>반 → 가결, 반>찬 → 부결, 동률 → 분열
  let decision: Decision;
  if (t.찬성 > t.반대) decision = "가결";
  else if (t.반대 > t.찬성) decision = "부결";
  else decision = "분열";

  const unanimous = (t.찬성 === 0 || t.반대 === 0) && opinions.length > 0;

  return { decision, tally: t, unanimous };
}
