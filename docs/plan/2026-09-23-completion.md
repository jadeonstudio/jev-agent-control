# jev-agent-control 완성 계획 (2026-09-23)

출처: trader 세션(Astra 대전)이 전달한 owner 제이드의 작업 지시서. 원본 사본은 trader 세션 scratchpad `jev-completion-prompt.md`에 있다.
이 저장소의 `AGENTS.md`·`CLAUDE.md`·`SECURITY.md`·`docs/TRAINING_DATA.md` 안전 규칙이 이 계획보다 우선한다.

## 목표

```text
Codex / Claude / 직접 만든 실행기
  → (자동 호출: hook·dispatcher)
  → 공통 Decision Control Layer (OFF/SHADOW/ON, 범위·예산·검증·채택)
  → 명시적으로 선택한 provider (Jev TypeSafe API │ Laya 공식 Python 상주 worker)
  → Decision + 모델·checkpoint 출처
  → 별도 실제 작업 실행 (호스트 서브에이전트/역할)
  → Outcome
  → Evaluation (객관 측정·사람 교정 = 강한 라벨, 에이전트 자기보고 = 약한 라벨)
  → 검증된 canonical dataset → Laya 학습 형식 export
  → 학습 → 평가·자격 → shadow 비교 → 명시적 교체 (반복)
```

- G1: jev/laya가 "어떤 역할·모델·reasoning으로 이 작업을 맡길지"를 정한다.
- G2: 판단이 필요한 지점에서 에이전트가 기억에 의존하지 않고 자동으로 jev/laya를 거친다.
- G3: Laya가 쌓인 검증 데이터로 계속 학습해 성장한다.

## 기준선 (2026-09-23 확인)

- main `784e9e5`, 작업 트리 clean. 설치본 `~/.local/share/jev-agent-control/repository`도 `784e9e5`.
- 호스트 버전: `codex-cli 0.154.0`, `Claude Code 2.1.237`.
- Codex 역할 `~/.codex/agents/*.toml`: scout, lightweight_worker, implementer(`gpt-5.6-terra`/medium), verifier, specialist, antigravity_bridge.
- Claude 역할 `~/.claude/agents/*.md`: scout(haiku), lightweight-worker(haiku), implementer(sonnet), verifier(sonnet), specialist(opus), antigravity-bridge(haiku) 외 다수.
- 라우팅: `src/routing.mjs` chooseRoute는 tier → `features.json` `router.profiles[host][tier].model`. routeGuard는 사용 가능 모델 2개 미만이면 위임한다. 저장소 기본값(`features.example.json`)은 두 호스트 모두 비어 있고, 실제 JEV_HOME의 features.json은 codex만 채워져 있다(luna/terra/sol).
- 실제 JEV_HOME 상태(`jev-control status`, 2026-09-23): global mode `on`, router `on`, training capture `on`, provider `jev`. owner가 켠 상태이며 이 작업은 바꾸지 않는다. 모든 개발 테스트는 임시 JEV_HOME을 쓴다.
- G2 자동 호출 경로, G3 학습·자격 생성·등록·교체 경로는 없다.

## 저장소 계약과의 충돌 (2026-09-23 owner 결정으로 개정)

지시서는 저장소 안전 규칙이 우선한다고 명시했다. 현재 `AGENTS.md`는 아래를 범위 밖 또는 금지로 둔다.

| 지시서 단계 | 충돌하는 현재 계약 |
|---|---|
| P3 hook 설치, PreToolUse `updatedInput`으로 subagent_type/model 재작성 | `AGENTS.md:26` "not ... permission hooks, ... model proxies or blanket per-tool checks", `AGENTS.md:13` "Do not patch host internals or silently rewrite model configuration" |
| P3 `~/.codex/AGENTS.md`·`~/.claude/CLAUDE.md` 관리 블록 | `AGENTS.md:10` "Preserve all existing ... project instructions", README "기존 모델·다른 MCP·권한 설정은 보존" |
| P5 `laya promote`/`rollback` | `AGENTS.md:33` "No online training, automatic provider fallback, or checkpoint promotion" |

owner가 개정을 승인했다. P0 커밋에서 `AGENTS.md`를 개정했다: 소유 hook("Owned host hooks" 절)과 명시적 `laya promote`/`rollback`을 허용하고, hook은 거부·권한 응답을 하지 않으며 spawn 재작성에 필요한 `allow`만 반환한다. README·ARCHITECTURE의 "hook·promotion 없음" 서술은 아직 사실이므로, 해당 기능이 들어가는 P3·P5 커밋에서 함께 고친다.

## 설계 위험과 확정한 대응 (P2)

- **기존 사칭 경로(2026-09-23 코드 확인)**: `jev-control training outcome`은 stdin JSON을 `trust:'operator'`로 저장한다(`src/training/cli.mjs`, `store.outcome`). 비TTY 에이전트가 `source:'runner'`/`'human'`과 objective/human 라벨을 그대로 넣을 수 있다. 대응: CLI stdin outcome은 MCP와 같이 `trust:'host'`로 강제해 host_review로 낮춘다. 강한 라벨은 아래 두 경로와 in-process 라이브러리 runner(`store.outcome`, AEGIS 같은 직접 소유 runner)만 만든다.
- **`runner verify`의 명령 선택 문제**: jev가 명령을 직접 실행해도 명령을 에이전트가 고르면 `-- true` 같은 무의미한 검증으로 강한 결과를 만들 수 있다. 대응: owner가 TTY에서 등록한 **사전 등록 검증(assertion)**만 실행한다.
  - `jev-control runner allow`(TTY 전용): 이름, argv(셸 없음), 선택적 `purpose`·`question_id`·`pass_label`·`fail_label`을 `JEV_HOME/runner.json`(0600)에 등록한다.
  - `jev-control runner verify --decision <id> --check <name>`: 에이전트는 등록된 이름만 고른다. 명령·라벨 대응은 등록 내용에서 온다. purpose·question_id가 decision과 맞지 않으면 거부한다.
  - 기록: `source:'runner'` outcome, checks에 종료 코드·소요 시간·`sha256(argv, cwd, decision_id, 시작 시각)` 참조. question_id가 있는 검증만 `kind:'label'` check와 objective 라벨을 만든다. 출력 원문은 저장하지 않는다.
- **route 질문의 라벨 한계**: route decision의 질문은 intent/difficulty/risk다. 작업 성공·테스트 통과는 이 질문의 정답이 아니다(`docs/TRAINING_DATA.md` "라우팅 성공을 feature 정답으로 처리하지 않는다"). route 질문의 강한 라벨은 사람 교정(`training correct`)으로만 생긴다. runner 검증은 route 결과의 객관 outcome(품질·재시도·에스컬레이션)을 남기고, 라벨은 judge/retry/select처럼 질문과 명령 결과가 직접 대응하는 purpose에서만 만든다.
- **`training correct`의 TTY 검사**: Claude Bash는 TTY가 아니지만 PTY 기반 터미널에서 도는 에이전트는 TTY를 가진다. TTY만으로 사람임을 보장하지 못한다. SECURITY.md 위협 모델(동일 OS 사용자 제외)과 같은 경계로 문서에 명시한다. `runner allow`도 같은 경계다.

## 단계와 acceptance

상태 표기: 미착수 / 진행 중 / 국소 검증됨 / 동작 검증됨 / 완료 / 보류(승인 대기)

### P0. 기준선과 실측 — 완료 (Codex 역할 우선·Claude 재작성 네이티브 확정, Codex hook 재작성 네이티브 확인은 P3)
- [x] 계획 문서 작성
- [x] Codex spawn 모델 우선순위 실측 — 역할 TOML 우선 확정 (R1)
- [~] Codex PreToolUse updatedInput agent_type 재작성 — 공식 문서 근거 확보, 네이티브 확인은 P3 (R2)
- [x] Claude PreToolUse(matcher Agent) updatedInput model 재작성 실측 — 적용 확정 (R3)
- acceptance: 두 호스트에서 "역할/모델을 hook으로 바꿀 수 있는가"를 증거와 함께 확정하고 아래 실측 기록에 남긴다.

### P1. 역할 단위 라우팅 (G1) — 국소 검증됨
- 결과(2026-09-23): features.json v2(target `{role, model?, reasoning?, skills?}`, `intents` 오버라이드는 economy/standard에서만), v1 메모리 내 자동 이전(실패 시 fail-closed), `availableRoles` 필수·`availableModels` 선택, `policy roles --host` 프리셋(파일명만 탐색), status/doctor `ROUTER_PROFILE_EMPTY`·`ROUTER_ROLE_MISSING` 경고.
- 검증: 테스트 213/213, check 45 모듈, smoke, 예제 3종, Laya worker 4/4. 실제 JEV_HOME과 같은 v1 codex profile 픽스처가 lightweight_worker/implementer/specialist로 이전됨. 실제 `~/.codex/agents`·`~/.claude/agents` 대상 `policy roles --dry-run`에서 두 호스트 모두 누락 역할 0.
- 남은 것: 실제 JEV_HOME 정책은 아직 v1이고, 설치본이 갱신되는 P6 전까지 그대로 둔다. MCP 클라이언트가 `availableRoles`를 보내는지는 P3 hook·네이티브 세션에서 확인한다.
- profiles를 tier → `{ role, model?, reasoning? }`로 확장, 스키마 버전 올림, 기존 codex profile 자동 이전, 이전 실패 시 fail-closed.
- Codex: economy→lightweight_worker, standard→implementer, strong→specialist, 조사 전용 intent→scout.
- Claude: economy→lightweight-worker/haiku, standard→implementer/sonnet, strong→specialist/opus. fable 제외.
- routeGuard 사용 가능 판정을 "보유 역할 2개 이상"으로 바꾸고 `availableRoles` 입력 추가.
- doctor/status가 빈 profile·미보유 역할을 경고.
- 모델 ID·역할 이름은 TypeSafe로 보내지 않는다.
- acceptance: 두 호스트 profile로 route 결과에 role이 나오고, 미보유 역할이면 `TARGET_UNAVAILABLE`로 위임. 테스트 추가.

### P2. 결정↔실행 연결과 결과 기록 — 국소 검증됨
- 결과(2026-09-23): CLI `training outcome`을 host_review로 강제. `runner allow|list|remove|verify`(`JEV_HOME/runner.json`, TTY 등록, 셸 없는 직접 실행, 출력 미저장, `TYPESAFE_API_KEY` 제거, 정상 종료일 때만 라벨, route purpose 라벨 등록 거부). `training correct`(TTY). `src/training/links.mjs` 연결 인덱스(30일, 1만 개 상한)와 `recordSubagentStop`(completed=uncertain, failed/interrupted=fail). 최소 표본 게이트(`minStrongLabelsPerPurpose` 기본 100, 변경은 TTY, `--allow-small`은 manifest에 기록, 빈 split export 거부).
- runner verify outcome은 `executed:false, final:true`인 독립 annotation이다. evaluate.mjs의 실행 일치·품질 판정은 `executed:true`에서만 켜지므로 검증이 "예측을 실행했다"고 주장하지 않는다.
- 검증: 테스트 234/234, check 49 모듈, smoke, 예제 3종, Laya worker 4/4. 합성 end-to-end(judge decision → runner verify → evaluate → build → export) 강한 라벨 확인, 사칭 음성 테스트 포함.
- 남은 것: `recordSubagentStop`은 P3 hook에서 연결된다. SubagentStop outcome을 `executed:false`로 둔 것은 P4 "추천을 따랐을 때 실패율" 측정과 함께 다시 본다.
- hook 입력 `tool_use_id`/`agent_id` ↔ `decision_id` 최소 인덱스(원문 없음, 보존 기한).
- `jev-control runner allow`(TTY) / `jev-control runner verify --decision <id> --check <name>`: 사전 등록 검증만 jev가 직접 실행, 종료 코드·소요 시간·명령 해시를 `source:'runner'`로 기록. 출력 원문 저장 안 함. 호출자 결과 주입 불가. (위 "설계 위험과 확정한 대응")
- CLI `training outcome` stdin은 host_review로 강제.
- `jev-control training correct --decision <id>`: 비TTY 거부, `source:'human'`.
- SubagentStop hook: 완료·실패·중단을 host_review로 기록.
- 최소 표본 게이트: purpose별 강한 라벨 최소 수 미달 시 build/export 거부, `--allow-small` 명시만 허용, 빈 split export 거부.
- acceptance: 합성 시나리오 route → 실행 → runner verify → evaluate → build → export가 강한 라벨로 끝까지 이어짐. 사칭 경로(MCP, 비TTY correct, 결과 주입) 음성 테스트.

### P3. 호스트 자동 연결 설치기 (G2) — 동작 검증됨(발화·기록·원복·재적용), route 경로 네이티브 확인은 P4
- 설계 결정(2026-09-23):
  - **맥락 표시**: hook은 작업 범위·완결성을 알 수 없다. 임의로 local·complete로 채우면 AGENTS.md의 "맥락 오표기 금지"를 어긴다. 그래서 spawn 프롬프트/메시지에 `[jev scope=… complete=… failures=…]` 한 줄이 있을 때만 route를 부른다. 없으면 네트워크 없이 통과(`NO_CONTEXT_ANNOTATION`). 관리 지침 블록이 이 표시를 쓰도록 안내한다. 표시는 jev_route MCP 입력과 같은 에이전트 주장 수준이다.
  - **재작성 대상 제한**: 호출자가 고른 역할이 profile 역할 집합(tier + intents)에 있을 때만 route·재작성한다. verifier·web-researcher 같은 목적 역할과 Claude 기본 `general-purpose`는 건드리지 않는다(`ROLE_NOT_ROUTABLE`).
  - **Codex 재작성은 `agent_type`만**(R1). Codex 연결은 공식 필드가 없어 같은 session·역할의 60초 이내 대기 항목을 잇는 휴리스틱이며 이벤트에 `link:'heuristic'`로 남긴다.
  - **P3a 결과(국소 검증됨)**: `jev-control hook --host --event`(`src/hooks.mjs`). pre-spawn(역할·맥락 표시 확인 → route → ON에서만 `allow`+`updatedInput`), post-spawn(Claude tool_use→agent 연결), subagent-start(Codex 휴리스틱 연결), subagent-stop(host_review 기록). router OFF·global OFF·`JEV_DISABLE=1`이면 모든 이벤트가 즉시 통과. 메인 검토에서 두 결함을 고쳤다. ① 잘못된 인자가 종료 코드 2를 내는 문제: Claude PreToolUse에서 exit 2는 도구 차단이므로 `hook`을 bin 진입점에서 먼저 분기해 항상 exit 0으로 끝낸다. ② `tool_name`을 확인하지 않던 문제: spawn 도구(Claude `Agent`/`Task`, Codex `spawn_agent`)가 아니면 동작하지 않는다. 테스트 261/261. 로컬 in-process 지연은 워커 측정 약 6.6ms/호출이며, Node 기동·실제 네트워크 지연은 포함하지 않는다(실측 전 UNKNOWN).
  - **P3b 결과(국소 검증됨)**: `install --hooks`(Claude settings.json PreToolUse/PostToolUse(Agent)·SubagentStop, Codex hooks.json PreToolUse(Agent)·SubagentStart·SubagentStop, user 범위 지침 블록), `uninstall --hooks-only`, 보고(`hookChanges`·기존 그룹 해시 before/after·`reformatted`·`hostTrustRequired`, 파일 전체 미출력), doctor `hooks` 섹션. 메인 검토에서 기존 그룹 해시 비교가 계산만 되고 검사되지 않던 것을 고쳤다(`HOOK_PRESERVATION_FAILED`), 기록 없는 동일 그룹 중복 추가를 막았다(`HOOK_COLLISION`). 테스트 275/275.
  - 알려진 한계: Codex trust 키는 `<파일>:<이벤트>:<그룹 번호>:<handler 번호>`다. 우리 그룹은 끝에 붙어 기존 그룹 번호를 바꾸지 않지만, 우리 뒤에 다른 도구가 그룹을 추가한 뒤 우리를 제거하면 그 그룹 번호가 당겨져 Codex에서 재승인이 필요할 수 있다.
  - **실제 적용(2026-09-23, owner 승인)**: 설치본을 `jev-control off` → fast-forward(784e9e5→722dc14) → 설치본 테스트 277/277 → dry-run 검토 → 적용 순서로 갱신했다.
    - Codex: `install --target codex --hooks`. `~/.codex/hooks.json` 기존 그룹 4개 해시 보존, `config.toml` 불변. `uninstall --hooks-only` 후 `hooks.json`·`AGENTS.md`가 적용 전과 바이트 동일(sha256 앞 16자 f1d87d9b…/95ab0884…), 재적용 완료. trust는 `trust-entry-absent`라 owner의 Codex `/hooks` 승인 전까지 실행되지 않는다.
    - Claude: `~/.claude/skills`가 claude-forge(git 저장소)로 가는 심볼릭 링크라 기존 설치기가 `UNSAFE_SYMLINK`로 거부 → owner 결정으로 `--no-skills` 옵션을 추가(722dc14)해 MCP(`~/.claude.json`, 끝 줄바꿈만 추가됨)·hook(`~/.claude/settings.json`, 관련 이벤트 기존 그룹 9개 해시 보존)·관리 블록(`~/.claude/CLAUDE.md`)만 설치. 원복 시 바이트 동일(c3ce828e…/66b0907b…), 재적용 완료.
    - Claude 네이티브 발화(동작 검증됨): 잠깐 global SHADOW로 두고 `claude -p`로 general-purpose 서브에이전트 1개를 띄웠다. hook 이벤트 3개(pre-spawn `ROLE_NOT_ROUTABLE`, post-spawn·subagent-stop `NO_LINKED_DECISION`)가 기록됐고 각 약 1ms, TypeSafe 호출 0. 비용 $0.105. 확인 후 global OFF 복귀.
    - Codex 네이티브 발화(동작 검증됨, 2026-09-23): owner `/hooks` 승인 후 확인 과정에서 두 결함을 실측으로 찾아 고쳤다.
      ① matcher `Agent`는 0.154.0에서 `spawn_agent`에 발화하지 않았다(공식 문서의 별칭 서술과 다름) → `Agent|.*spawn_agent.*`(e91594f), owner 재승인.
      ② 실제 PreToolUse `tool_name`은 `agentsspawn_agent`(구분자 없는 네임스페이스)였다. 새 진단 기록(a5e9324)이 `INVALID_HOOK_INPUT tool_name=agentsspawn_agent`로 드러냄 → 인식 수정(3b7975e).
      최종 확인: pre-spawn(`lightweight_worker` 인식 → `NO_CONTEXT_ANNOTATION`), subagent-start(`NO_PENDING_MATCH`), subagent-stop(`NO_LINKED_DECISION`) 각 약 1ms, TypeSafe 호출 0, 확인 후 global OFF.
    - P4 SHADOW 시작 후 route 경로 네이티브 확인(2026-09-23, owner 승인):
      - Claude(동작 검증됨): 맥락 표시가 있는 `implementer` spawn → TypeSafe 1회(0.71초) → `UNCERTAIN_DIMENSIONS`(추천 없음) → post-spawn `LINKED`(agentId 추출) → subagent-stop `RECORDED`(host_review). 비용 $0.209.
      - Codex(불가 확정): 0.154.0은 hook에 `spawn_agent.message`를 불투명 토큰(`gAAAA…`)으로 넘긴다. 새 진단 `prompt_form:'opaque'`로 확인(9c90627). Codex hook은 작업 내용·맥락 표시를 읽을 수 없어 역할을 판단하지 않는다. Codex G1은 관리 블록 안내대로 spawn 전 `jev_route` 명시 호출로만 가능하고(기억 의존), hook은 SubagentStart/Stop 기록과 역할 분포만 담당한다. Codex 관리 블록 문구를 이 사실에 맞게 바꿨다.
      - 아직 미확인: ON 재작성(Claude), Codex pending 연결(Codex route가 hook에서 일어나지 않으므로 해당 없음).
    - 한계: hook 명령과 기존 MCP 설정 모두 Homebrew 버전 경로 node(`/opt/homebrew/Cellar/node/26.5.0_1/bin/node`)를 쓴다. `brew upgrade node` 후에는 재설치가 필요하다.
  - **데이터 외부 전송**: provider가 jev이면 hook이 route할 때 spawn description+프롬프트 앞부분(최대 8000바이트)이 TypeSafe로 전송된다. 기존 비밀값 검사(best-effort)는 그대로 적용된다. provider가 laya이면 로컬에서 끝난다. P3b 적용 승인과 P4 SHADOW 승인 때 owner에게 이 전송을 명시한다.
- installer `--hooks`: 소유 표식 항목만 추가·제거, 기존 hook 순서·내용 보존, 충돌 시 실패, dry-run diff.
- Codex `~/.codex/hooks.json`: PreToolUse(spawn_agent) route 조회, SubagentStop 결과 기록.
- Claude `~/.claude/settings.json`: PreToolUse(Agent) route 조회(ON이면 updatedInput, modelLocked 존중), SubagentStop 결과 기록.
- hook은 fail-open, 기존 timeoutMs 이내, 전역 OFF·`JEV_DISABLE=1`이면 즉시 통과.
- `~/.codex/AGENTS.md`·`~/.claude/CLAUDE.md` 설치기 소유 짧은 블록, uninstall 시 블록만 제거.
- Claude MCP·스킬 `install --target claude`, 새 세션에서 `jev_agent_control` 노출 확인.
- acceptance: 두 호스트 dry-run → 승인 → 적용 → 새 세션 hook 발화·기록 확인 → uninstall 원복 → 재적용. 기존 hook 해시 보존.

### P4. SHADOW 운영과 측정 — SHADOW 운영 중(2026-09-23 owner 승인, global SHADOW·router on·Claude profile 추가), ON 기준 미충족(표본 수집 중)
- ON 전환 기준(사전 등록, 2026-09-23). SHADOW는 추천을 적용하지 않으므로 "추천을 따랐을 때의 결과"를 직접 관측할 수 없다. 이 한계를 전제로, 아래를 모두 만족할 때만 owner에게 ON을 제안한다. 전환 결정은 owner가 한다.
  1. 표본: 호스트별로 route 추천이 나온 pre-spawn이 100건 이상이다(`metrics.hooks.recommendations`).
  2. 불일치 검토: 추천 역할이 실제 역할보다 약한(하향) 불일치 중 30건 이상을 사람 교정(`training correct`)이나 사전 등록 runner 결과로 검토했고, 그중 "추천 역할로 충분했다"는 판정이 90% 이상이다. 30건 미만이면 판단하지 않는다(UNKNOWN).
  3. 일치 사례 결과: 추천과 실제가 같은 경우의 fail(host_review fail + runner 실패) 비율이 전체 비율보다 높지 않다. n<30이면 UNKNOWN.
  4. 에스컬레이션: 같은 세션에서 route된 spawn 뒤 10분 안에 strong 역할(specialist)을 추가로 띄운 비율이 SHADOW 기간 기준선보다 늘지 않는다. ON 전후를 비교하며, 수집 방법은 SHADOW 기간에 hook 이벤트로 기준선을 먼저 기록한다.
  5. 운영: hook p95 지연 ≤ 2500ms, route 오류·시간 초과 비율 < 5%, TypeSafe 사용량은 실측 토큰으로 보고한다(달러 환산은 owner 청구 데이터로만).
- 기준 충족 여부는 owner에게 보고만 하며, ON 전환·profile 변경은 owner 승인으로 한다.
- 승인 후 router SHADOW, 추천·실제 선택·결과 병렬 기록.
- metrics: 추천 분포, 위임 사유 분포, 추천-실제 불일치, 강한/약한 라벨 수, 호출당 지연·비용 실측.
- ON 전환 기준 사전 등록(최소 표본, 추천 추종 시 실패율 비악화, 에스컬레이션 비증가). 전환은 owner 승인.

### P5. Laya 성장 루프 (G3) — 국소 검증됨(합성 checkpoint·가짜 worker), 실제 가중치·학습 미실행
- P5b 학습 키트(63915a6): `training/laya-kit/`(공식 notebook 42626c3 기반, export 입력, 검사 스크립트, NOTICE, 한국어 가이드). 공식 notebook 근거로 학습 루프는 약 4–6분(지시서의 4–6시간은 오류). 패키지 버전 일부·전체 소요·Kaggle 할당·MPS 가능성은 UNKNOWN. MPS spike는 수행하지 않았다.
- P5a 수명주기: `jev-control laya register|holdout freeze|list|qualify|compare|promote|rollback|status`. 메인 검토에서 네 결함을 고쳤다. ① rollback을 연속 호출하면 되돌린 checkpoint가 게이트 없이 재적용됨 → promote 스택 방식 + `ROLLBACK_STATE_MISMATCH`. ② qualify와 compare의 holdout 불일치 허용 → `QUALIFICATION_HOLDOUT_MISMATCH`. ③ 자격 없는 활성과 서로 다른 임계값의 coverage를 비교하고 raw 망각 검사가 없음 → raw/selective 분리. ④ promote가 쓰는 calibrationVersion(144자)이 로더 80자 제한을 넘어 승격 즉시 providers.json이 무효가 되고, 검증 복제본과 오류 삼킴 때문에 드러나지 않음 → `validateProviderConfig` 공유, 오류 전파. 워커는 테스트를 구현 뒤에 작성했다고 보고했으며, 위 결함은 메인이 RED를 먼저 확인하고 고쳤다. 테스트 312/312.
- 트리거: `TRAINING_CANDIDATE_READY`(P4, a0b2162)는 알림만 한다.
- `training/laya-kit/`: export 파일로 학습하도록 고친 공식 notebook 스크립트, Kaggle T4×2 가이드, 버전·해시 고정. 클라우드 실행은 owner 승인.
- (선택) MPS 단일 장치 spike go/no-go.
- `laya register` / `laya qualify` / `laya promote` / `laya rollback`.
- 강한 라벨 기준 수 도달 시 metrics·doctor 알림만, 자동 학습·교체 없음.
- acceptance: 합성 checkpoint 픽스처로 register → qualify(합격·불합격) → promote → rollback, 고정 holdout 악화 시 promote 거부 음성 테스트.

### P6. 문서·배포·인계 — 미착수
- README, ARCHITECTURE, TRAINING_DATA 갱신, 사실 아닌 문장 같은 커밋에서 수정.
- 설치본 절차대로 갱신, 두 호스트 doctor, checksNotPerformed 그대로 보고.
- trader 인계 메모(문서만).

## 승인 게이트 기록

| 날짜 | 게이트 | owner 결정 |
|---|---|---|
| 2026-09-23 | 계약 개정(P3·P5) | 승인: AGENTS.md 개정. hook 기본 OFF·SHADOW, ON은 owner 승인, promote는 명시 명령 전용. README·ARCHITECTURE 같은 커밋에서 수정 |
| 2026-09-23 | P0 실측 사용량 | 승인: Codex·Claude 각 최소 1회. 실패 시 추가 실행 전 재확인 |
| 2026-09-23 | 설치본 갱신 | 승인: global OFF(이전 ON) → fast-forward → 테스트 → dry-run 후 적용 승인 |
| 2026-09-23 | Codex hook 적용 | 승인: dry-run 검토 후 적용, 원복·재적용 확인 |
| 2026-09-23 | Claude 설치 방식 | 결정: `--no-skills`로 MCP·hook·블록만 설치(claude-forge 저장소에 쓰지 않음) |
| 2026-09-23 | 네이티브 발화 확인 | 승인: 맥락 표시 없는 spawn으로 잠깐 SHADOW 확인 후 OFF 복귀 |
| 2026-09-23 | Codex matcher 변경 | 승인: `Agent|.*spawn_agent.*`로 재설치, owner `/hooks` 재승인 |
| 2026-09-23 | P4 SHADOW 시작 | 승인: global SHADOW, `policy roles --host claude`로 실제 features.json에 Claude profile 추가, 맥락 표시 spawn route 네이티브 확인 |
| 2026-09-23 | 단계 연속 진행 | 승인: P0→P6 연속. 전역 설정 쓰기·과금 호출·SHADOW/ON 전환·클라우드 학습은 게이트에서 멈춤 |

## 실측 기록

### R1. Codex spawn 모델 우선순위 — 확정 (2026-09-23, 네이티브 실행)

- 환경: `codex-cli 0.154.0`, `features.multi_agent_v2.enabled = true`, 메인 `gpt-6-astra`/high. 임시 폴더, `codex exec -s read-only`.
- 호출: `agents.spawn_agent {"agent_type":"lightweight_worker","model":"gpt-5.6-terra","fork_turns":"none",...}`.
- 증거: 자식 rollout `~/.codex/sessions/2026/09/23/rollout-2026-09-23T08-53-02-01a0cb89-84c1-...jsonl`의 `session_meta.agent_role = lightweight_worker`, `turn_context.model = gpt-5.6-luna`, `effort = medium`.
- 결론: **역할 TOML의 model·effort가 spawn 인자 model보다 우선한다.** spawn 인자 model은 조용히 무시된다(오류 없음). `~/.codex/AGENTS.md:53` 실측 메모와 일치하고, 공식 subagents 문서(developers.openai.com/codex/subagents, 2026-09-23 확인: 역할 파일 > spawn 명시값 > `[agents]` 기본값 > 부모 세션)와도 일치한다. 지시서가 말한 "공식 문서와의 충돌"은 없다.
- 설계 영향: Codex에서 모델을 바꾸는 유일한 수단은 **`agent_type`(역할) 선택**이다. hook의 `model` 재작성은 효과가 없다. P1 Codex profile은 role만 쓰고 model은 표시용 메타데이터로만 둔다.
- 사용량: 메인 input 107,916(cached 78,592), output 148 tokens + 자식 1턴.

### R2. Codex PreToolUse `updatedInput`로 `agent_type` 재작성 — 문서 근거 확보, 네이티브 확인은 P3로 이월

- 공식(developers.openai.com/codex/hooks, 2026-09-23): matcher `Agent`가 `spawn_agent`도 잡는다. `updatedInput`은 인자 객체 전체를 대체하며 반드시 `permissionDecision:"allow"`와 함께 반환해야 한다(다른 조합은 오류).
- trust: 새·변경 hook은 사용자가 `/hooks`에서 trust해야 실행된다. `trusted_hash` 구조·계산은 공식 문서에 없다(비공식: openai/codex#46210). `codex exec`에서 미승인 hook은 진단 없이 건너뛴다(비공식, 0.154.0 소스 근거).
- 설치기 영향: 설치기는 trust 값을 쓰지 않는다. 설치 후 사용자가 Codex `/hooks`에서 승인해야 하고, doctor는 "hook 등록됨 ≠ 실행됨"을 구분해 보고한다.
- 네이티브 실측을 지금 하려면 `--dangerously-bypass-hook-trust`가 필요하다. 이 플래그는 사용자가 일부러 미승인으로 둔 전역 hook까지 실행시킬 수 있어 쓰지 않는다. P3 설치 후 사용자가 trust한 상태에서 네이티브로 확인한다.
- SubagentStart/Stop 입력: `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, 공통 `session_id`·`turn_id`·`model`. 성공/실패 필드는 없다.

### R3. Claude PreToolUse(Agent) `updatedInput` model 재작성 — 확정 (2026-09-23, 네이티브 실행)

- 환경: Claude Code 2.1.237, 격리 폴더 project `.claude/settings.json`에 PreToolUse(matcher `Agent`)·SubagentStart·SubagentStop command hook. `claude -p --model haiku`.
- 호출: Agent `{subagent_type:"general-purpose", model:"haiku"}`. hook이 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{...,"model":"sonnet"}}}`를 반환.
- 증거: 서브에이전트 transcript `.../subagents/agent-a9971e1f76d6c4384.jsonl`의 assistant `model = claude-sonnet-5`. 세션 `modelUsage`에 `claude-sonnet-5`(output 4 tokens)가 추가로 잡힘. 요청값 haiku가 아닌 재작성 값이 적용됐다.
- 결론: **Claude는 PreToolUse `updatedInput`으로 서브에이전트 model을 바꿀 수 있다.** 1회 실측이며, 비공식 이슈(anthropics/claude-code#95769)가 말한 불안정성은 이번에 재현되지 않았다. P3 ON 모드는 계속 실측으로 감시한다.
- 연결 키 실측: PreToolUse에는 `tool_use_id`가 있고 `agent_id`는 없다. SubagentStart/Stop에는 `agent_id`가 있고 `tool_use_id`는 없다. 부모 transcript의 Agent tool_result(`toolUseResult`)에 `agentId`·`resolvedModel`이 있으므로, PostToolUse(Agent)의 tool_response로 `tool_use_id ↔ agent_id`를 잇는다. 공통 `session_id`·`prompt_id`도 있다.
- SubagentStop 입력 키: `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`, `effort`, `background_tasks`, `session_crons` 등. 성공/실패 필드는 없다.
- 사용량: 총 $0.2029(list 기준 환산값, 실제 청구 방식은 확인 불가). haiku 메인 + sonnet 서브 1턴.
