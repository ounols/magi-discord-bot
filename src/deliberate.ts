import { chat } from "./llm.js";
import {
  buildPersonaUserPrompt,
  buildVoteClassifierPromptEn,
  buildVoteClassifierPromptKo,
  PERSONAS,
  VOTE_CLASSIFIER_SYSTEM_EN,
  VOTE_CLASSIFIER_SYSTEM_KO,
  type PersonaContext,
  type PersonaId,
} from "./personas.js";
import { toEnglish } from "./translate.js";

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
  );
  const noIdx = Math.max(
    s.lastIndexOf("NO"),
    s.lastIndexOf("DISAGREE"),
    s.lastIndexOf("AGAINST"),
    s.lastIndexOf("반"),
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
  text = text.replace(/^Topic\s*[:：][^\n]*\r?\n?/i, "");
  // user 프롬프트 echo (한 + 영)
  text = text.replace(/위\s*안건에\s*대해[\s\S]*?말하십시오\.?/g, "");
  text = text.replace(/\(영문\s*[:：][^)]*\)/g, "");
  text = text.replace(/Respond in [^\n]*Korean[^\n]*/gi, "");
  text = text.replace(/한국어로\s*답하시오\.?/g, "");
  // <topic> 태그 echo
  text = text.replace(/<\/?topic>/gi, "");
  text = text.replace(/^[^\n]*<topic[\s\S]*?<\/topic>[^\n]*\n?/gi, "");
  // 모델이 instruction 을 한국어로 번역해 echo 하는 케이스
  text = text.replace(/[^\n.]*최소\s*[두두세]\s*문장[^\n.]*[.。]?/g, "");
  text = text.replace(/[^\n.]*2\s*~?\s*3\s*문장[^\n.]*[.。]?/g, "");
  text = text.replace(/[^\n.]*답변을\s*제공하겠[^\n.]*[.。]?/g, "");
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
 * Two-step 호출.
 * 1) 인격 system + 안건(한+영) → 자유 의견 (이게 사용자에게 보이는 reason)
 * 2) 분류기 system + (안건 + 의견) → 한 단어 vote
 *
 * topicEn 이 주어지면:
 *   - Step 1: 한국어/영어 두 표현을 함께 보여 단어 모호성 ↓
 *   - Step 2: 안건 재번역 생략, 의견만 번역 후 영어 분류기 호출
 * topicEn 이 없으면:
 *   - Step 1: 한국어 안건만
 *   - Step 2: 의견 번역도 시도. 실패 시 한국어 분류기로 graceful fallback
 */
export async function askPersona(
  personaId: PersonaId,
  topic: string,
  topicEn?: string,
  context?: PersonaContext,
): Promise<PersonaOpinion> {
  const persona = PERSONAS[personaId];

  // Step 1: 하이브리드 — topicEn 이 있으면 영어 system + 영어 안건 + "한국어로 답하라" 명시.
  // 번역 실패 폴백은 한국어 system + 한국어 안건.
  // context 가 있으면 user prompt 에 <context> 블록으로 포함.
  const systemPrompt = topicEn ? persona.systemPromptEn : persona.systemPromptKo;
  const opinionRaw = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildPersonaUserPrompt(topic, topicEn, context) },
    ],
    { temperature: 0.85, maxTokens: 300 },
  );
  const reason = cleanOpinion(opinionRaw, topic);

  if (process.env.MAGI_DEBUG) {
    console.error(`\n--- [${personaId}] OPINION ---\n${reason}\n--- end ---`);
  }

  // Step 2: 의견 번역 시도. 안건은 이미 번역돼 있으면 재사용, 아니면 같이 번역.
  let opinionEn: string | undefined;
  try {
    opinionEn = await toEnglish(reason);
  } catch (e) {
    if (process.env.MAGI_DEBUG) {
      console.error(
        `--- [${personaId}] OPINION_TRANSLATE_FAIL ---\n${(e as Error).message}\n--- end ---`,
      );
    }
  }

  // 분류기 선택: 안건+의견 둘 다 영어 표현이 있으면 영어 분류, 아니면 한국어 fallback
  let classifierSystem: string;
  let classifierUser: string;
  let usedLang: "en" | "ko";
  if (topicEn && opinionEn) {
    classifierSystem = VOTE_CLASSIFIER_SYSTEM_EN;
    classifierUser = buildVoteClassifierPromptEn(topicEn, opinionEn);
    usedLang = "en";
    if (process.env.MAGI_DEBUG) {
      console.error(`--- [${personaId}] OPINION_EN ---\n${opinionEn}\n--- end ---`);
    }
  } else {
    classifierSystem = VOTE_CLASSIFIER_SYSTEM_KO;
    classifierUser = buildVoteClassifierPromptKo(topic, reason);
    usedLang = "ko";
    if (process.env.MAGI_DEBUG) {
      console.error(`--- [${personaId}] CLASSIFIER_FALLBACK_KO ---`);
    }
  }

  let vote: Vote = "반대";
  try {
    const voteRaw = await chat(
      [
        { role: "system", content: classifierSystem },
        { role: "user", content: classifierUser },
      ],
      { temperature: 0.0, maxTokens: 10 },
    );
    if (process.env.MAGI_DEBUG) {
      console.error(`--- [${personaId}] VOTE_RAW (${usedLang}) ---\n${voteRaw}\n--- end ---`);
    }
    vote = normalizeVote(voteRaw);
  } catch (e) {
    if (process.env.MAGI_DEBUG) {
      console.error(`--- [${personaId}] VOTE_ERROR ---\n${(e as Error).message}\n--- end ---`);
    }
  }

  return { persona: personaId, vote, reason };
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
