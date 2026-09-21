# Jev + Laya: 선택 가능한 decision provider 설계 및 변경 계획

> **상태: 설계 검토 완료 / 구현 전.** 이 문서는 실행 코드, 설치 환경, API 키, 현재 모드 또는 모델을 변경하지 않는다. 아래 신규 설정·명령·파일은 구현 계획이며 현재 v0.2.0의 지원 기능으로 해석하면 안 된다.

- 조사일: 2026-09-21.
- 검토 기준: `jadeonstudio/jev-agent-control` main **`0ee6f568506491aafed82a66241212fcf737fad1`**, v0.2.0.
- 공식 Laya 소스: `NandhaKishorM/laya` main **`42626c348753fbb17572a813127df2278a1ec527`**.
- 공식 배포판: **Laya 0.3.4**, 태그 기준 커밋 `d113dca2512fb3eaca313534bc54c7162d87c1d4`. 최신 main과 태그를 비교했으며 핵심 `agent.py`·`common.py`는 동일하다. 이후 변경에는 언어 감지·연구 자료·노트북 등이 포함된다.
- 검토 방법: GitHub 연결을 통한 전체 트리, 런타임 모듈과 테스트·설치 진입점 검토, 공식 모델 카드·런타임·라이선스·연구 자료 대조. 이 문서 작성 과정에서 실제 Jev 호출, 모델 다운로드, Laya 추론 또는 사용자 Mac 측정을 수행하지 않았다.

## 1. 최종 결정

**멀티-provider화는 적절하다. 단, 하나의 공통 제어 계층에 명시적으로 선택한 추론 provider 하나를 연결하는 수준으로 제한한다.** 기본 Jev 경로는 보존하고, Laya는 선택 설치하는 로컬 backend로 추가한다. Laya의 정확도·성공률을 Jev와 동등하다고 가정하지 않는다.

```text
Codex / Claude Code / 직접 소유한 dispatcher
                  │
     기존 MCP·CLI·라이브러리 인터페이스
                  │
   공통 Decision Control Layer (Node.js 22)
   모드·입력 검증·범위·예산·버전·채택 정책
                  │
          명시적 provider 선택
            ┌─────┴─────┐
            │           │
        jev adapter  laya adapter
            │           │ JSONL / stdio
     TypeSafe HTTPS  상주 Python worker
                     공식 laya.Agent 1개
                     고정된 checkpoint
            └─────┬─────┘
          표준화된 결과 + 출처
                  │
       적용 가능 → 기존 실행 경로
       미지원·오류·불확실 → host 판단
```

권장 초기값은 **Jev 유지 / Laya는 설치·준비 후 SHADOW 비교 / provider 간 자동 fallback 비활성화**다. Laya를 지원하는 것과 실제 자동 결정을 승인하는 것은 별도의 완료 조건이다. 로컬화의 주된 이점은 데이터 경로 통제·네트워크 독립성·반복 추론 지연·향후 전문화이며, 전체 에이전트 토큰 절감은 기존 main-model 판단 호출을 실제 생략했는지에 달려 있다.

도입하지 않을 것: provider를 고르는 또 다른 AI, Jev→Laya→Jev 재귀 판정, Laya 내장 Router의 암묵적 checkpoint 전환, 기본 HTTP daemon, 모델 학습을 수행하는 MCP 도구, 새 이름의 중복 MCP 도구 세트, 에이전트 내부 reasoning 가로채기.

## 2. 현재 구현에서 확인한 결합 지점

현재 함수 주입 지점 `createDecisionEngine({ provider })`는 테스트에 유용하지만 **provider 추상화가 완료된 구조는 아니다**. 전달 함수만 Laya로 바꾸면 다음 문제가 남는다. 근거는 기준 커밋의 [engine](../src/engine.mjs), [contracts](../src/contracts.mjs), [control-layer](../src/control-layer.mjs), [feature-policy](../src/feature-policy.mjs)다.

1. `status()`와 `decide()`, CLI의 `on/shadow`가 TypeSafe 키에 의존한다. 로컬 provider가 준비돼도 키가 없으면 거부된다.
2. `wireRequest()`가 TypeSafe 요청 형식을 생성하고 `normalizeResponse()`가 형식 검사와 채택 임계값 판단을 함께 수행한다.
3. `modelOverride`와 feature `expectedModel`은 `jev-x.y.z`만 허용한다. Laya가 반환하는 고정 문자열 `laya-rl-agent`는 실제 가중치를 식별하지 못한다.
4. provider 호출을 무조건 `networkCalls=1`로 세며, bulk의 호출 예산도 이 값으로 차감한다. 로컬 호출에 0만 넣으면 예산 제어와 지연 통계가 틀어진다.
5. 정책·MCP 설명·결과 `source`·토큰 집계 이름이 Jev 전용이다. provider별 보정과 실제 장치 정보는 없다.
6. feedback/observe는 프로세스 내 128건·5분짜리 메모리다. 몇 시간 뒤 downstream 결과나 재시작 후 결과를 연결할 수 없다. 현 evaluator는 baseline/routed 두 실행만 비교하며 3자 비교·확률 보정 측정은 하지 않는다.
7. 필터는 묶음의 모든 snippet을 공통 state에 넣는다. 질문 수·UTF-8 바이트만 제한하므로 Laya의 짧은 token/header budget에는 맞지 않을 수 있다.

### 모듈별 유지·변경 범위

| 현재 파일 | 유지할 책임 | 필요한 변경 |
|---|---|---|
| `src/engine.mjs` | 단일 결정 제어, OFF 우선, 취소·설정 변경 재검사, host 복귀 | backend별 readiness/호출/identity 사용; 채택 정책 분리; lifecycle 종료; provider별 오류 차단과 전체 예산 분리 |
| `src/provider.mjs` | 단일 provider 진입점 | 두 factory의 작은 registry로 전환; 현재 HTTP 구현은 `providers/jev.mjs`로 이동 |
| `src/contracts.mjs` | 유한 선택지·타입·분포·기대값·입력 유효성 검증 | wire encode/decode를 adapter로 이동; 공통 검증은 confidence 의미를 추측하거나 eligibility를 결정하지 않음 |
| `src/constants.mjs` | 오류 코드·모드·기본 제한 | provider enum, 공통 identity 및 결과 버전; Jev 전용 상수는 adapter에 한정 |
| `src/storage.mjs` | 원자적 저장·권한·소유자·symlink 방어·Git 메타데이터 예외 수정 | config v1→v2 해석/명시적 마이그레이션; Laya manifest 경로 검증; 키 조회는 Jev 선택 시에만 |
| `src/feature-policy.mjs` | router/bulk 모드, 실제 host 모델·스킬 매핑 | Jev 전용 expectedModel/임계값을 provider별 qualification에 연결; 미등록 Laya 임계값 상속 금지 |
| `src/routing.mjs` | intent/difficulty/risk, 위험·범위 검사, deterministic model/skill 정책 | provider별 채택 결과 사용; 짧은 공통 질문 템플릿을 별도 검증·버전 관리 |
| `src/filtering.mjs` | 필수·불확실·전수조사 보존, 순서와 ID 유지 | adapter의 tokenizer-aware admission 사용; Laya에서 필요한 경우 작은 묶음 또는 항목별 평가 |
| `src/control-layer.mjs` | 공통 route/filter, 정책 snapshot, blind SHADOW | 기대 identity·qualification 전달; 로컬/원격 공통 inference 예산; provider 변경 시 앞선 제외 결과 무효화 |
| `src/mcp.mjs` | 현재 6개 도구, 표준 입출력, 제한·취소·권한 비승인 | 설명/상태를 provider 중립화; 종료 시 worker 정리; agent 입력으로 provider/endpoint/실행 경로 지정 금지 |
| `src/cli.mjs`, `src/features-cli.mjs` | 기존 명령과 OFF/SHADOW/ON | 선택·준비·warm·진단 명령; backend별 준비 상태 검사; 두 진입점이 같은 설정을 사용 |
| `src/metrics.mjs` | 비내용성 로컬 로그, wrapper 이중 집계 방지 | provider/실제 artifact별 inference·network·단계별 지연·abstention·실제 호출 대체 집계 |
| `src/evaluation.mjs` | 실제 실행 증거 필요, SHADOW≠품질 | baseline/Jev/Laya arm 식별, 지연 outcome, calibration, 비교 불가능한 사례와 누락 분모 표시 |
| `src/installer.mjs` | 기존 host 설정 보존·소유권·충돌·rollback | 기본 설치에는 Python을 넣지 않음; 명시적 Laya 준비만 별도; 제거 시 소유한 worker만 정리 |
| `bin/`, `skills/`, `examples/`, `tests/` | 설치 경로·호환 명령·mock 기반 무과금 검증 | backend 중립 지침/fixtures, protocol/lifecycle/migration/evaluation 회귀 테스트 |

런타임 소스 15개와 테스트·예제·진입점·skill 실행 파일을 포함하는 29개 `.mjs`의 구조를 기준으로 계획했다. 기존 소스와 동일한 blob은 앞선 전체 코드 검토와 대조했다. 현재의 합성 테스트는 transport/분기 검증이지 Laya 모델 적합성 검증이 아니다.

## 3. 공식 Laya에 대한 판단

공식 근거는 [모델 카드][L1], [Agent][L2], [공통 전처리·모델][L3], [내장 Router][L4], [벤치마크][L5], [배포·의존성][L6]이다.

| checkpoint | 공개 사양 | 이 저장소에서의 판단 |
|---|---|---|
| English/root | 421M, 기본 512 tokens/question, header 192 | 영어의 짧은 한정 판단 후보. 한국어·혼합 입력 기본값으로 사용하지 않음 |
| multilingual | 322M, 기본 1,024 tokens/question, header 256 | 한국어 실제 workload의 우선 비교 후보. 다국어 지원 자체가 routing 정확도 보증은 아님 |
| typed-decisions | 421M, 기본 1,024 tokens/question | 네 가지 특정 workflow로 fine-tuning된 모델. 모든 typed decision에 최적인 범용 모델이라는 뜻이 아님 |

공식 연구 자료도 기본 checkpoint의 zero-shot typed-decision 성능과 과신 문제를 명시한다. fine-tuned checkpoint의 해당 benchmark 성능을 우리 coding-agent routing 성능으로 옮겨 읽지 않는다. 특히 difficulty에 사용하는 **ordinal Score가 약점으로 보고**되어 있어 현재 라우터에 중요하다. 공개 연구의 Jev 수치는 직접 같은 환경에서 실행한 결과가 아니라 외부 보고를 인용한 것이므로 “Laya가 Jev보다 정확하고 빠르다”는 결론의 근거로 사용하지 않는다.[L5][L7]

내장 `laya.Router`는 영어/다국어/typed checkpoint 선택기다. 우리 host 모델 라우터와 역할이 다르다. 기본 `max_loaded=1`에서 언어가 바뀌면 재로딩하고, workflow 자동 감지는 질문 ID 집합을 이용하며 opt-in이다. 초기 통합에서는 **명시적 checkpoint 하나와 `laya.Agent`만 사용**한다. 단순 언어 판별 추가도 실제 혼합 한국어·영어 데이터에서 따로 검증한다.[L4]

### 가장 중요한 호환성 함정

- Laya `choice`/`score`의 `confidence`는 `1 - H(p)/log(k)`다. `noul`의 confidence는 `max(p,1-p)`다. 값 이름이 같아도 같은 의미가 아니다. 둘 다 downstream 성공 확률이 아니다.[L2][L3]
- Laya는 옵션 설명을 먼저 최대 48 tokens로 자르고 header budget에 맞춰 추가로 줄인다. 질문 instructions와 state도 잘릴 수 있다. 현재 런타임의 marker 검사는 의미가 잘렸는지 보장하지 않는다.[L3]
- 여러 질문은 한 forward pass의 **서로 다른 sequence 행**이다. 질문마다 state가 다시 들어간다. “state를 한 번 encode하고 모든 질문에 무료로 재사용”하는 구현이 아니다.[L2][L3]
- `model: "laya-rl-agent"`만으로 checkpoint/언어/가중치/precision을 구분할 수 없다. `action.act_probability`는 자동 실행 허가나 정답 확률로 사용하지 않는다.[L2]

## 4. 공통 계약과 normalize 위치

**provider adapter가 wire 변환과 native 의미 표기를 담당하고, engine이 공통 유효성·정책을 담당한다.** Laya 결과를 Jev API 응답으로 위장하는 방식은 사용하지 않는다.

```text
CanonicalRequest
 → adapter.encode / token admission
 → 실제 추론
 → adapter.decode (native field 의미·출처 보존)
 → canonical validation (범위·키·합·기대값)
 → provider/artifact/task별 acceptance policy
 → apply 또는 host
```

| 종류 | 공통 결과 | 보존할 차이 |
|---|---|---|
| Choice | 선택된 label, 전체 분포, selectedProbability | native confidence와 그 정의; argmax/합/선택지 일치 검사 |
| Score | 0부터 시작하는 level 분포와 기대값 | 정수 argmax/반올림으로 바꾸지 않음; native confidence, ordinal calibration |
| Noul | `P(true)`, boolean, 필요시 `[P(false),P(true)]` | 기존 Jev canonical confidence는 null; Laya의 max(p,1-p)는 별도 native statistic |

canonical 결과에는 `provider`, `identity`, `usage`, `timings`, `admission`, `answers`를 추가한다. `nativeConfidence: {value, kind}`와 보정된 확률/평가 상태를 구분한다. Jev의 공급자 confidence를 Laya 엔트로피 공식으로 임의 재계산하지 않는다. 기존 Jev 외부 응답 호환은 serializer/테스트로 보존한다.

Qualification은 **provider + serving artifact + 템플릿 버전 + 언어/업무 범위 + 보정 버전**에 묶는다. 기존 Jev의 0.85/0.90/0.97 임계값을 Laya에 복사하지 않는다. 아직 검증하지 않은 Laya 조합은 SHADOW까지만 허용하고 ON에서는 `UNQUALIFIED_PROVIDER`로 host에 맡긴다. 충분한 검증 없이 숫자가 큰 confidence만으로 이를 해제하지 않는다.

### 무손실 입력 admission

worker는 추론 전에 해당 tokenizer로 **state, instructions, 각 옵션, 전체 header와 실제 sequence**의 잘림 여부를 검사한다. 정해진 모델 용량을 초과하면 명시적 `INPUT_BUDGET_EXCEEDED`로 반환한다. 자연어를 요약·절단해 억지로 통과시키지 않는다. 모델 카드의 encoder 최대 길이만 보고 `max_len=8192`로 올리지 않는다. 길이 설정 변경은 새 artifact/평가 대상이다.

bulk는 먼저 현재 query+snippet 설계의 token 합을 검사한다. 묶음에 뒤쪽 항목이 보이지 않는 상태로 분류하지 않는다. 묶음 축소로도 불가능하면 해당 항목은 유지한다. 전수조사/필수 항목 보존과 중간 취소 시 이전 제외 rollback은 provider와 무관한 불변식이다.

## 5. 설정: 명시적 provider 하나, 작은 registry

`provider: "jev" | "laya"`를 **로컬 operator 설정**으로 두는 것이 적절하다. provider ID는 추론 계열, `runtime`은 실행 구현, `artifact`는 가중치·전처리·보정 식별자다. 미래 MLX를 추가하더라도 `provider="mlx"`로 늘리지 않고 검증된 Laya 실행 backend로 다룬다.

설명용 schema v2 예시이며 **현재 CLI에서 사용할 수 없다**:

```json
{
  "version": 2,
  "mode": "off",
  "provider": "jev",
  "providers": {
    "jev": { "model": "jev-latest" },
    "laya": {
      "runtime": "python",
      "pythonExecutable": "/absolute/private-venv/bin/python",
      "artifactManifest": "/absolute/private-models/laya-ko/manifest.json",
      "device": "mps",
      "allowDeviceFallback": false
    }
  },
  "comparison": { "enabled": false, "providers": ["jev", "laya"] },
  "providerFallback": { "enabled": false }
}
```

일반 예산·로그 설정은 기존 값을 보존한다. feature의 semantic routing 정책과 host target mapping은 유지한다. 기존 feature `expectedModel`과 채택 임계값은 `acceptance.jev`의 versioned profile로 옮기고, `acceptance.laya`는 별도 qualification 참조를 사용한다. 따라서 generic Jev의 `jev-latest`와 feature의 `jev-1.13.0`이 다르더라도 마이그레이션에서 임의 통합하지 않는다.

config v1은 Jev로 해석하여 기존 동작을 보존한다. 원본 파일을 백업하고 OFF 상태에서 명시적으로 마이그레이션한다. 새 backend 선택은 readiness 검사와 정책 revision 변경만 수행하며 켜진 모드·remote egress 허용을 자동 승계하지 않는다. 전체/feature/provider qualification 중 가장 제한적인 상태가 적용된다.

MCP 호출 인자에는 provider 선택, 임의 실행 파일, endpoint, 모델 다운로드 URL을 넣지 않는다. 선택은 로컬 CLI/config에서만 한다. 기존 `jev-control`, `jev_*` 도구 이름은 호환성을 위해 유지하고 `status`에 실제 provider를 명확히 표시한다. 이름 변경을 위한 중복 도구 등록은 하지 않는다.

## 6. 연결 방식 비교와 권장 구현

| 방법 | 이점 | 비용·한계 | 결정 |
|---|---|---|---|
| 공식 Python `laya`를 요청마다 실행 | 원본 의미를 그대로 이용 | interpreter/import/model 로딩 반복 | 비권장 |
| **공식 Python + 상주 subprocess/stdio** | 공식 구현 재사용, 모델 한 번 로드, Node 기본 child_process 사용, 포트 없음 | 선택 설치 Python/PyTorch, host별 메모리 복제 | **초기 권장** |
| 공유 Unix-domain socket/IPC worker | Codex/Claude가 가중치 한 벌 공유 가능 | 소유권·동시성·버전 잠금·참조 수·orphan 복구 필요 | 중복 메모리 문제가 실측되면 2단계 |
| localhost HTTP 서비스 | 여러 client 연결 간편 | 인증·port·origin·수명·네트워크 표면 추가 | 초기에는 제외; 필요 시 loopback/인증 제한 |
| Node.js ONNX | Python 없이 Node 앱에서 실행 | native ORT 의존성, export/tokenizer/보정 parity 책임; Mac GPU 자동 보장 아님 | 공식 기준 구현 이후 검토 |
| 비공식 MLX/Core ML port | Apple 장치 최적화 가능 | 모델/precision/연산 변환 검증 필요, platform 종속 | 별도 backend 후보, 초기 필수 아님 |

`@receptron/laya`는 공식 Laya 배포판이 아닌 Node/ONNX 포트다. 코드 MIT·원본 가중치 Apache-2.0로 구분되어 있고 공개 ONNX bundle은 English checkpoint의 FP32 export다.[L8] `onnxruntime-node` 공식 사전 빌드 표는 macOS arm64 CPU를 지원하지만 MPS/Core ML을 표준 provider로 나열하지 않는다. Node.js라는 이유만으로 Apple GPU를 쓴다고 가정하면 안 된다.[L9]

`mizorewww/laya-mlx`와 `laya-coreml`도 독립 포트다. 공개 parity·속도 결과는 좋은 후속 검토 자료지만 **포트 수치 일치가 업무 정답률은 아니다**. Core ML의 짧은 ANE 고속 결과는 96-token bundle 등 별도 조건이 있어 현재 1,024-token 입력 경로의 결과로 일반화하지 않는다.[L10][L11]

### 최소 adapter 인터페이스

Node 쪽은 `inspect`, `warm`, `infer`, `close`를 제공하는 작은 객체 두 개면 충분하다. 다운로드를 포함하는 `prepare`는 operator 명령으로 분리한다. plugin marketplace, 범용 RPC framework 또는 provider를 판정하는 모델은 필요 없다.

- Jev adapter만 TypeSafe 키를 조회한다. HTTP 목적지 고정·TLS·redirect 금지·무재시도·안전한 오류 코드는 유지한다.
- Laya adapter는 고정 경로의 공식 Python 환경을 `shell:false`로 실행한다. 이미 별도 설치한 환경이 있다면 version/manifest 검증 후 재사용한다. 매 세션 새 venv를 만들지 않는다.
- 전용 worker는 버전이 있는 JSONL handshake/request/response, request ID·generation, bounded frame과 queue를 사용한다. 한 worker에서 우선 동시 추론 1개만 허용한다.
- child 환경은 allowlist로 구성한다. `TYPESAFE_API_KEY`, 호스트 인증·클라우드 토큰·HF 토큰을 전달하지 않는다. 모델 준비용 인증과 추론용 프로세스를 분리한다.
- `Agent`가 출력하는 경고가 stdout JSONL을 깨지 않도록 library stdout을 격리한다. stderr는 원문 상태·비밀값을 노출하지 않는 제한된 진단 코드로 다룬다.
- Python 실행 경로·worker 코드·checkpoint 경로는 관리된 고정 파일만 사용하고 작업 폴더의 `.env`, 모듈, 스크립트를 자동 실행하지 않는다.

## 7. 다운로드·identity·Apple Silicon·수명 관리

### 설치와 artifact 준비

기본 Jev 설치에는 Python/torch/weights를 추가하지 않는다. Laya 선택 설치만 별도 lock된 Python 환경(기존 검증 환경 우선, 신규 검증 기준 Python 3.12)을 요구한다. upstream의 넓은 최소 버전 범위는 재현 가능한 dependency lock의 대체물이 아니다.[L6]

현재 `laya.load`는 `revision/local_files_only` 인자를 직접 제공하지 않고 경로가 없으면 다운로드할 수 있다. `Agent`의 repo-root 다운로드는 subfolder 제한이 없을 수 있으며 tokenizer/encoder 파일이 없으면 추가 원격 조회 경로가 있다. **준비 명령에서 HF commit을 고정하고 필요한 파일만 다운로드한 뒤, 추론에는 완성된 로컬 경로만 제공**한다.[L2]

원본 artifact와 준비된 artifact를 구분한다. `_fix_tokenizer_config`가 tokenizer 설정을 수정할 수 있으므로 관리되는 사본에서 필요한 변환을 수행하고 두 해시와 변환 버전을 기록한다. 준비 후에는 원격 조회를 막는 offline 설정, 로컬 파일 완결성 검사, safetensors 및 코드 신뢰 제한을 적용한다. 환경변수만으로 OS 수준 네트워크 격리를 보장한다고 주장하지 않는다.

manifest에는 HF repo/revision/subfolder, weights/config/tokenizer digest, Python/Laya/torch/transformers 버전, 실제 device/dtype, 전처리·질문 템플릿·calibration 버전이 들어간다. upstream의 `laya-rl-agent` 문자열 대신 이 identity를 검증한다. 모델·장치·보정 변경 중 도착한 응답은 적용하지 않는다.

### 메모리와 지연

MPS 지원은 공식 `Agent`에 구현되어 있다. 현재 공식 경로는 CPU/MPS에서 FP32를 사용하고, 일부 장치 미지원·메모리 실패 시 CPU로 이동한다. 요청한 장치와 실제 장치가 다르면 이를 보고하고 기본적으로 준비 실패/host 복귀로 처리한다. 자동 CPU 전환을 허용하려면 별도 평가된 정책이어야 한다.[L2]

대략적인 **FP32 파라미터 자체**의 공간은 421M 모델 약 1.57 GiB, 322M 모델 약 1.20 GiB다(파라미터 수×4 bytes의 계산). tokenizer·activations·PyTorch·GPU allocator·로딩 중 사본은 제외한 값이므로 실제 peak RAM/장치 메모리의 예측값으로 쓰지 않는다. 디스크의 압축/낮은 dtype 파일 크기도 실행 메모리와 같지 않다.[L1][L2]

현재 Codex와 Claude는 MCP 프로세스가 각각이다. 첫 버전도 **MCP당 worker 1개·checkpoint 1개**이므로 동시 사용하면 모델 두 벌이 상주할 수 있다. 이 비용을 숨기지 않는다. 프로세스별 RSS·MPS allocated/driver memory와 전체 시스템 메모리 pressure를 같이 측정하되 unified memory 지표를 단순 합산하지 않는다. 실제 중복 비용이 문제일 때만 공유 IPC worker로 옮긴다.

공개 T4 warm 추론 숫자를 Mac 전체 호출 지연으로 사용하지 않는다. 다음을 분리해 측정한다: 최초 다운로드, 디스크가 준비된 cold startup/import/load, 첫 warmup, token admission, queue wait, 동기화한 device inference, JSONL round trip, 전체 agent 완료 시간. 짧은/긴 한국어·혼합 언어 입력, 1/3/8 질문, background workload와 두 호스트 동시 사용을 포함한다.

### lifecycle 계약

`UNPREPARED → PREPARED_COLD → STARTING → READY → DRAINING → STOPPED/FAILED`를 상태로 둔다. 상태 확인이나 OFF 요청 때문에 모델을 다운로드·로드하지 않는다. 활성화된 Laya 연결에서 operator가 허용한 `warmOnConnect` 정책으로 해당 MCP의 worker를 미리 로드하고 READY 이후 짧은 판단을 받는다. MCP initialize 자체는 모델 로딩을 기다리지 않는다. 준비되지 않은 요청은 host로 복귀하며 기존 2초 판단 timeout을 수십 초로 일괄 늘리지 않는다. 직접 소유한 dispatcher는 같은 provider 객체의 `warm()` 완료 후 요청을 보낸다. 일회성 CLI warm/smoke는 그 프로세스의 진단일 뿐, 별도 Codex/Claude MCP worker까지 미리 로드했다고 표시하지 않는다.

초기 실험 예산은 startup 60초, READY 이후 end-to-end 2초, 동시 1개, 대기열 소수로 시작할 수 있지만 이는 성능 보장이 아닌 조정 가능한 제안이다. timeout은 queue wait를 포함한다. 취소는 늦은 응답 적용을 막으며 이미 실행 중인 GPU kernel을 즉시 중단한다는 뜻은 아니다. timeout/hang 이후 worker 재시작은 다음 요청용 복구이고 같은 판단의 무제한 재시도가 아니다.

전역 OFF는 **원격 호출과 로컬 추론 모두** 막는다. 상주 worker가 있을 때만 설정 변경 감지와 짧은 보조 polling을 사용해 유휴 상태에서도 OFF를 관찰하고 요청 중단·정리를 수행한다. 현재의 요청 경계 검사만으로 유휴 프로세스가 즉시 종료된다고 주장하지 않는다. idle TTL·MCP EOF·SIGTERM에서 종료→제한된 grace→필요 시 소유한 child 강제 종료를 수행한다. 임의의 사용자 Python·에이전트 프로세스를 종료하지 않는다.

## 8. provider fallback

**기본은 단일 provider → host다.** Laya가 Jev보다 낮은 confidence를 냈다고 Jev에 다시 물어보거나 그 반대로 “확신하는 답이 나올 때까지” 조회하지 않는다. 이것은 정확도 보장도 아니고 잘못된 과신을 선택할 수 있다.

추후 필요하면 availability 오류에 한해 opt-in 1회 fallback을 별도 구현할 수 있다. 이미 준비·검증된 동일 업무/언어/스키마 조합, 남은 deadline, 추가 호출 예산, 데이터 전송 권한을 모두 통과해야 한다. 두 provider를 연달아 호출했다면 두 비용과 시간을 모두 집계한다. 무한 연결·왕복·중첩 confidence 판정은 금지한다.

특히 **Laya → Jev는 로컬 데이터의 외부 전송**이므로 암묵적 fallback을 허용하지 않는다. `NO_API_KEY`, 모델/토크나이저 identity 변경, 잘못된 입력, 정책 위반, 사용자 취소, 낮은 confidence는 다른 provider로 우회할 이유가 아니다. 선택 provider 오류, 미지원 입력, abstention, 장치 변경, 실제 host 위임을 각각 다른 사건으로 기록한다. host 자체가 cloud 모델일 수도 있으므로 기존 host 데이터 권한 또한 그대로 적용한다.

## 9. OFF/SHADOW/ON과 3자 검증

### 관찰 실험과 실행 실험을 분리

**관찰 단계:** 동일 decision point의 입력을 baseline 판단 전에 동결한다. `host baseline / Jev / Laya`가 같은 evidence·선택지·질문 템플릿을 보도록 하고, 두 provider 결과는 host에 보여주지 않는다. 실제 작업은 host만 실행한다. observer는 승인된 표본 비율·쿼터 안에서만 호출하고 OFF이면 둘 다 호출하지 않는다. Laya에만 불리한 길이 초과 사례도 분모에서 숨기지 않고 지원 coverage로 보고한다.

**실행 단계:** SHADOW 일치율로 대체 모델의 성공을 추정하지 않는다. 같은 repo snapshot·테스트 oracle·환경에서 각 arm을 격리 실행하거나 안전하게 재현 가능한 작업에 무작위 배정한다. 운영 DB·실주문·배포를 세 번 실행하지 않는다. 코드 테스트 통과만으로 요구사항 전체 충족을 보장하지 않으므로 completion/회귀/누락 기준을 사전에 정의한다.

오류 없는 수백 개의 같은 작업 내 turn을 수백 개 독립 표본으로 계산하지 않는다. 프로젝트/작업/시간으로 묶어 평가하고, 표본 수·coverage·신뢰구간·품질 손실 허용폭을 함께 보고한다. 과거 Astra만 사용한 기록으로 “Luna도 성공했을 것”이라는 라벨을 만들지 않는다.

### 기록과 측정 계약

| 측정 | 필요한 증거와 해석 |
|---|---|
| agreement | 같은 case/template의 host–Jev, host–Laya, Jev–Laya; 의미상 유효 label 집합/Score 허용 오차 명시. 정답률 아님 |
| downstream 성공률 | 실제 실행 arm, repo snapshot, oracle version, 실행 완료/실패/누락, 재작업 비용, 지연 결과. 미실행 arm은 unknown |
| calibration | 모든 유효 prediction의 분포와 독립 정답; Choice/Noul Brier·log loss·reliability/ECE, Score RPS·MAE. native entropy 자체를 정답 확률로 간주하지 않음 |
| fallback/오류율 | unavailable/timeout/invalid/input-too-long/abstain/policy/host-delegated를 분리; 성공한 호출만 분모로 사용하지 않음 |
| latency | cold/warm, queue/preprocess/infer/total p50·p95, 실제 device/dtype·질문 수·길이 기록 |
| 비용·tokens | `inferenceCalls`와 remote `networkCalls` 분리; provider별 billable usage와 local encoded tokens 구분; unknown은 null |
| 실제 main-model 판단 대체 | baseline callback 미호출, 선택 branch 실제 실행, 검증 outcome을 연결. `apply=true`만 세지 않음 |

`caseId / attemptId / experimentId / taskId / arm / provider / identity / schemaVersion / policyRevision`으로 예측과 실행을 연결한다. 5분짜리 기존 feedback은 즉시 비교용으로 유지하되 별도 **opt-in private JSONL evidence store**가 몇 시간 뒤 outcome과 재시작 후 연결을 담당한다. 새 데이터베이스·대시보드 서버는 필요하지 않다.

일반 운영 로그에는 원문을 계속 저장하지 않는다. calibration·학습용 저장은 별도 사용자 승인, private 0600/0700 경로, 필드 allowlist, 비밀값 검사, 보관 기간·삭제·용량 제한을 요구한다. label index와 schema digest로 비내용성 통계를 기록하고, 학습에 필요한 정제된 state/schema는 별도 보호 데이터셋에만 저장한다. 공개 저장소에는 코드·schema·합성 fixture만 넣는다.

평가 결과에는 accepted coverage와 accepted subset의 오류율을 함께 표시한다. confidence가 낮은 결과를 모두 버린 뒤 남은 예측만으로 calibration이 좋다고 보고하지 않는다. ON에서 challenger를 관찰하더라도 primary의 답이나 후속 결과를 challenger 입력에 넣지 않는다.

## 10. 향후 fine-tuning

Laya 공식 저장소에는 도메인 데이터 구성→RLCD 학습→temperature fitting→평가를 다루는 fine-tuning notebook이 있다. 이것은 출발점이지 우리 schema/언어/성공 라벨을 자동으로 해결하는 학습 파이프라인이 아니다.[L12]

1. routing/retry/review/escalate를 별도 task family와 버전 있는 label schema로 정의한다. 입력은 **결정 시점 이전** 상태만 포함한다.
2. 테스트·재현·독립 검수로 확인한 label을 우선한다. Jev/host 출력은 teacher/weak label로 구분하며 실패한 작업을 성공 정답으로 복제하지 않는다. 정답이 여러 개면 허용 집합 또는 soft target으로 기록한다.
3. 학습/보정/최종 평가를 프로젝트·작업·시간으로 분리한다. 같은 작업의 반복 로그와 이후 결과가 입력이나 다른 split에 섞이지 않게 한다.
4. 먼저 supervised baseline과 현 checkpoint를 비교하고, 실제 개선이 있으면 공식 RLCD 방법을 검토한다. 학습 job은 별도 Python 환경에서 수행하며 MCP 추론 과정에 연결하지 않는다.
5. 학습 후 독립 calibration set으로 확률을 보정한다. artifact·언어·question type·선택지 수와 데이터가 충분한 task family 단위로 검증한다. 아주 작은 bucket에 과적합하지 않는다.
6. 고정된 weights/tokenizer/config와 평가 보고서를 새 manifest로 등록한다. 변경된 모델은 기존 qualification을 자동 승계하지 않는다. SHADOW→제한된 ON 승인과 즉시 이전 provider/artifact 복귀를 지원한다.

runtime와 공식 모델 카드의 라이선스는 **Apache-2.0**이며 현재 이 저장소는 MIT다. 의존 runtime/가중치의 고지·라이선스를 별도로 유지하고 복사·수정·재배포 시 원본 조건과 변경 고지를 확인한다. 상위 모델·학습 데이터·teacher 출력 이용 조건은 별도 검토 대상이다. 가중치 공개 라이선스가 사용자 소스·로그의 공개 허락을 의미하지 않는다.[L1][L6][L13]

## 11. 구현 단계와 완료 조건

아래 체크박스는 **아직 구현하지 않은 작업**이다. 이번 문서 반영을 구현 완료로 표시하지 않는다.

### P1 — Jev 동작 보존과 추상화

- [ ] 공통 request/result/identity/usage 계약과 adapter 2개용 작은 factory를 정의한다.
- [ ] 기존 HTTP·키 조회·wire encode/decode를 Jev adapter로 이동한다. malformed/timeout/redirect/secret 회귀는 유지한다.
- [ ] config/feature policy v1을 보존하는 migration과 provider별 acceptance를 구현한다.
- [ ] Jev만 설치한 환경에서는 Python·가중치·추가 네트워크 없이 현재 모든 tests/smoke/examples가 통과한다.

### P2 — 공식 Laya worker와 무손실 admission

- [ ] 준비·warm·status·close를 분리하고 기존 venv/artifact 재사용과 pin/hash 검증을 구현한다.
- [ ] JSONL·stdout 오염·오류 코드·동시성·queue·취소·timeout·orphan·OFF 해제 테스트를 작성한다.
- [ ] 실제 tokenizer로 state/header/option truncation을 사전에 차단한다. 긴 한국어·후반 중요 조건·옵션 순서 변경 회귀를 포함한다.
- [ ] 명시적 MPS/CPU별 실제 device/dtype를 확인한다. cold/warm·한/두 host memory 실측 보고서를 남긴다.
- [ ] Laya 선택 시 TypeSafe 키가 없어도 준비 가능하고, child 환경에 어떤 cloud key도 전달되지 않는다.

### P3 — 같은 제어 계층의 routing/filtering 연결

- [ ] inferenceCalls와 networkCalls를 분리하여 local worker가 bulk/전체 예산을 우회하지 못하게 한다.
- [ ] provider/identity/qualification 변경 중 도착한 결과를 거부하고 필터 제외 항목을 복원한다.
- [ ] 기존 6개 MCP 도구·CLI를 유지하며 양 host 실제 세션의 연결·재연결·종료를 확인한다.
- [ ] exhaustive/required/uncertain 보존과 host permissions 비승인 규칙을 두 provider에서 동일하게 검증한다.

### P4 — 관찰 및 실제 실행 평가

- [ ] blind 3-arm 관찰과 durable case/outcome linkage, 비내용성 metrics·opt-in dataset export를 구현한다.
- [ ] 실제 원시 응답/contract fixture와 별개로 한국어·영어·혼합 언어별 routing/retry/review/escalate 평가셋을 작성한다.
- [ ] baseline/Jev/Laya 실제 격리 실행에서 성공률·회귀·전체 지연·추론 호출 대체를 측정한다.
- [ ] 품질 허용폭·최소 표본·coverage·시간/메모리 예산을 사전에 정하고, 결과가 못 미치면 Jev 또는 host를 유지한다.

### P5 — 제한된 운영 및 전문화

- [ ] qualification이 있는 Laya task family만 명시적 ON을 허용한다. bulk와 model downgrade는 별도 승인한다.
- [ ] provider 전환·OFF·이전 artifact rollback을 검증한다. 자동 provider fallback은 계속 기본 OFF다.
- [ ] 실제 데이터가 충분하고 개선 여지가 있을 때만 fine-tuning과 MLX/ONNX/Core ML 최적화를 진행한다.

예상 신규 구현 파일은 `src/providers/jev.mjs`, `src/providers/laya.mjs`, `workers/laya_worker.py`, `src/acceptance.mjs`, 필요 시 `src/evidence.mjs` 정도로 제한한다. `provider.mjs`가 registry를 담당하고 별도 broker/서버 framework는 만들지 않는다. 실제 작업 단위별로 test와 문서를 함께 변경한다.

## 12. 이번 검토의 결론과 남은 불확실성

**추천: 현재 Node 제어 계층을 유지하되 provider 경계를 다시 만들고, 공식 Python Laya를 optional persistent worker로 연결한다.** 이 선택은 기존 구현이 아까워서가 아니라, 모드·권한·입력·실행 제어를 모델 런타임에서 분리하는 것이 두 provider 모두에 필요한 구조이기 때문이다.

Laya의 실무 가치는 아직 검증 대상이다. 특히 한국어·혼합 입력, 짧은 context, Score 난이도 판단, 과신 및 실제 저가 모델의 후속 실패가 중요하다. 포트·제작자 benchmark·SHADOW 일치율만으로 이를 해결했다고 하지 않는다. 이번 변경은 이 검토와 구현 계획 문서만이며, runtime/provider 추가·실 API 호출·현장 MPS 성능 검증은 수행하지 않았다.

## 근거 자료

자체 소스 링크의 검토 기준은 문서 상단 main SHA다. 외부 모델 카드와 제3자 port는 조사 시점 문서를 참고했으며, 향후 설치 시 HF revision·가중치 digest·dependency lock을 새로 고정해야 한다. 검색 색인의 모델 카드가 가리키는 HEAD를 실제 다운로드 artifact 검증으로 대체하지 않는다.

[L1]: https://huggingface.co/convaiinnovations/laya
[L2]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/laya/agent.py
[L3]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/laya/common.py
[L4]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/laya/router.py
[L5]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/BENCHMARKS.md
[L6]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/pyproject.toml
[L7]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/research/README.md
[L8]: https://github.com/receptron/laya
[L9]: https://onnxruntime.ai/docs/get-started/with-javascript/node.html
[L10]: https://github.com/mizorewww/laya-mlx
[L11]: https://github.com/mizorewww/laya-coreml
[L12]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb
[L13]: https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/LICENSE

추가 공식 확인: [Laya v0.3.4 배포](https://github.com/NandhaKishorM/laya/releases/tag/v0.3.4), [multilingual 모델 카드](https://huggingface.co/convaiinnovations/laya-multilingual), [typed-decisions 모델 카드](https://huggingface.co/convaiinnovations/laya-typed-decisions), [공개 Node ONNX export](https://huggingface.co/receptron/laya-onnx), [검토 대상 저장소 snapshot](https://github.com/jadeonstudio/jev-agent-control/tree/0ee6f568506491aafed82a66241212fcf737fad1).
