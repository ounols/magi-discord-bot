import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { config } from "./config.js";

// 슬래시 명령 빌더 — 동일한 동작을 가진 별칭(magi / 마기 / 질문)을 만들기 위한 헬퍼.
// DM 에서는 비활성화 (채팅 history 컨텍스트 기능이 길드 채널에서만 의미 있음).
function buildMagiSlash(name: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription("MAGI 시스템에 안건을 상정합니다.")
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName("주제")
        .setDescription("심의할 안건 / 질문")
        .setRequired(true)
        .setMaxLength(500),
    )
    .toJSON();
}

// 슬래시 명령 — 별칭 3개 (영문 + 한글). index.ts 핸들러가 셋 다 같은 함수로 분기한다.
const slashCommands = [
  buildMagiSlash("magi"),
  buildMagiSlash("마기"),
  buildMagiSlash("질문"),
];

// 메시지 컨텍스트 메뉴 — 채팅 메시지를 우클릭/길게 눌러 그 본문을 안건으로 사용
const messageContextCommand = new ContextMenuCommandBuilder()
  .setName("MAGI 심의")
  .setType(ApplicationCommandType.Message)
  .setDMPermission(false)
  .toJSON();

const commands = [...slashCommands, messageContextCommand];

const rest = new REST({ version: "10" }).setToken(config.discord.token);

async function main() {
  if (config.discord.guildId) {
    console.log(`[register] guild ${config.discord.guildId} 에 명령 등록 중...`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId),
      { body: commands },
    );
    console.log("[register] guild 등록 완료 (즉시 반영)");
  } else {
    console.log("[register] global 명령 등록 중... (반영까지 최대 1시간)");
    await rest.put(Routes.applicationCommands(config.discord.appId), {
      body: commands,
    });
    console.log("[register] global 등록 완료");
  }
  console.log(`[register] 총 ${commands.length}개 명령 등록됨:`);
  for (const c of commands) {
    console.log(`  - ${c.name}${"type" in c && c.type === 3 ? " (메시지 컨텍스트)" : ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
