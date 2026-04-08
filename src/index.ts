import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { config } from "./config.js";
import { askPersona, tally, translateTopic, type PersonaOpinion } from "./deliberate.js";
import { PERSONAS, type PersonaId } from "./personas.js";
import { triage } from "./triage.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VOTE_EMOJI: Record<string, string> = {
  찬성: "🟢",
  반대: "🔴",
};

const DECISION_EMOJI: Record<string, string> = {
  가결: "🟢",
  부결: "🔴",
  분열: "🟡",
};

const DECISION_COLOR: Record<string, number> = {
  가결: 0x4caf50,
  부결: 0xf44336,
  분열: 0xffc107,
};

interface MagiState {
  topic: string;
  level: "light" | "deep";
  rationale: string;
  active: PersonaId[];
  /** persona id → "thinking" | 결과 | undefined(아직 시작 전) */
  results: Map<PersonaId, "thinking" | PersonaOpinion>;
  verdict?: { decision: string; tally: Record<string, number>; unanimous: boolean };
}

function statusBanner(state: MagiState): string {
  if (state.verdict) {
    const v = state.verdict;
    const mark = DECISION_EMOJI[v.decision] ?? "⚪";
    return `**판결**: ${mark} **${v.decision}**${v.unanimous ? " (만장일치)" : ""}  ·  찬 ${v.tally.찬성} · 반 ${v.tally.반대}`;
  }
  // 진행 중
  const done = [...state.results.values()].filter((r) => r !== "thinking").length;
  return `_심의 중... (${done}/${state.active.length})_`;
}

function magiEmbed(state: MagiState): EmbedBuilder {
  // 색상: 판결이 나면 결과 색, 아니면 빨강(기동 중)
  let color = 0xff5252;
  if (state.verdict) {
    color = DECISION_COLOR[state.verdict.decision] ?? 0x9e9e9e;
  }

  const desc = [
    "```",
    "NERV / 인공진화연구소 — MAGI 의사결정 시스템",
    "```",
    `**안건**\n> ${state.topic}`,
    "",
    `**분류**: \`${state.level === "deep" ? "DEEP / 심오" : "LIGHT / 일상"}\`${state.rationale ? `  — _${state.rationale}_` : ""}`,
    `**활성 인격**: ${state.active.map((p) => `\`${p}\``).join(", ")}`,
    "",
    statusBanner(state),
  ].join("\n");

  const embed = new EmbedBuilder()
    .setTitle("𝕄𝔸𝔾𝕀 𝕊𝕐𝕊𝕋𝔼𝕄")
    .setDescription(desc)
    .setColor(color);

  for (const id of state.active) {
    const p = PERSONAS[id];
    const r = state.results.get(id);
    let value: string;
    if (!r) {
      value = "_대기 중..._";
    } else if (r === "thinking") {
      value = "_사고 중..._";
    } else {
      value = `${VOTE_EMOJI[r.vote]} **${r.vote}**\n> ${r.reason}`;
    }
    // discord 필드 value 1024자 제한
    if (value.length > 1020) value = value.slice(0, 1017) + "...";
    embed.addFields({ name: p.displayName, value });
  }

  return embed;
}

async function handleMagi(interaction: ChatInputCommandInteraction) {
  const topic = interaction.options.getString("주제", true);

  await interaction.deferReply();

  // 1) 트리아지
  let triageResult;
  try {
    triageResult = await triage(topic);
  } catch (e) {
    await interaction.editReply({
      content: `⚠️ 트리아지 단계 실패: ${(e as Error).message}`,
    });
    return;
  }

  // 2) 단일 임베드 상태 — 이후 모든 단계는 이 한 임베드를 editReply 로 갱신.
  const state: MagiState = {
    topic,
    level: triageResult.level,
    rationale: triageResult.rationale,
    active: triageResult.activePersonas,
    results: new Map(),
  };
  await interaction.editReply({ embeds: [magiEmbed(state)] });

  // 3) 안건 영어 번역 (한 번만, 모든 인격 + 분류기에서 재사용)
  const topicEn = await translateTopic(topic);

  // 4) 인격 병렬 호출, UI 는 순차 갱신
  const pending = new Map<PersonaId, Promise<PersonaOpinion>>();
  for (const id of triageResult.activePersonas) {
    pending.set(id, askPersona(id, topic, topicEn));
  }

  const opinions: PersonaOpinion[] = [];
  for (const id of triageResult.activePersonas) {
    state.results.set(id, "thinking");
    await interaction.editReply({ embeds: [magiEmbed(state)] });
    await sleep(900);

    let opinion: PersonaOpinion;
    try {
      opinion = await pending.get(id)!;
    } catch (e) {
      opinion = {
        persona: id,
        vote: "반대",
        reason: `(호출 실패: ${(e as Error).message.slice(0, 120)})`,
      };
    }
    opinions.push(opinion);
    state.results.set(id, opinion);
    await interaction.editReply({ embeds: [magiEmbed(state)] });
    await sleep(500);
  }

  // 4) 판결
  await sleep(600);
  state.verdict = tally(opinions);
  await interaction.editReply({ embeds: [magiEmbed(state)] });
}

client.once(Events.ClientReady, (c) => {
  console.log(`[MAGI] online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "magi") return;
  try {
    await handleMagi(interaction);
  } catch (e) {
    console.error("[MAGI] handler error", e);
    const msg = `⚠️ MAGI 시스템 오류: ${(e as Error).message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(config.discord.token);
