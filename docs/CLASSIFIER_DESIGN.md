# v0.2: classifier.dev의 설계, TypeSafe의 API

작성·공식 문서 확인: 2026-09-21. 구현 범위는 공유 결정 계층의 확장이다. classifier.dev 서버·SDK·인증·Smart tier·다른 모델 API는 사용하지 않는다. 공개 설계의 아이디어를 참고해 독립 구현했다. 속도·정확도 숫자나 원본 데모의 라우팅 순서를 그대로 채택하지 않았다.

## 근거와 채택 범위

- [classifier.dev model-and-skill-router](https://classifier.dev/skills/model-and-skill-router): 작업 유형·난이도·위험도를 분리하고 코드로 모델/스킬을 결정하는 패턴. 원본 데모와 달리 **위험·불확실성 검사부터** 수행한다.
- [classifier.dev bulk-classify](https://classifier.dev/skills/bulk-classify): 많은 후보를 본 모델이 읽기 전에 분류하고 unknown을 남기는 패턴. 전수조사에는 적용하지 않는다.
- [TypeSafe quickstart](https://docs.typesafe.ai/introduction/quickstart): 한 System One 요청에 독립적인 Choice/Score 질문을 함께 전송한다. HTTP 요청 세 개로 나누지 않는다.
- [TypeSafe models](https://docs.typesafe.ai/models): 버전 고정과 실제 serving model 확인. 확장 기능 기본값은 `jev-1.13.0`이며 alias를 허용하지 않는다. 기존 generic `jev_decide`의 모델 설정은 변경하지 않는다. 공급자 문서상 다국어 성능에도 차이가 있으므로 한국어 업무를 별도로 평가해야 한다.
- [Codex MCP](https://developers.openai.com/codex/mcp): MCP 도구 제공과 모델 내부 추론 가로채기는 다르다. 본 구현은 후자를 하지 않는다.

## 실제 실행 경계

```text
Codex/Claude의 명시적인 도구 호출 또는 직접 소유한 dispatcher
  → 로컬 정책·모드·범위 확인
  → TypeSafe Jev: intent(Choice) + difficulty(Score) + risk(Choice)
  → 응답 계약·버전·confidence·확률 검증
  → 코드 정책: economy / standard / strong
  → 실제로 등록되고 이용 가능한 model/skill ID만 반환
  → 호스트가 지원하는 실행 경로에서 적용, 아니면 원래 모델 유지
```

`jev_route`는 **권고**를 반환한다. 설치만으로 Codex/Claude의 메인 모델이 자동 전환되지 않는다. 직접 소유한 오케스트레이터는 `routeOrDelegate()`를 사용하면 채택 시 baseline 판단 함수를 호출하지 않을 수 있다. 모델 호출·reasoning 값 지원 확인·권한·재시도·작업 검증은 embedding host 책임이다. 대체 모델 실행이 실패했을 때 무조건 재실행하면 부작용이 중복될 수 있으므로 이 라이브러리는 실행 재시도를 하지 않는다.

Jev는 모델명을 보지 않는다. `task/context`와 세 질문만 받는다. 모델별 성공 능력은 자동 학습하지 않는다. difficulty가 낮다는 사실만으로 저렴한 모델이 반드시 성공한다고 보장하지 않는다.

## 모드와 로컬 설정

`config.json`의 기존 전역 스위치는 유지한다. 새 정책은 동일한 private `JEV_HOME`의 `features.json`에 저장한다. 기본 경로는 `~/.local/share/jev-agent-control/features.json`이다. 파일 0600, 디렉터리 0700, symlink 금지, 원자적 저장을 사용한다. API 키는 여기에 넣지 않는다.

```sh
jev-control policy init       # 없을 때만 생성; 기존 설정 보존
jev-control policy check      # 형식 검사일 뿐 실제 모델 지원·품질 검사가 아님
jev-control status
jev-control router off
jev-control router shadow
jev-control router on
jev-control bulk off
jev-control bulk shadow
jev-control bulk on
jev-control off               # 모든 API 사용의 최상위 OFF
```

전역/기능 중 하나라도 OFF면 호출하지 않는다. 하나라도 SHADOW면 제안은 적용하지 않는다. 두 값이 모두 ON이어야 적용 가능하다. 따라서 전역이 이미 ON인 기존 설치도 업데이트만으로 라우터/필터가 켜지지 않는다. `JEV_DISABLE=1`도 기존대로 전역 OFF를 강제한다.

정책이 손상됐을 때 기능 `off`는 안전 기본값으로 복구할 수 있지만 이때 손상된 파일의 모델 매핑도 초기화될 수 있다. 정상 정책의 `off`는 매핑을 보존한다. 상태 변경·정책 변경·취소는 응답 적용 전 재검사한다. 이미 전송된 호출의 과금은 취소할 수 없다.

## 모델/스킬 매핑: 추측하지 않기

`features.example.json`은 두 호스트의 `profiles`가 빈 상태다. 실제 이용 가능한 모델 ID는 계정·호스트 버전에 따라 다르므로 하드코딩하지 않는다. 모델이 두 종류 미만으로 확인되면 네트워크 호출 없이 `INSUFFICIENT_TARGETS`로 기존 경로를 유지한다.

설치 에이전트는 라우터 활성화를 요청받았을 때 실제 호스트가 지원하는 모델·reasoning 값·스킬과 dispatch 방법을 확인해야 한다. 호스트 auth 파일이나 환경 전체를 읽어 이를 찾으면 안 된다. 확인된 값으로 다음 형태의 **로컬** 매핑을 작성한다. 다음 값들은 문법 설명용이며 실제 모델이 아니다.

```json
{
  "router": {
    "profiles": {
      "codex": {
        "economy": {"model": "VERIFIED_ECONOMY_MODEL", "reasoning": "VERIFIED_LEVEL"},
        "standard": {"model": "VERIFIED_STANDARD_MODEL"},
        "strong": {"model": "VERIFIED_STRONG_MODEL", "skills": {"debug": ["verified-skill-id"]}}
      },
      "claude": {}
    }
  }
}
```

기존 features.json 전체를 이 부분 예제로 덮어쓰지 말고 `router.profiles`만 수정한다. 요청의 `availableModels/availableSkills`도 현재 실제 목록이어야 한다. 결과 모델은 두 목록의 교집합에서만 선택한다. reasoning 값 지원 여부는 호스트 adapter가 마지막에 검증한다. 현재 주 모델 고정 요청이면 `modelLocked:true`로 보존한다. 자동 호스트 설정 편집은 없다.

## 라우팅 정책

먼저 코드가 민감·고영향, 모델 고정, 전수조사/저장소/모듈 횡단, 불완전한 근거, 과거 실패를 차단해 기존 모델을 유지한다. 나머지 작업에서만 한 번의 Jev 호출을 한다.

세 차원의 confidence와 Choice 선택 확률을 별도로 확인한다. `other`, 위험/unknown/caution의 잔여 확률, 운영/아키텍처 intent도 저가 경로보다 먼저 검사한다. 기본 기준은 confidence 0.90, 선택 확률 0.85이며 **실제 성공률 보장이 아니라 검증 전 출발 정책**이다.

Difficulty는 TypeSafe의 0~4 Score를 1~5로 변환한 기대값이다. 기대값만으로 어려운 가능성을 숨기지 않도록 `hardTail=P(4)+P(5)`, `deepTail=P(5)`를 함께 확인한다.

| 경로 | 기본 조건 |
|---|---|
| economy | explain/edit, 기대 난이도 ≤2, hardTail ≤0.02, 모든 선행 검사 통과 |
| standard | debug 제외, 기대 난이도 ≤3.5, deepTail ≤0.05, 선행 검사 통과 |
| strong | 나머지 명확한 routine 작업; 대상이 실제 등록된 경우만 |
| 원래 host | 불확실·위험·범위 문제·대상 없음·API 오류·버전 불일치 등 |

confidence 자체가 해당 작업의 성공 확률은 아니다. 규칙이 강한 모델을 고른다고 항상 더 정확한 것도 아니다. 라우터의 가치와 실제 품질은 별도 실험이 필요하다.

## 대량 분류: 삭제가 아니라 선택 후보 반환

```sh
jev-control filter < examples/filter-input.json
jev-control route < examples/router-task.json
```

`filter`는 query, risk, coverage, `{id,text,required?}` 배열을 받는다. 입력 자체에 파일 경로를 줘서 파일을 읽게 하지는 않는다. 상위 로컬 수집기가 필요한 snippet을 만들고 API 전송 허용 여부를 결정한다. MCP로 본 모델이 이미 읽은 긴 text를 다시 보내면 입력 토큰 절감 효과가 없거나 오히려 악화될 수 있다.

기본 최대 128개, question 8개/요청, 총 16회·10초 예산이다. 실제 전송 바이트와 전역 question 제한에 맞춰 chunk를 더 작게 포장한다. MCP/CLI JSON 프레임은 64KiB, 각 text는 4096바이트까지다. 더 큰 데이터는 호출자가 별도 배치로 나누며 CLI 반복 호출은 프로세스별 제한을 초기화한다. 계정 전체 비용 한도는 아니다.

`include/exclude/uncertain` 중 선택하며 반대 증거·관련 배경·의존성도 포함한다. 제외는 confidence≥0.97 및 exclude 확률≥0.99일 때만 가능하다. 기존 engine의 all-question 조건도 유지하므로 한 question이 불확실한 chunk는 전부 보존한다. `required:true`는 API에도 보내지 않고 보존한다. `coverage:exhaustive`나 민감 범위는 전체 보존·API 0회다.

결과는 `keepIds/rejectIds/reviewIds`이며 원문이나 파일을 삭제하지 않는다. 미처리·시간 제한·rate limit·단순 오류가 난 항목은 보존한다. 처리 도중 전역/기능 정책 변경·사용자 취소·모델 버전 변경은 앞서 제외한 항목까지 되돌린다. `valid:false` 또는 `apply:false`이면 호출자는 반드시 **자신이 보관한 원본 입력 전체**를 사용한다. 잘못된 입력은 keepIds도 비어 있을 수 있으므로 빈 배열을 삭제 명령으로 해석하면 안 된다.

## SHADOW와 실제 품질 검증

SHADOW에서는 모델/필터 제안 값을 호스트에 주지 않는다. 독립 기준을 만든 뒤 같은 MCP 프로세스에서 5분 이내 `jev_observe`로 비교한다. 라우팅은 `{id,tier}`, 필터는 `{id,relevantIds}`다. 일반 decision은 기존 `jev_feedback`을 쓴다. 로그는 숫자/상태만 기록한다.

**Astra가 성공한 기록 + Jev가 저가 모델을 추천한 기록만으로 저가 모델의 성공을 알 수 없다.** 일치율을 정확도나 wrong downgrade로 표기하지 않는다. 실제 기준/라우팅 실행을 동일 스냅샷에서 격리하고, 동일 평가기·필수 테스트로 채점해야 한다. live DB/배포를 두 번 실행해 비교하면 안 된다.

`jev-control evaluate`는 다음 형태의 로컬 JSON을 집계한다. 수치는 실제 계측값이어야 하며 추정치를 실행값으로 표시하지 않는다.

```json
{"cases":[{"downgraded":true,"baseline":{"executed":true,"passed":true,"elapsedMs":100,"outputTokens":100},"routed":{"executed":true,"passed":true,"elapsedMs":80,"outputTokens":70}}]}
```

위 숫자는 형식 예시일 뿐 벤치마크가 아니다. routed 시간·토큰에는 준비, Jev, host, 재시도, 검증, cache 영향까지 포함한다. input/cached/reasoning 가격 및 구독 quota는 별도 집계해야 하므로 이 도구는 금액 절감률을 생성하지 않는다. 여러 프로세스 합계 시간은 벽시계 전체 완료 시간과 다르다.

quality regression, 실제 downgrade 실패, 출력 토큰·시간 변화와 0오류 시 단측95% 상한을 출력한다. `executed:false`는 거부하지만 사용자가 기록을 사실대로 제공했는지 도구가 입증하는 것은 아니다. 같은 작업의 수백 turn은 독립 표본이 아니며 상한 공식을 그대로 적용하면 안 된다. 자동 ON이나 임의 품질 승인은 없다.

## 검증 범위

오프라인 모의 응답과 실제 Node stdio 프로세스로 계약·모드·설치·보안·분기·취소를 검증한다. `examples/classifier-design.mjs`도 테스트 fixture만 사용한다. TypeSafe 실계정 호출, 실제 Codex/Claude 세션, 저가 모델 품질 및 작업 전체 절감률은 아직 측정하지 않았다. 기존 smoke 성공을 이 항목들의 성공으로 확대하지 않는다.
