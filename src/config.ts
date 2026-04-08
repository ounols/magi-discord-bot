import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 설정되지 않았습니다.`);
  return v;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    appId: required("DISCORD_APP_ID"),
    guildId: process.env.DISCORD_GUILD_ID || undefined,
  },
  llm: {
    baseUrl: (process.env.LLM_BASE_URL || "http://ai:3000").replace(/\/$/, ""),
    apiKey: required("LLM_API_KEY"),
    model: process.env.LLM_MODEL || "hf.co/LiquidAI/LFM2.5-350M-GGUF:Q8_0",
  },
};
