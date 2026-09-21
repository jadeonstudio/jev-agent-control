# Jev Agent Control

Codex와 Claude Code가 같은 **선택적 결정 계층**을 사용하는 로컬 MCP 서버·스킬·CLI입니다. v0.2는 classifier.dev의 분류 설계를 참고하되 **TypeSafe Jev API만 직접 호출**합니다. 별도 classifier.dev 계정·키·프록시가 없습니다.

**Node.js 22+ · Git · macOS/Linux/WSL · 런타임 의존 패키지 0개 · 기본 OFF · API 키 없이 설치·오프라인 테스트 가능**

> 설치를 요청받은 에이전트는 [AGENTS.md](AGENTS.md)를 먼저 읽으세요. 기존 설정을 보존하고 키를 채팅으로 요청하지 않습니다. 웹 채팅에 URL을 붙이는 것만으로 다른 컴퓨터에 설치되는 구조는 아닙니다.

## 설치와 업데이트

로컬 터미널·파일 접근이 가능한 Codex/Claude에 저장소 URL과 설치 요청을 전달하면 됩니다. 이미 clone이 있다면 원격 주소와 로컬 변경부터 확인하고 재사용합니다. 비공개 저장소라면 기존 GitHub 접근 권한이 필요합니다.

```sh
git clone https://github.com/jadeonstudio/jev-agent-control.git
cd jev-agent-control
node scripts/check.mjs
node --test tests/*.test.mjs
node bin/jev-control.mjs smoke
node examples/fast-path.mjs
node examples/classifier-design.mjs
node bin/jev-control.mjs install --target both --dry-run
node bin/jev-control.mjs install --target both
node bin/jev-control.mjs doctor
```

안정적으로 보관할 폴더에서 설치하세요. 설치된 실행 파일은 clone을 참조하므로 폴더를 지우면 안 됩니다. sudo/npm 설치/curl-pipe 설치는 필요 없습니다. 두 호스트 각각 MCP 목록에 `jev_agent_control`이 보이는지 확인하고 새 세션/MCP 재연결로 스킬을 로드합니다. 기존 신뢰·권한 승인은 보존합니다.

기존 설치 업데이트는 **OFF → Git 변경 검토 → `git pull --ff-only` → 전체 테스트 → 같은 설치 명령 → 호스트 재연결**입니다. 자동 업데이트는 없습니다. 사용자 수정 충돌은 덮어쓰지 않습니다. 새 기능은 별도 OFF 기본값이므로 기존 전역 ON 상태만으로 활성화되지 않습니다.

단일 호스트는 `--target codex|claude`, 프로젝트 범위는 `--scope project --project /absolute/project/path`입니다. 기본 사용자 전체 설치입니다. 다른 Claude 프로필(`CLAUDE_CONFIG_DIR`)은 프로젝트 범위를 사용하세요. 설치 경로의 절대값은 해당 컴퓨터용이며 Git으로 공유할 설정이 아닙니다.

## 역할과 한계

| 도구 | 역할 |
|---|---|
| `jev_decide` | 기존 Choice/Noul/Score의 좁은 판단을 한 번에 위임 |
| `jev_route` | intent/difficulty/risk → 로컬 코드 정책 → 등록된 모델·reasoning·스킬 권고 |
| `jev_filter` | 선택적 snippet 분류; 불확실·필수 항목 보존, 전수조사에서는 전체 보존 |
| `jev_status` | 전역/기능 모드, 키 준비 상태; 키 값은 출력하지 않음 |
| `jev_feedback` | 기존 generic decision의 독립 기준 비교 |
| `jev_observe` | 새 라우터/필터의 SHADOW 비교; 라우팅 일치율은 정확도가 아님 |

**MCP를 붙여도 Codex·Claude의 메인 모델이나 내부 reasoning이 자동 교체되지는 않습니다.** 에이전트가 명시적으로 도구를 호출하거나 직접 소유한 dispatcher가 라이브러리를 호출해야 합니다. `routeOrDelegate()`는 채택 시 baseline 판단 함수를 건너뛰지만 실제 모델 실행은 호스트가 담당합니다. native main-model interception, proxy, permission hook, context 삭제는 없습니다.

## API 키

기존 `TYPESAFE_API_KEY` 환경변수를 그대로 사용합니다. 설정 TOML/JSON에는 키 값을 쓰지 않습니다. GUI 앱의 환경 상속이 번거로운 경우에만 본인이 일반 터미널에서 실행합니다.

```sh
"$HOME/.local/bin/jev-control" key set
```

입력은 숨겨집니다. 저장소 밖 기본 `~/.local/share/jev-agent-control/credentials.env`에 파일0600/디렉터리0700으로 저장합니다. **암호화 금고가 아닌 private 평문 파일**이며 동일 사용자 권한의 프로그램까지 막지 못합니다. 채팅·명령 인자·fixture·Git 이력에 실제 키를 넣지 마세요. 작업 폴더의 `.env`는 자동으로 읽지 않습니다. 기존 보안 및 API 키 저장 오류 수정은 유지했습니다.

HTTP 목적지는 `https://api.typesafe.ai/v1/systemone`으로 고정합니다. Bearer 인증, HTTPS, redirect 금지, 자동 재시도 없음, 비밀값 탐지, 입력 크기 제한을 적용합니다. 탐지는 완전한 유출 방지 수단이 아니므로 최소한의 허용된 상태만 전송해야 합니다. 키·입력 원문·응답값·원본 오류 메시지를 로그에 기록하지 않습니다. [SECURITY.md](SECURITY.md).

## 쉽게 켜고 끄기

```sh
jev-control status
jev-control off
jev-control shadow
jev-control on
jev-control policy init
jev-control policy check
jev-control router off
jev-control router shadow
jev-control router on
jev-control bulk off
jev-control bulk shadow
jev-control bulk on
```

PATH에 없으면 `"$HOME/.local/bin/jev-control"`을 사용하세요. 전역/기능 중 하나라도 OFF면 API 호출이 없고, 하나라도 SHADOW면 결과를 적용하지 않습니다. 둘 다 ON일 때만 조건을 통과한 결과를 사용합니다. 전역 OFF가 최우선입니다. OFF는 MCP 도구 설명까지 제거하지 않으므로 그 컨텍스트 비용까지 없애려면 호스트 MCP를 비활성화하거나 uninstall해야 합니다.

두 호스트는 같은 `JEV_HOME`의 설정/관리 키/로그를 공유하되 MCP 프로세스·rate limit은 별도입니다. 이미 전송된 API 요청과 과금은 되돌릴 수 없습니다. `JEV_DISABLE=1` 환경변수는 시작할 때 상속되며 실행 중 전환은 `off` 명령을 사용합니다.

## 라우터/필터 사용 준비

`policy init`은 기존 정책을 덮어쓰지 않고 `features.json`에 안전 기본값을 만듭니다. **모델 매핑은 비어 있습니다.** 계정/호스트에서 실제 확인한 모델과 reasoning 값만 `router.profiles.codex/claude`에 등록하세요. API 키는 features.json에 넣지 않습니다. 자동으로 모델명을 추측하지 않으며 모델 목록·dispatch 방법을 확인할 수 없으면 원래 호스트를 유지합니다.

확장 기능은 기본 `jev-1.13.0`으로 버전을 고정하고 응답의 serving version도 검사합니다. 기존 `jev_decide` 모델 설정은 그대로입니다. SHADOW에서 먼저 관찰하고 실제 paired 실행으로 작업 품질까지 확인해야 합니다.

```sh
jev-control route < examples/router-task.json
jev-control filter < examples/filter-input.json
jev-control metrics --days 7
```

라우터 예제의 모델 목록은 의도적으로 비어 있어 실모델을 확인하지 않고 실행 경로를 바꾸지 않습니다. 필터는 IDs만 반환하고 원본은 삭제하지 않습니다. `apply:false`/`valid:false`이면 원본 입력 전체를 사용합니다. 전수조사는 반드시 `coverage:exhaustive`이며 API 없이 전체를 보존합니다. 필터는 본 모델에 입력되기 전 수집 경로에 배치해야 토큰 감소 여지가 있습니다.

구체적인 정책·한계·프로필 형식·paired 평가 절차: [CLASSIFIER_DESIGN.md](docs/CLASSIFIER_DESIGN.md).

## 테스트와 제거

```sh
node --test tests/*.test.mjs
jev-control smoke                        # 모의 응답, 네트워크 없음
# 실제 API 테스트를 사용자가 허용하고 키를 준비한 뒤에만:
jev-control shadow
jev-control smoke --live
# 실제로 양쪽을 실행한 동일 작업의 결과만 입력:
jev-control evaluate < paired-runs.json
jev-control uninstall --target both --dry-run
jev-control uninstall --target both
```

설치한 항목만 제거하고 키/로그/백업/clone은 남깁니다. 키 파일 제거는 본인이 `jev-control key remove`를 실행합니다. 환경변수 키는 지워지지 않습니다. 백업에는 기존 다른 설정의 비밀값이 있을 수 있으므로 원문을 에이전트에 노출하지 마세요.

현재 검증은 오프라인 계약·분기·설치·보안·실제 Node stdio 통신입니다. **실계정 TypeSafe 호출, 실제 Codex/Claude 세션, 저가 모델의 작업 품질과 전체 절감률은 별도 미검증**입니다. SHADOW 일치율·예상 단가만으로 품질이나 과금 절감을 주장하지 않습니다.

[아키텍처](docs/ARCHITECTURE.md) · [v0.2 연구/설계](docs/CLASSIFIER_DESIGN.md) · [초기 연구 기록](docs/RESEARCH.md) · [초기 테스트 안내](docs/TESTING.md) · [문제 해결](docs/TROUBLESHOOTING.md) · [보안](SECURITY.md)
