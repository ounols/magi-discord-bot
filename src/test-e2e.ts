// 디스코드 없이 MAGI 파이프라인 한 사이클을 콘솔에서 돌려보기 위한 일회성 스크립트.
// 사용: tsx src/test-e2e.ts "안건 문장"
import { askPersona, tally, translateTopic } from "./deliberate.js";
import { triage } from "./triage.js";

const topic = process.argv.slice(2).join(" ") || "인류는 AI를 두려워해야 하는가?";

function ms() {
  return new Date().toISOString().slice(11, 23);
}

(async () => {
  console.log(`\n[${ms()}] === MAGI E2E TEST ===`);
  console.log(`안건: ${topic}\n`);

  console.log(`[${ms()}] 트리아지 시작...`);
  const t0 = Date.now();
  const tr = await triage(topic);
  console.log(`[${ms()}] 트리아지 완료 (${Date.now() - t0}ms)`);
  console.log(`  level=${tr.level}  active=[${tr.activePersonas.join(", ")}]`);
  console.log(`  rationale: ${tr.rationale}\n`);

  console.log(`[${ms()}] 안건 영어 번역...`);
  const topicEn = await translateTopic(topic);
  console.log(`[${ms()}]   → ${topicEn ?? "(실패, 한국어 fallback)"}\n`);

  console.log(`[${ms()}] 인격 병렬 호출 시작...`);
  const t1 = Date.now();
  const opinions = await Promise.all(
    tr.activePersonas.map((id) => askPersona(id, topicEn ? topicEn : topic)),
  );
  console.log(`[${ms()}] 인격 호출 완료 (${Date.now() - t1}ms)\n`);

  for (const o of opinions) {
    console.log(`  [${o.persona}] ${o.vote}`);
    console.log(`    ${o.reason}\n`);
  }

  const v = tally(opinions);
  console.log(`[${ms()}] 판결: ${v.decision}${v.unanimous ? " (만장일치)" : ""}`);
  console.log(`  찬성=${v.tally.찬성}  반대=${v.tally.반대}`);
})().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
