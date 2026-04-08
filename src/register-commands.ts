import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "./config.js";

const command = new SlashCommandBuilder()
  .setName("magi")
  .setDescription("MAGI 시스템에 안건을 상정합니다.")
  .addStringOption((opt) =>
    opt
      .setName("주제")
      .setDescription("심의할 안건 / 질문")
      .setRequired(true)
      .setMaxLength(500),
  )
  .toJSON();

const rest = new REST({ version: "10" }).setToken(config.discord.token);

async function main() {
  if (config.discord.guildId) {
    console.log(`[register] guild ${config.discord.guildId} 에 명령 등록 중...`);
    await rest.put(
      Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId),
      { body: [command] },
    );
    console.log("[register] guild 등록 완료 (즉시 반영)");
  } else {
    console.log("[register] global 명령 등록 중... (반영까지 최대 1시간)");
    await rest.put(Routes.applicationCommands(config.discord.appId), {
      body: [command],
    });
    console.log("[register] global 등록 완료");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
