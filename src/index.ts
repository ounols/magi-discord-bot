import {
  ActivityType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Options,
  PresenceUpdateStatus,
  Sweepers,
  type ChatInputCommandInteraction,
  type MessageContextMenuCommandInteraction,
  type RepliableInteraction,
  type TextBasedChannel,
} from "discord.js";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "./config.js";
import { askPersona, tally, translateTopic, type PersonaOpinion } from "./deliberate.js";
import { PERSONAS, SUBJECT_LABEL_KO, type PersonaContext, type PersonaId } from "./personas.js";
import { toEnglish } from "./translate.js";
import { triage } from "./triage.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // 채널 메시지 fetch 용. MessageContent 는 privileged 이므로 Developer Portal 에서도 활성화 필요.
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // 캐시 상한 — 기본값은 사실상 무제한이라 장시간 켜두면 메모리가 단조 증가한다.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 200,
    PresenceManager: 0,
    GuildMemberManager: {
      maxSize: 200,
      keepOverLimit: (m) => m.id === m.client.user.id,
    },
  }),
  // 상시 청소 — idle 진입과 별개로 background sweeper 도 돌린다.
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: {
      interval: 300, // 5분
      lifetime: 600, // 10분 넘은 메시지 제거
    },
    users: {
      interval: 3600,
      filter: Sweepers.filterByLifetime({ lifetime: 3600 }),
    },
  },
});

/** 멘션된 사용자의 최근 메시지를 N개 가져와서 컨텍스트로 만든다. 실패/없으면 null. */
const MENTION_RE = /<@!?(\d+)>/;
const CONTEXT_LIMIT = 10;
/** URL 패턴 — http(s) 링크를 [링크] placeholder 로 치환해서 토큰 노이즈 제거 */
const URL_RE = /https?:\/\/\S+/gi;

/** 메시지 한 줄을 정제 — URL 만 [링크] 로 치환. 빈 문자열만 거른다. */
function sanitizeMessage(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return trimmed.replace(URL_RE, "[링크]").replace(/\s+/g, " ").trim();
}

async function fetchMentionContext(
  interaction: ChatInputCommandInteraction,
): Promise<{ userId: string; context: PersonaContext } | null> {
  const raw = interaction.options.getString("주제", true);
  const m = raw.match(MENTION_RE);
  if (!m) return null;
  const userId = m[1];

  // 채널 객체 확보 — interaction.channel 이 null 이면 client.channels.fetch 로 가져온다
  let channel: TextBasedChannel | null = null;
  if (interaction.channel?.isTextBased()) {
    channel = interaction.channel;
  } else if (interaction.channelId) {
    try {
      const fetchedChannel = await interaction.client.channels.fetch(interaction.channelId);
      if (fetchedChannel?.isTextBased()) {
        channel = fetchedChannel;
      } else {
        return null;
      }
    } catch (e) {
      console.error("[MAGI/context] channel fetch failed:", e);
      return null;
    }
  }

  if (!channel) return null;

  let fetched;
  try {
    fetched = await channel.messages.fetch({ limit: 100 });
  } catch (e) {
    console.error("[MAGI/context] history fetch failed:", e);
    return null;
  }

  // 그 사용자의 메시지만 (최신순), URL 은 [링크] 로 치환
  const sanitized: string[] = [];
  for (const msg of fetched.values()) {
    if (msg.author.id !== userId) continue;
    const cleaned = sanitizeMessage(msg.content);
    if (cleaned) sanitized.push(cleaned);
    if (sanitized.length >= CONTEXT_LIMIT) break;
  }
  if (sanitized.length === 0) return null;

  // 사용자 표시명
  let username = userId;
  try {
    const member = await interaction.guild?.members.fetch(userId);
    username = member?.displayName ?? (await interaction.client.users.fetch(userId)).username;
  } catch {}

  // 시간순(오래된 것 → 최신) 정렬해서 자연스러운 흐름으로
  const lines = sanitized
    .reverse()
    .map((msg, i) => `${i + 1}. ${msg}`)
    .join("\n");

  return {
    userId,
    context: { username, messages: lines },
  };
}

/**
 * 안건 문자열 안의 <@id> 멘션 마커를 익명 라벨("이 사람")로 치환.
 * 실제 username 은 모델 컨텍스트에 절대 들어가지 않게 하기 위함 — 사용자명에 들어 있을 수 있는
 * 명령형 단어, 욕설, 의미 불명 토큰 등이 모델 추론을 오염시키는 것을 차단한다.
 * 다른 사용자의 멘션(컨텍스트로 잡지 않은 사람)도 같이 익명화한다.
 */
function humanizeMentions(topic: string): string {
  return topic.replace(/<@!?\d+>/g, SUBJECT_LABEL_KO);
}

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
  active: PersonaId[];
  /** persona id → "thinking" | 결과 | undefined(아직 시작 전) */
  results: Map<PersonaId, "thinking" | PersonaOpinion>;
  verdict?: { decision: string; tally: Record<string, number>; unanimous: boolean };
  /** 멘션된 사용자의 채팅 기록 컨텍스트 (있으면 임베드에 표기) */
  context?: PersonaContext;
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
    `## 안건 : ${state.topic} ${state.context ? ` (feat. ${state.context.username})` : ""}`,
    "",
    "",
    state.context
      ? `**참고 컨텍스트**: \`@${state.context.username}\` 의 최근 메시지 ${state.context.messages.split("\n").length}개`
      : "",
    "",
    statusBanner(state),
  ].filter((l) => l !== "").join("\n");

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

// 동시 심의 방지 — LLM 백엔드는 한 번에 한 건만 처리한다고 가정.
// 핸들러에서 진입 직후 isBusy() 로 거르고, runMagi 는 try/finally 로 플래그를 보장한다.
// 워치독: runMagi 가 어떤 이유로든 (Discord API hang, 네트워크 stall 등) 끝나지 않을 경우
// 플래그가 영원히 잠기는 것을 막는다. 정상 심의는 길어야 60초 안쪽이므로 120초면 충분.
const MAGI_WATCHDOG_MS = 120_000;
let magiBusy = false;
let magiWatchdog: NodeJS.Timeout | null = null;
function isBusy(): boolean {
  return magiBusy;
}
function clearMagiWatchdog() {
  if (magiWatchdog) {
    clearTimeout(magiWatchdog);
    magiWatchdog = null;
  }
}
async function rejectBusy(interaction: RepliableInteraction) {
  await interaction
    .reply({
      content: "⚠️ MAGI 가 이미 다른 안건을 심의 중입니다. 잠시 후 다시 시도해 주세요.",
      flags: MessageFlags.Ephemeral,
    })
    .catch(() => {});
}

/** MAGI 핵심 파이프라인 — 슬래시 명령과 메시지 컨텍스트 명령이 공유. */
async function runMagi(
  interaction: RepliableInteraction,
  topic: string,
  context?: PersonaContext,
) {
  magiBusy = true;
  clearMagiWatchdog();
  magiWatchdog = setTimeout(() => {
    console.error("[MAGI] watchdog fired — forcing busy flag release after stall");
    magiBusy = false;
    magiWatchdog = null;
  }, MAGI_WATCHDOG_MS);
  magiWatchdog.unref();
  try {
  await interaction.deferReply();

  // 1) 단일 임베드 상태 — 이후 모든 단계는 이 한 임베드를 editReply 로 갱신.
  const state: MagiState = {
    topic,
    active: ["MELCHIOR", "BALTHASAR", "CASPER"],
    results: new Map(),
    context,
  };
  await interaction.editReply({ embeds: [magiEmbed(state)] });

  // 2) 안건 영어 번역 (한 번만, 모든 인격 + 분류기에서 재사용)
  // context 가 있으면 messages 도 한 블록으로 같이 번역.
  const [topicEn, contextEn] = await Promise.all([
    translateTopic(topic),
    context ? toEnglish(context.messages).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  if (context && contextEn) {
    context.messagesEn = contextEn;
  }

  // 4) 인격 병렬 호출, UI 는 순차 갱신
  const pending = new Map<PersonaId, Promise<PersonaOpinion>>();
  for (const id of state.active) {
    pending.set(id, askPersona(id, topicEn ? topicEn : topic, context));
  }

  const opinions: PersonaOpinion[] = [];
  for (const id of state.active) {
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

  // 5) 판결
  await sleep(600);
  state.verdict = tally(opinions);
  await interaction.editReply({ embeds: [magiEmbed(state)] });
  } finally {
    clearMagiWatchdog();
    magiBusy = false;
  }
}

/** 슬래시 명령 진입점 — /magi 주제: ... */
async function handleMagiSlash(interaction: ChatInputCommandInteraction) {
  if (isBusy()) {
    await rejectBusy(interaction);
    return;
  }

  let topic = interaction.options.getString("주제", true);

  // 모든 <@id> 멘션을 익명 라벨로 치환 (멘션이 있든 없든)
  topic = humanizeMentions(topic);

  // 멘션이 있으면 그 사용자의 채팅 기록을 컨텍스트로 가져옴
  const mention = await fetchMentionContext(interaction);
  if (mention) {
    await runMagi(interaction, topic, mention.context);
    return;
  }

  await runMagi(interaction, topic);
}

/** 메시지 컨텍스트 메뉴 진입점 — 메시지 우클릭 → Apps → MAGI 심의 */
async function handleMagiMessage(interaction: MessageContextMenuCommandInteraction) {
  if (isBusy()) {
    await rejectBusy(interaction);
    return;
  }

  const msg = interaction.targetMessage;
  // 메시지 본문 추출. content 가 비어 있으면(첨부파일/임베드만 있는 메시지) 거부.
  const raw = (msg.content || "").trim();
  if (!raw) {
    await interaction.reply({
      content: "⚠️ 이 메시지에는 분석할 텍스트가 없습니다 (첨부파일/임베드만 있는 메시지).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // 너무 길면 자르기 (안건은 짧을수록 350M 이 잘 다룬다)
  const topic = raw.length > 500 ? raw.slice(0, 497) + "..." : raw;
  await runMagi(interaction, topic);
}

// ────────────────────────────────────────────────────────────────────────────
// Idle state machine — 일정 시간 인터랙션이 없으면 캐시/소켓을 비워서 RSS 회수.
// 다음 인터랙션이 들어오면 자동으로 active 로 복귀하고, undici 는 새 연결을 맺는다.
// ────────────────────────────────────────────────────────────────────────────
const IDLE_AFTER_MS = 10 * 60 * 1000; // 10분
const IDLE_CHECK_MS = 60 * 1000;
let lastActivityAt = Date.now();
let isIdle = false;

function markActive() {
  lastActivityAt = Date.now();
  if (!isIdle) return;
  isIdle = false;
  client.user?.setPresence({ status: PresenceUpdateStatus.Online });
  console.log("[MAGI] active");
}

async function goIdle() {
  if (isIdle) return;
  isIdle = true;
  console.log("[MAGI] entering idle");

  client.user?.setPresence({
    status: PresenceUpdateStatus.Idle,
    activities: [{ name: "대기 중", type: ActivityType.Custom }],
  });

  // discord.js 캐시 강제 sweep — 남은 메시지/유저 캐시를 전부 비운다.
  try {
    client.sweepers.sweepMessages(() => true);
    client.sweepers.sweepUsers(() => true);
  } catch (e) {
    console.error("[MAGI/idle] sweep failed:", e);
  }

  // undici 글로벌 dispatcher 교체 → 기존 keep-alive 소켓을 닫는다.
  // llm.ts 의 chat() 은 다음 호출에서 새 dispatcher 로 자동 연결.
  try {
    const old = getGlobalDispatcher();
    setGlobalDispatcher(new Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 30_000 }));
    await old.close().catch(() => {});
  } catch (e) {
    console.error("[MAGI/idle] dispatcher reset failed:", e);
  }

  // node --expose-gc 로 띄웠을 때만 동작 (없어도 OK).
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === "function") maybeGc();
}

setInterval(() => {
  if (Date.now() - lastActivityAt >= IDLE_AFTER_MS) {
    void goIdle();
  }
}, IDLE_CHECK_MS).unref();

client.once(Events.ClientReady, (c) => {
  console.log(`[MAGI] online as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  markActive();
  try {
    if (interaction.isChatInputCommand() && (interaction.commandName === "magi" || interaction.commandName === "마기" || interaction.commandName === "질문")) {
      await handleMagiSlash(interaction);
      return;
    }
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === "MAGI 심의") {
      await handleMagiMessage(interaction);
      return;
    }
  } catch (e) {
    console.error("[MAGI] handler error", e);
    if (!interaction.isRepliable()) return;
    const msg = `⚠️ MAGI 시스템 오류: ${(e as Error).message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(config.discord.token);
