# Jev Agent Control

Codex와 Claude Code에서 **하나의 Jev 결정 계층**을 선택적으로 사용하는 로컬 MCP 서버·스킬·CLI입니다. TypeSafe 공식 REST API를 호출하며, 코딩 모델을 교체하거나 에이전트 내부 추론을 가로채지 않습니다.

**기본값 OFF · 외부 런타임 의존성 0개 · Node.js 22 이상 · macOS/Linux/WSL · API 키 없이 설치·오프라인 테스트 가능**

> 이 주소를 설치 목적으로 전달받은 에이전트는 먼저 [AGENTS.md](AGENTS.md)를 읽고 설치 절차를 수행하세요. README, 보안 문서와 설치 코드를 확인하고, 기존 설정을 보존한 채 OFF로 설치합니다. 키를 채팅으로 요청하지 않습니다.

## 설치

현재 저장소는 비공개이므로 설치하는 컴퓨터/에이전트에 GitHub 저장소 접근 권한이 필요합니다. 로컬 Codex CLI/앱·IDE 및 Claude Code용이며, 웹 채팅에 URL을 붙이는 것만으로 원격 컴퓨터에 설치되는 구조는 아닙니다.

```sh
# Node 22+ 및 Git이 설치된 자신의 컴퓨터에서 실행합니다.
install -d -m 700 "$HOME/.local/share/jev-agent-control"
git clone https://github.com/jadeonstudio/jev-agent-control.git \
  "$HOME/.local/share/jev-agent-control/repository"
cd "$HOME/.local/share/jev-agent-control/repository"

node scripts/check.mjs
node --test tests/*.test.mjs
node bin/jev-control.mjs install --target both --dry-run
node bin/jev-control.mjs install --target both
node bin/jev-control.mjs doctor
node bin/jev-control.mjs smoke
```

`npm install`, sudo, curl 파이프 설치는 필요 없습니다. 이미 clone한 폴더가 있다면 중복 clone하지 않고 내용을 확인한 뒤 그 폴더에서 진행합니다. 설치된 실행 파일은 해당 clone을 참조하므로 폴더를 삭제하지 마세요.

설치 후 Codex/Claude Code의 MCP 목록에서 `jev_agent_control`을 확인하고, 새 세션 또는 MCP 재연결로 스킬을 로드합니다. 호스트의 기존 신뢰·권한 승인은 그대로 유지됩니다. 설치 도구는 이를 자동 승인하지 않습니다.

```sh
# PATH에 ~/.local/bin이 없어도 이 절대 경로로 실행할 수 있습니다.
"$HOME/.local/bin/jev-control" status
```

단일 에이전트는 `--target codex` 또는 `--target claude`, 프로젝트 한정은 `--scope project --project /absolute/project/path`를 사용합니다. 기본은 사용자 전체 설치입니다. `CLAUDE_CONFIG_DIR`로 별도 프로필을 사용하는 경우 v1은 사용자 설정 위치를 추측하지 않고 거부하므로 프로젝트 범위를 사용하세요. 프로젝트 설정에는 로컬 절대 경로가 들어가므로 다른 컴퓨터와 그대로 공유할 설치 파일은 아닙니다.

## API 키: 환경변수 우선, 채팅에는 넣지 않기

서버 프로세스의 `TYPESAFE_API_KEY`를 가장 먼저 읽습니다. 기존 비밀 관리 도구나 안전하게 설정한 환경에서 Codex/Claude를 시작하세요. Codex 설정에는 변수 **이름만** `env_vars`로 등록하며 키 값은 쓰지 않습니다. 환경변수 변경은 이미 실행 중인 부모 프로세스에 전달되지 않으므로 호스트를 다시 시작해야 합니다.

GUI 앱처럼 환경변수 상속이 번거로운 경우에만, 본인이 일반 터미널에서 아래 명령을 실행합니다.

```sh
"$HOME/.local/bin/jev-control" key set
```

키 입력은 화면에 표시되지 않으며, 기본적으로 저장소 밖 `~/.local/share/jev-agent-control/credentials.env`에 저장됩니다. 디렉터리는 0700, 파일은 0600입니다. **이것은 OS 키체인/암호화 금고가 아니라 권한 제한된 평문 파일**입니다. 동일 OS 사용자·관리자·허용된 로컬 도구가 읽는 것까지 막지 못합니다. 키를 에이전트에게 대신 입력시키거나 채팅/명령 인자로 전달하지 마세요.

작업 폴더의 `.env`는 자동으로 읽지 않습니다. 관리 키 파일은 정해진 단일 환경변수 형식으로 파싱할 뿐 `source`, `eval`, 셸 실행을 하지 않습니다. 키 파일을 Git 작업 트리 아래에 생성하는 것도 거부합니다. 상세 위협 모델은 [SECURITY.md](SECURITY.md)를 확인하세요.

## OFF / SHADOW / ON

```sh
jev-control off       # Jev API 호출 중단, 기존 에이전트로 처리
jev-control shadow    # 비교 관찰: API는 호출하지만 결과는 적용하지 않음
jev-control on        # 검증과 임계값을 통과한 결정만 사용
jev-control status
```

`jev-control`을 찾지 못하면 위 명령을 `"$HOME/.local/bin/jev-control"`로 실행하세요. 사용자 설치가 아닌 경우에는 `node /absolute/repository/bin/jev-control.mjs`를 사용합니다.

| 모드 | 외부 API 호출 | 반환 결과 적용 | 용도 |
|---|---|---|---|
| OFF | 없음 | 없음 | 기본 동작, 즉시 비활성화 |
| SHADOW | 있음, 과금 가능 | 없음, 제안도 숨김 | 독립적인 기존 판단과 비교 |
| ON | 필요한 호출만 | `apply: true`일 때만 | 한정된 반복 판단 위임 |

두 에이전트가 같은 `JEV_HOME`을 사용하면 모드·정책·관리 키·로그를 공유합니다. 각 MCP 프로세스는 설정을 요청마다 다시 읽고, 응답 적용 전에도 확인합니다. **Codex와 Claude의 서버 프로세스 자체는 별개**이며 호출 제한과 회로 차단기는 프로세스 단위입니다.

OFF는 API 사용을 중단하지만 MCP 도구 목록·스킬 설명까지 제거하지는 않습니다. 도구 탐색/컨텍스트 비용까지 없애려면 호스트 MCP 패널에서 비활성화하거나 아래 제거 명령을 사용하세요. 이미 전송된 요청은 되돌리거나 과금을 취소할 수 없습니다.

추가 강제 차단은 호스트 시작 전 `JEV_DISABLE=1`로 설정합니다. 이것은 프로세스가 상속한 환경변수라 실행 중 즉시 변경되는 스위치가 아닙니다. 즉시 전환에는 `off` 명령을 사용하세요.

## 실제 연결 구조

```text
Codex + jev-decisions skill ── stdio MCP ──┐
                                          ├─ 공통 코드 / 정책 / 키 조회
Claude + jev-decisions skill ─ stdio MCP ──┘          │
                                           입력 검증·비밀값 차단
                                                    │
                                HTTPS → TypeSafe /v1/systemone
                                                    │
                                   응답 검증 / 불확실하면 host fallback
```

노출하는 MCP 도구는 세 개뿐입니다.

- `jev_decide`: 작은 상태와 독립적인 질문을 한 번에 전달합니다. Choice, Noul, Score를 지원합니다.
- `jev_status`: 키 값 없이 현재 모드와 준비 상태를 확인합니다.
- `jev_feedback`: 같은 MCP 프로세스의 최근 결정과 독립 기준값을 비교합니다. 원문 대신 일치 개수와 실측 사용량만 기록합니다.

설치되는 스킬은 `jev-control`과 `jev-decisions`입니다. 라우팅·후보 선택·재시도·추가 리뷰 필요성처럼 **기존 생성 모델 호출을 실제로 대체할 수 있는 결정**에만 사용합니다. 단순 종료 코드 확인은 코드로 처리하는 것이 우선입니다. 전체 소스/대화 전송, 강제 모델 변경, 자동 권한 승인, 컨텍스트 삭제, 매 도구 실행 전후 판정은 구현하지 않습니다.

**MCP를 붙인 것만으로 내부 reasoning 토큰이 자동으로 사라지지는 않습니다.** 호스트가 이미 판단한 뒤 Jev를 추가 호출하면 오히려 느려질 수 있습니다. 직접 소유한 오케스트레이터에는 `src/engine.mjs`의 `decideOrDelegate()`를 사용해 Jev가 채택될 때 기존 판단 함수를 아예 호출하지 않는 경로를 만들 수 있습니다. [예제](examples/fast-path.mjs)는 그 분기를 모의 데이터로 검증합니다.

## 테스트 순서

```sh
# 키 없는 오프라인 테스트
node --test tests/*.test.mjs
jev-control smoke

# 본인이 키를 설정한 다음에만 실행: 합성 입력 한 묶음이 TypeSafe로 전송됩니다.
jev-control shadow
jev-control smoke --live

# 실제 작업에서 Jev가 사용된 후 로컬 기록 확인
jev-control metrics --days 7
# 검증된 좁은 결정 유형부터 활성화
jev-control on
# 언제든 비활성화
jev-control off
```

`smoke --live`의 성공은 API 연결과 응답 계약이 맞는지 확인한 것이며, 코딩 정확도·수익·작업 전체 속도 개선을 증명하지 않습니다. [TESTING.md](docs/TESTING.md)에 실제 검증 범위, 아직 검증하지 않은 항목과 A/B 절차를 구분했습니다.

## 보안 및 장애 처리

API는 `https://api.typesafe.ai/v1/systemone`으로 고정하고 HTTPS Bearer 인증을 사용합니다. 임의 엔드포인트 변경·리디렉션·자동 재시도는 허용하지 않습니다. 기본 제한은 2초, 요청 본문 24,000바이트, 질문 8개, 분당 60회/프로세스, 동시 4개/프로세스입니다. 세 번 연속 공급자 실패 후 30초 동안 회로를 엽니다.

키 없음·타임아웃·429·잘못된 응답·낮은 확실성·민감 범위는 `apply: false`로 기존 호스트 판단에 돌아갑니다. 이것은 **기존 권한 검사를 유지하는 fallback**이지 작업 자동 허용이 아닙니다. 모든 결과에 `authorizesExecution: false`가 포함됩니다.

텔레메트리는 로컬 메타데이터만 저장합니다. 키, 상태 원문, 질문/후보 이름, 응답 값, 원본 오류 메시지는 기록하지 않습니다. `usage`를 제공하지 않은 호출은 미확인으로 남깁니다. 비용·토큰 절감률을 추정해서 채워 넣지 않습니다. 하루 로그 상한은 약 10MiB이며 자동 삭제는 없으므로 보관 정책은 사용자가 관리합니다.

## 수정·업데이트·제거

설정은 기본 `~/.local/share/jev-agent-control/config.json`입니다. [config.example.json](config.example.json)은 비밀값 없는 전체 정책 예제이며 자동 적용되지 않습니다. 설정 변경은 원자적 파일 교체를 권장합니다. 임계값은 프로젝트별 실제 평가로 조정해야 하며 `confidence=0.9`가 정답률 90%라는 뜻은 아닙니다.

```sh
# 제거도 먼저 확인할 수 있습니다.
jev-control uninstall --target both --dry-run
jev-control uninstall --target both
```

설치한 항목만 제거하고 기존 MCP/스킬/모델 설정은 보존합니다. 관리 항목을 수동 수정했다면 덮어쓰기/삭제를 거부합니다. 키·로그·백업·clone은 자동 삭제하지 않습니다. 키를 제거하려면 본인이 `node /absolute/repository/bin/jev-control.mjs key remove`를 실행하세요. 환경변수에 남은 키는 이 명령으로 삭제되지 않습니다.

업데이트는 먼저 OFF로 전환하고 Git 변경을 검토한 뒤 `git pull --ff-only`, 테스트, `install --target both`, 호스트 재시작 순으로 진행합니다. 자동 업데이트는 없습니다. 이전 기록과 일치하는 관리 설정만 새 런타임 경로로 갱신합니다. 실패한 설치의 비공개 백업은 `JEV_HOME/backups/`에 있습니다. 백업에는 기존 호스트 설정의 다른 비밀값이 들어 있을 수 있으므로 에이전트에 원문을 노출하지 마세요.

## 문서

[설계와 결정 계약](docs/ARCHITECTURE.md) · [공식 규격/OSS 리서치와 채택 근거](docs/RESEARCH.md) · [테스트 및 A/B 검증](docs/TESTING.md) · [문제 해결](docs/TROUBLESHOOTING.md) · [보안](SECURITY.md) · [에이전트 설치 지침](AGENTS.md)

현재 v0.1은 공식 문서에 맞춘 실행 가능한 구현과 오프라인 검증을 제공합니다. 작성 환경에는 TypeSafe 키와 실제 Codex/Claude 실행 파일이 없어 **실제 API 호출 및 두 제품 안에서의 종단 간 실행은 별도 확인 대상**입니다. 이를 통과했다고 표시하지 않습니다.
