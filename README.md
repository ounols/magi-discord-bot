# MAGI

에반게리온의 MAGI 의사결정 시스템을 모방한 디스코드 봇.
LFM2.5-350M (OpenWebUI 호스팅) 위에서 세 인격이 안건에 찬반을 던집니다.

- **MELCHIOR** · 과학자로서의 나오코 — 논리·증거·효율
- **BALTHASAR** · 어머니로서의 나오코 — 보호·책임·장기영향
- **CASPER** · 여자로서의 나오코 — 욕망·자유·직관

가벼운 안건(심오함 ≤ 2)은 MELCHIOR + BALTHASAR 둘만, 무거운 안건은 셋이 모두 깨어납니다.
판정 자체도 같은 LFM2.5-350M 트리아지가 합니다.

## 구조

```
Discord ──gateway──▶ magi-bot (Node + discord.js)
                          │
                          ▼ HTTP (내부망)
                       ai:3000  (OpenWebUI / LFM2.5-350M)
```

LLM 엔드포인트를 외부에 노출하지 않기 위해 봇 자체를 컨테이너로 띄워 `ai` 와 같은 도커 네트워크에 붙입니다.

## 사용

```
/magi 주제: 인류는 AI를 두려워해야 하는가?
```

봇이 "MAGI 시스템 기동" 임베드 → 각 인격이 typing 후 순차적으로 의견 메시지 → 최종 판결 임베드 순으로 응답합니다.

## 셋업

### 1. Discord 앱 만들기

1. https://discord.com/developers/applications 에서 새 앱 생성
2. Bot 탭에서 토큰 발급 (`DISCORD_TOKEN`)
3. General Information 의 Application ID (`DISCORD_APP_ID`)
4. OAuth2 → URL Generator: `bot`, `applications.commands` 스코프 + `Send Messages` 권한으로 초대 URL 생성 후 서버에 초대

### 2. `.env` 작성

```bash
cp .env.example .env
# 값 채우기. 테스트 중에는 DISCORD_GUILD_ID 를 채워두면 명령이 즉시 반영됩니다.
```

### 3. 슬래시 명령 등록

로컬 Node 환경에서 한 번:

```bash
npm install
npm run register
```

또는 컨테이너 빌드 후:

```bash
docker compose run --rm magi-bot node dist/register-commands.js
```

### 4. 컨테이너 실행

```bash
# ai 컨테이너가 어떤 네트워크에 있는지 확인
docker network ls
# 그 이름을 docker-compose.yml 의 ai-net.name 에 적어주세요

docker compose up -d --build
docker compose logs -f magi-bot
```

`[MAGI] online as ...` 로그가 뜨면 준비 완료.

## 환경변수

| 이름 | 설명 |
|---|---|
| `DISCORD_TOKEN` | 봇 토큰 |
| `DISCORD_APP_ID` | 애플리케이션 ID |
| `DISCORD_GUILD_ID` | (선택) 길드 ID. 있으면 명령이 그 길드에만 즉시 등록됨 |
| `LLM_BASE_URL` | OpenWebUI base URL (기본 `http://ai:3000`) |
| `LLM_API_KEY` | OpenWebUI API 키 |
| `LLM_MODEL` | 모델명 (기본 `LFM2.5-350M`) |

## 로컬 개발

```bash
npm install
npm run dev
```

`tsx watch` 로 핫 리로드. `.env` 의 `LLM_BASE_URL` 을 LAN 호스트네임이나 `localhost:3000` 등으로 바꿔서 시험할 수 있습니다.

## 인격 / 트리아지 커스터마이즈

- 인격 프롬프트와 색상: `src/personas.ts`
- 심오함 점수 → 활성 인격 매핑: `src/triage.ts`
- 다수결 규칙: `src/deliberate.ts` 의 `tally()`

## 메모

- LFM2.5-350M 은 작은 모델이라 가끔 JSON 형식을 깨뜨립니다. `src/llm.ts` 의 `extractJson` 이 코드블록/혼합 텍스트 케이스를 흡수하고, 그래도 실패하면 원문을 reason 으로 노출합니다.
- OpenWebUI 의 OpenAI 호환 경로는 배포에 따라 `/api/chat/completions` 또는 `/v1/chat/completions` 입니다. 클라이언트가 자동으로 둘 다 시도합니다.
- 토론 결과의 색상: 찬성 🟢 / 반대 🔴.
