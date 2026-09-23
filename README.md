# Jev Agent Control

Codex / Claude Code가 같은 **선택적 판단 제어 계층**을 사용하는 로컬 MCP 서버·스킬·CLI입니다. v0.3은 **Jev(TypeSafe API) / 공식 Laya(선택적 로컬 Python worker)**를 명시적으로 선택하고, 판단과 실제 작업 결과를 연결해 향후 offline fine-tuning용 데이터를 준비합니다.

**Node.js 22+ · macOS/Linux/WSL · Node 런타임 의존 패키지 0개 · 추론 기본 OFF · Training Capture 기본 OFF**

Jev 전용 사용에는 Python이 필요하지 않습니다. Laya는 별도로 준비한 공식 Python 런타임과 로컬 모델이 필요합니다. classifier.dev 서비스·SDK·프록시를 호출하지 않습니다. 온라인 학습, 자동 provider cascade, 자동 모델 다운로드·업데이트는 없습니다. Laya checkpoint 교체는 오직 명시적인 `jev-control laya qualify`/`compare`/`promote` 호출로만 일어나며, 학습 실행 코드 자체는 이 저장소에 없습니다(별도 `training/laya-kit/`).

> 설치를 요청받은 에이전트는 [AGENTS.md](AGENTS.md)를 먼저 읽으세요. 기존 branch·미커밋 변경·설정을 보존하고, 키를 채팅으로 요청하거나 출력하지 않습니다. URL만으로 권한 없는 다른 컴퓨터에 설치되는 구조는 아닙니다.

## 설치·업데이트

```sh
git clone https://github.com/jadeonstudio/jev-agent-control.git
cd jev-agent-control
# 개발 브랜치의 v0.3을 검토할 때만:
# git switch feat/decision-training-capture
node scripts/check.mjs
node --test tests/*.test.mjs
node bin/jev-control.mjs smoke
node examples/fast-path.mjs
node examples/classifier-design.mjs
node examples/training-pipeline.mjs
node bin/jev-control.mjs install --target both --dry-run
node bin/jev-control.mjs install --target both
# 선택: 소유 host hook + 짧은 관리 지침 블록까지 설치할 때만 (dry-run diff를 먼저 검토)
node bin/jev-control.mjs install --target both --hooks --dry-run
node bin/jev-control.mjs install --target both --hooks
node bin/jev-control.mjs doctor
```

안정적으로 보관할 폴더를 사용하세요. 실행 파일은 clone을 참조하므로 폴더를 지우면 안 됩니다. Jev 경로 설치에는 sudo/npm 설치/curl-pipe가 필요 없습니다. 이미 clone이 있으면 다시 만들지 않고 remote·branch·로컬 변경을 확인합니다. 기존 설치는 **OFF → 변경 검토 → 해당 branch fast-forward 업데이트 → 테스트 → 재설치 → 호스트 재연결** 순서입니다. 사용자 변경을 덮어쓰거나 main에 임의 병합하지 않습니다.

두 호스트 각각 MCP 목록의 `jev_agent_control`을 확인하고 새 세션/MCP 재연결로 스킬을 로드하세요. 기존 모델·다른 MCP·권한 설정은 보존합니다. 단일 호스트는 `--target codex|claude`, 프로젝트 범위는 `--scope project --project /absolute/project/path`입니다. 기본 사용자 전체 설치이며 다른 Claude 프로필(`CLAUDE_CONFIG_DIR`)은 프로젝트 범위를 사용합니다.

## 실제 구조와 한계

```text
Codex / Claude / 직접 소유한 runner
                ↓
공통 OFF·SHADOW·ON / 범위·예산·검증·채택 정책
                ↓
provider=jev → TypeSafe HTTPS
provider=laya → 공식 Python 상주 worker
                ↓
정규화된 decision + 모델/체크포인트 provenance
                ↓
명시적 수집 동의가 있으면 최소 Decision 저장
                ↓
별도 Outcome → Evaluation → Dataset → Laya export
                ↓
(별도 키트로 오프라인 학습) → laya register → holdout freeze → qualify → compare → promote → rollback
```

| MCP 도구 | 역할 |
|---|---|
| `jev_decide` | Choice / Noul / Score의 좁은 판단을 선택된 provider에 위임 |
| `jev_route` | intent/difficulty/risk → 로컬 정책 → 등록된 모델·reasoning·스킬 권고 |
| `jev_filter` | 선택적 snippet 분류. 불확실·필수·전수조사 자료 보존 |
| `jev_status` | 모드·provider·준비 상태. 키/학습 원문은 출력하지 않음 |
| `jev_feedback` | generic decision의 독립 기준 비교 |
| `jev_observe` | 라우터/필터 SHADOW 비교. 일치율은 정확도가 아님 |
| `jev_record` | 수집이 켜져 있을 때 최소 host baseline/outcome 기록. MCP outcome은 weak host_review |

하위 호환을 위해 `jev_*` 이름을 유지합니다. **MCP 설치만으로 메인 모델이나 내부 reasoning이 자동 교체되지 않습니다.** 명시적 도구 호출, 직접 소유한 dispatcher, 또는 아래 `install --hooks`로 설치한 소유 host hook이 필요합니다. `decideOrDelegate()` / `routeOrDelegate()`는 채택 시 baseline 판단 함수를 건너뛰지만 실제 모델 실행·권한·검증은 호스트가 담당합니다.

`install --hooks`는 Codex `spawn_agent`/Claude `Agent` spawn 호출 앞뒤에 `jev-control hook`을 붙이고, 두 호스트의 전역 지침 파일(Claude `~/.claude/CLAUDE.md`, Codex `~/.codex/AGENTS.md` — user 범위만)에 짧은 관리 블록을 추가합니다. `--hooks` 없이 install/uninstall하면 hook·블록은 그대로 두고, `uninstall --hooks-only`는 hook과 블록만 제거합니다(MCP·스킬·shim·mode는 그대로). router가 SHADOW/ON이고 provider가 `jev`이면, Claude hook이 route를 조회할 때마다 spawn description과 프롬프트 앞부분(최대 8000바이트)이 TypeSafe로 전송됩니다. **Codex 0.154.0은 hook에 `spawn_agent` 메시지를 불투명 토큰으로 넘겨서(2026-09-23 실측) Codex hook은 작업 내용을 읽지 못하고 역할을 판단하지 않습니다.** Codex에서 spawn 전에 `jev_route`를 명시적으로 부르면 spawn당 약 8.6초와 메인 모델 추가 턴이 들고 절감은 측정되지 않아(2026-09-23 A/B, `docs/plan/2026-09-23-laya-local-performance.md` B4), 관리 블록은 route 호출을 안내하지 않습니다. Codex hook은 SubagentStart/Stop 기록과 역할 분포 집계만 합니다. Codex는 새 hook을 실행하기 전 사용자가 `/hooks`에서 직접 승인해야 하며, 설치기는 그 승인 상태(`hooks.state`)를 절대 쓰거나 읽어 우회하지 않습니다.

## Provider와 키

Jev는 기존 `TYPESAFE_API_KEY` 환경변수 또는 관리 키 파일을 사용합니다. TOML/JSON에 키 값을 쓰지 않습니다. GUI 환경 상속이 번거로운 경우에만 본인이 일반 터미널에서 실행합니다.

```sh
"$HOME/.local/bin/jev-control" key set
jev-control provider status
jev-control provider jev
# 공식 runtime·고정 checkpoint를 로컬에 준비하고 providers.json을 검토한 후:
jev-control provider laya
```

키 입력은 숨겨지고, 저장소 밖 `~/.local/share/jev-agent-control/credentials.env`에 파일0600/디렉터리0700으로 보관합니다. **암호화 금고가 아닌 권한 제한 평문 파일**입니다. 동일 사용자 프로그램까지 차단하지 않습니다. 프로젝트 `.env`는 자동으로 읽지 않으며 실제 키를 채팅·명령 인자·테스트·Git 이력에 넣지 않습니다.

Jev HTTP 주소는 `https://api.typesafe.ai/v1/systemone`으로 고정하고 HTTPS/Bearer, redirect 금지, 자동 재시도 없음, bounded input/response를 적용합니다. Laya는 TypeSafe 키가 필요하지 않으며 allowlisted 환경으로 실행해 API/HF 키를 상속하지 않습니다. runtime 버전·모델 fingerprint·실제 장치/precision을 확인하고 조용한 입력 잘림이나 장치 변경을 허용하지 않습니다.

Laya의 파일 수준 `ready`는 실제 로딩·품질 합격이 아닙니다. checkpoint별 `qualification`이 없으면 비교 기록은 가능해도 ON 결과는 채택하지 않습니다. 준비 형식과 cold/warm 제한은 [TRAINING_DATA.md](docs/TRAINING_DATA.md)에 있습니다.

## Laya 상주 서버 (선택, macOS)

매번 새 프로세스가 worker를 콜드 시작하는 대신, 로그인 시 자동 시작하는 사용자 `launchd` 에이전트 하나가 `JEV_HOME/run/laya.sock`(로컬 Unix 소켓, 네트워크 포트 없음) 위에서 worker를 상주시킵니다. hook은 이 서버가 없거나 준비 중이어도 절대 기다리지 않고 즉시 통과합니다.

```sh
# dry-run으로 plist 내용을 먼저 검토
node bin/jev-control.mjs install --target both --laya-agent --dry-run
node bin/jev-control.mjs install --target both --laya-agent
# 설치기는 파일만 쓰고 launchctl은 직접 실행하지 않습니다. 출력의 launchctl 명령을 본인이 실행:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jev-agent-control.laya.plist

# 상태 확인 (요청 내용은 절대 기록하지 않음)
jev-control laya server-status
jev-control doctor   # layaServer 섹션: plist·소켓·ready/loading

# 제거 (plist만 제거; MCP·hook·스킬·shim·mode는 그대로)
node bin/jev-control.mjs uninstall --target both --laya-agent --dry-run
node bin/jev-control.mjs uninstall --target both --laya-agent
launchctl bootout gui/$(id -u)/com.jev-agent-control.laya
```

`providers.json`의 `laya.serverIdleUnloadMs`(기본 1,800,000ms=30분)만큼 추론이 없으면 서버 프로세스는 유지한 채 worker만 내려 메모리를 반환합니다. 서버 없이도 기존처럼 각 프로세스가 직접 worker를 띄우는 경로는 그대로 동작합니다(`jev-control laya serve` 없이 사용 가능). 자세한 설계 근거는 [SECURITY.md](SECURITY.md)와 [docs/plan/2026-09-23-laya-local-performance.md](docs/plan/2026-09-23-laya-local-performance.md)에 있습니다.

## ON/OFF

```sh
jev-control status
jev-control off
jev-control shadow
jev-control on
jev-control policy init
jev-control policy check
jev-control router off     # 각각 off / shadow / on
jev-control bulk off       # 각각 off / shadow / on
```

PATH에 없으면 `"$HOME/.local/bin/jev-control"`을 사용하세요. 전역/기능 중 하나라도 OFF면 추론하지 않고, 하나라도 SHADOW면 결과를 적용하지 않습니다. 전역 OFF가 최우선이며 `JEV_DISABLE=1`도 지원합니다. 이미 전송된 요청의 과금은 되돌릴 수 없습니다. OFF는 MCP 설명 자체를 제거하지 않으므로 컨텍스트 비용까지 없애려면 호스트 MCP를 비활성화하거나 제거합니다.

같은 `JEV_HOME`에서는 정책·모드·관리 키를 공유하지만 각 호스트의 MCP·Laya worker·호출 제한은 별개입니다. router profile은 비워 두며 실제 보유한 **역할(role)**·reasoning·스킬을 확인한 값만 등록합니다(`features.json` v2, `jev-control policy roles`). Codex의 `spawn_agent`는 model 인자를 무시하고 역할 TOML의 model/effort를 그대로 쓰므로, Codex에서 실행 모델을 바꾸는 수단은 역할 선택뿐입니다. 추론 provider와 실제 코딩을 실행할 모델은 서로 다른 개념입니다. 기존 classifier-inspired 분류 정책은 유지하되 Jev는 고정 serving version, Laya는 고정 checkpoint를 검사합니다.

전수조사는 `coverage:exhaustive`로 모든 자료를 보존합니다. 필터는 ID만 반환하고 원본을 삭제하지 않습니다. 메인 모델이 읽기 전 수집 경로에 연결해야 입력 감소를 기대할 수 있습니다.

## 선택적 Training Capture

**Decision != Ground Truth · Agreement != Accuracy · Telemetry != Training Dataset · Inference != Training**

```sh
jev-control training capture status
jev-control training capture on     # 사용자가 명시적으로 승인할 때만
jev-control training capture off
# 실제 실행 runner 또는 명시적인 사용자 correction의 비식별 결과:
jev-control training outcome < sanitized-outcome.json
jev-control training host < sanitized-host-baseline.json
jev-control training evaluate
jev-control dataset stats
jev-control dataset validate
jev-control dataset build
jev-control dataset export --version <dataset-hash> --format laya
```

capture OFF이면 content-bearing training data를 새로 쓰지 않습니다. ON일 때만 최소 비식별 상태·질문·판단·모델 provenance를 별도 private 저장소에 기록하고, 실제 outcome을 같은 decision_id로 연결합니다. 원본 Decision/Outcome은 불변이며 평가/라벨/데이터셋은 재생성 가능합니다. capture OFF는 이미 보관한 데이터를 삭제하지 않습니다.

단순 성공, build 통과, Jev/Host 일치, 다수결은 정답 라벨이 아닙니다. 질문별 독립적인 objective assertion 또는 명시적 human correction만 강한 supervision으로 허용합니다. MCP 결과는 항상 weak host_review이며 에이전트가 자신을 human/runner로 가장하면 안 됩니다. 모의 판단을 실제 실행한 것처럼 성공률에 합산하지 않습니다.

민감한 원문·키·환경 전체·저장소 전체·대화 전체를 저장하지 않습니다. Operational telemetry는 별도로 계속 content-free입니다. 패턴 검사는 완전한 DLP가 아니므로 호출자가 최소화·비식별화해야 하며 export 전 사람이 재검토해야 합니다.

내부 canonical dataset과 공식 Laya의 `state / questions / gold` JSON-string export는 분리돼 있습니다. 모델·정책·데이터셋 버전, 원본 참조, 필터 규칙, 목적별/제공자별 분포, 중복 제거 및 task 단위 train/calibration/test 분리를 기록합니다. 이 저장소는 학습 실행이나 업로드를 하지 않으며, export 이후의 실제 fine-tuning은 별도 `training/laya-kit/`으로 분리돼 있습니다.

### Laya checkpoint 수명주기 (명시적 operator 호출만)

```sh
jev-control laya register --checkpoint /absolute/prepared-checkpoint --model laya/my-checkpoint --device mps [--input-fit lossless|task-head]
jev-control laya holdout freeze --dataset <dataset-hash> --name shared-v1
jev-control laya holdout list
jev-control laya qualify --candidate <checkpoint-hash> --dataset <dataset-hash> --holdout shared-v1
jev-control laya compare --candidate <checkpoint-hash> --holdout shared-v1
jev-control laya promote --candidate <checkpoint-hash> --holdout shared-v1
jev-control laya rollback
jev-control laya status
```

`register`는 준비된 로컬 checkpoint를 fingerprint(오프라인, `workers/laya_worker.py --fingerprint`)하고 `JEV_HOME/laya/checkpoints/`로 복사할 뿐 `providers.json`은 바꾸지 않습니다. `--input-fit`(기본 `lossless`, checkpoint에 고정되어 precision처럼 activate/promote를 따라 이동)을 `task-head`로 두면, 무손실 예산을 넘는 route 요청에서 `state.task`만 잘라(다른 state 키·질문·선택지는 그대로) 최장 prefix로 재시도합니다 — 자세한 내용은 [TRAINING_DATA.md §7](docs/TRAINING_DATA.md). `holdout freeze`는 데이터셋의 test split을 불변 회귀 holdout으로 고정합니다(모든 checkpoint 버전이 같은 holdout을 공유). `qualify`는 calibration split에서 purpose별 보수적 임계값을 찾고 test+holdout에서 Wilson 하한까지 확인해 자격 여부를 기록합니다. `compare`는 후보와 현재 활성 checkpoint를 같은 holdout으로 비교합니다. `promote`는 자격·비교 보고·무회귀 조건을 모두 만족할 때만 `providers.json`의 laya 블록을 원자적으로 교체하고(`provider` 선택은 바꾸지 않음) 직전 블록을 `JEV_HOME/laya/history.jsonl`에 남깁니다. `rollback`은 그 직전 블록으로 되돌립니다. 무엇도 학습을 시작하거나 promote를 자동 호출하지 않습니다.

구체적인 schema·outcome 예제·보안·공식 notebook 근거: **[TRAINING_DATA.md](docs/TRAINING_DATA.md)**. 키/모델 없이 전체 흐름을 확인하려면 `node examples/training-pipeline.mjs`를 실행하세요. 이 예제는 synthetic inference와 무해한 실제 assertion이며 모델 정확도 실험이 아닙니다.

### teacher 증류 + AI 기준 라벨 (`register` 전, 한국어 route 라벨이 없을 때)

owner 결정(2026-09-23): 영어 선택지·문장 TTY 검수가 어려워 calibration/test/holdout 정답은 사람 검수 대신
**Claude 기준 라벨**(`label_source: ai_reference`, 라벨링 모델을 `source`에 기록)로 대체했습니다. Jev teacher와
Claude의 300문항 실측 일치율이 낮아(intent .85 / risk .68 / difficulty .38) "Laya ≈ Claude" 목표를 위해 train도
Claude 라벨(`--role train`)로 둘 수 있습니다 — 이 경우 해당 task의 Jev teacher 표본을 **대체**합니다. 어떤 경우도
`human`/`runner`로 기록하지 않고, qualify·compare·compare-teacher 결과는 "Claude 일치율"이며 정확도가 아닙니다.

```sh
jev-control laya distill import --run r1 --input synthetic-tasks.jsonl   # {lang, domain?, task, group?, reviewable?} 합성 문장만; group=번역쌍 등 누출 방지 키, reviewable:false=검수 후보 제외
jev-control laya distill import-shadow --run r1                          # 캡처된 shadow task 문장(egress 금지, 외부 전송 없음)
jev-control laya distill label --run r1 --confirm-egress                 # 합성 문장만 Jev(TypeSafe)로 전송, 분당 50회 제한
jev-control laya distill import-reference --run r1 --input claude-labels.jsonl --source claude-sonnet-5 [--role eval|train]
                                                                           # {lang, task, labels:{intent,difficulty(1..5),risk}}; role 기본 eval(calibration/test), train은 해당 task의 teacher 라벨을 대체
jev-control laya distill review --run r1 --count 200                     # TTY 전용 사람 검수(선택, 있으면 최우선); 언어별 층화, 재개 가능
jev-control laya distill build --run r1                                  # 우선순위: human(eval) > reference eval > reference train > Jev teacher(train)
jev-control laya distill compare-teacher --run r1                        # Jev teacher vs 기준 라벨 숫자 리포트(정확도 아님); eval_reference/train_reference 분리
jev-control laya distill status --run r1
```

teacher = Jev(TypeSafe). teacher 라벨은 `dataset build`가 만드는 canonical dataset의 `train` split에만 들어가고, `calibration`/`test`/holdout(`laya holdout freeze`가 test split을 고정)은 owner가 검수한 라벨만 씁니다. `laya qualify`는 항상 사람 검수 split만 보므로, 자격 판정은 teacher가 아니라 사람 검수 결과에 근거합니다. 자세한 스키마·근거: **[TRAINING_DATA.md §7](docs/TRAINING_DATA.md)**.

## 검증과 제거

```sh
node scripts/check.mjs
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p test_laya_worker.py
node examples/training-pipeline.mjs
jev-control smoke          # 키·모델 없는 모의 연결 검증
# 실제 API/로컬 추론을 사용자가 허용하고 준비한 뒤에만:
jev-control smoke --live
# 외부 전송까지 명시적으로 허용한 비교 실험만:
jev-control compare --live < sanitized-comparison.json
jev-control metrics --days 7
jev-control uninstall --target both --dry-run
jev-control uninstall --target both
# 호스트 스킬 폴더가 심볼릭 링크라 설치기가 거부할 때(UNSAFE_SYMLINK): 스킬만 건너뛰고 MCP·hook·블록을 설치
# jev-control install --target claude --hooks --no-skills
# hook·지침 블록만 되돌릴 때 (MCP·스킬·shim·mode는 유지):
jev-control uninstall --target both --hooks-only --dry-run
jev-control uninstall --target both --hooks-only
```

CI는 macOS/Linux × Node22/24에서 오프라인 JavaScript·Python 경계 테스트와 synthetic demos를 실행합니다. **실제 TypeSafe 계정, Laya 가중치/MPS, Codex/Claude native 세션, downstream 품질·사용량 절감, 실제 fine-tuning은 별도 검증 대상**입니다. 일치율이나 단가 환산만으로 품질·절감을 주장하지 않습니다.

제거는 관리 항목만 지우고 키·로그·학습 데이터·백업·clone은 보존합니다. 관리 키 제거는 본인이 `jev-control key remove`를 실행하며 환경변수 키는 별도로 제거합니다. 백업에는 기존 다른 설정의 비밀값이 있을 수 있으므로 원문을 에이전트에게 노출하지 마세요.

[아키텍처](docs/ARCHITECTURE.md) · [데이터 수집/평가/export](docs/TRAINING_DATA.md) · [초기 멀티-provider 설계](docs/JEV_LAYA_PROVIDER_ARCHITECTURE.md) · [분류 설계](docs/CLASSIFIER_DESIGN.md) · [검증](docs/TESTING.md) · [보안](SECURITY.md)
