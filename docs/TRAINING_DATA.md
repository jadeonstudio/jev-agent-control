# Decision → Outcome → Evaluation → Dataset (v0.3)

## 경계

**Decision != Ground Truth · Agreement != Accuracy · Telemetry != Training Dataset · Inference != Training.**
Training Capture는 기본 OFF다. 온라인 학습, 자동 fine-tuning, 자동 checkpoint 변경·배포는 구현하지 않는다. 모델 결과에 임의의 `correct=true`를 붙이지 않는다.

Jev/Laya 멀티-provider 체크포인트를 이어서 완성했다. Node.js 제어 계층과 기존 OFF/SHADOW/ON 및 router/bulk 보호 정책은 공통이다. 추론은 로컬 `providers.json`에서 명시적으로 선택하고, 실패하면 원래 host 경로로 돌아간다. 자동으로 두 provider를 순회하거나, majority vote로 실행을 결정하지 않는다.

```text
Codex / Claude / 직접 소유한 runner
  → 공통 Decision Control Layer
  → Jev: TypeSafe HTTPS / Laya: 선택적 공식 Python 상주 worker
  → canonical Decision + immutable provider provenance
  → 별도 실제 실행
  → Outcome (실행 결과 또는 독립 annotation)
  → versioned purpose별 Evaluation
  → validated / deduplicated canonical Dataset
  → 독립 Laya exporter
  → 이후 명시적으로 수행할 offline fine-tuning
```

## 1. Provider와 실행

기존 설치는 Jev 그대로이며 `TYPESAFE_API_KEY`와 기존 키 보관 방식은 바뀌지 않는다. Laya를 사용하지 않으면 Python·가중치가 필요하지 않다. MCP 도구 이름은 하위 호환을 위해 `jev_*`를 유지한다. 이름이 Jev여도 설정된 provider를 사용한다.

`JEV_HOME/providers.json`은 0600 권한의 로컬 설정이다. 다음 값은 형식 예시이고 실제 경로·fingerprint로 교체해야 한다. 키는 넣지 않는다.

```json
{
  "version": 1,
  "provider": "jev",
  "laya": {
    "python": "/absolute/venv/bin/python",
    "modelPath": "/absolute/prepared-laya-checkpoint",
    "model": "laya/base",
    "checkpoint": "<64자리 SHA-256 fingerprint>",
    "runtimeVersion": "0.3.4",
    "device": "mps",
    "startupTimeoutMs": 120000,
    "idleTimeoutMs": 60000,
    "precision": "fp32"
  }
}
```

공식 `laya==0.3.4`와 모델은 별도 검토·다운로드 절차로 미리 준비한다. 실행 중에는 다운로드하지 않는다. 모델 루트·자식·상위 경로 symlink 및 remote model code 설정을 거부한다. 공식 tokenizer 호환성 수정이 필요한 파일은 준비 단계에서 수정한 **복사본**을 고정한다. worker가 로딩 중 원본 모델 설정을 수정하지 않는다.

worker는 매번 cold 시작한다는 뜻이 아니다. 실측(이 Mac, M4 Pro, english checkpoint, MPS, `scripts/laya-bench.py`): 24초 로드 중 약 19초는 ModernBERT 가중치의 무작위 초기화(`normal_`/`trunc_normal_`)였고, 뒤이은 `load_state_dict(strict=True)`가 그 값을 전부 덮어쓴다. transformers 공식 `transformers.initialization.no_init_weights()`로 그 단계를 건너뛰면(worker가 항상 시도하고, 설치된 transformers가 지원하지 않으면 조용히 기존 방식으로 되돌아간다 — `identity.load_mode`가 `no_init_weights`/`default`로 알려준다) 콜드 시작이 3.5–4.2초로 줄고, FP32 확률 결과는 완전히 동일하다(36/36, 확률 차 0.0). `precision: "fp16"`은 가중치를 절반으로 줄이지만(1,610MiB → 810MiB, english MPS) 속도 이득은 거의 없다. MPS에서 half 가중치는 `Agent.system_one`이 CUDA에서만 autocast를 켜기 때문에 그대로 두면 첫 추론에서 dtype 불일치 assert로 프로세스가 죽는다 — worker는 fp16을 켤 때 `laya.agent.torch.autocast`를 이 프로세스 한정으로 강제로 켠 상태(모든 device)로 감싸 이 문제를 우회한다(검증: english 36/36 일치, 최대 확률 차 0.0074). `identity.precision`은 실제 파라미터 dtype(`torch.float32`|`torch.float16`)을 보고하며 `providers.json`의 `laya.precision`과 일치해야 한다(불일치는 `LAYA_IDENTITY_MISMATCH`). 정밀도를 바꾸면 답이 조금 달라지므로 `qualification.precision`이 있으면 현재 `laya.precision`과 같아야 한다(다르면 `INVALID_PROVIDER_CONFIG`) — qualification을 정밀도에 묶어 둔다. `ready` 메시지의 `load_ms`가 실제 로드 시간을 보고한다.

```sh
# 파일만 해시하는 오프라인 준비 확인. 추론·다운로드·학습 없음.
python3 -I workers/laya_worker.py --fingerprint /absolute/prepared-laya-checkpoint
jev-control provider status
jev-control provider laya
jev-control shadow
```

상태의 `ready`는 파일 수준 준비 여부이며 실제 모델 로딩·품질 합격이 아니다. worker가 런타임 버전·가중치/tokenizer/config fingerprint·실제 장치/precision을 확인한다. MPS 요청이 CPU로 떨어지면 조용히 채택하지 않고 실패로 돌린다. cold 시작 제한과 warm 추론 제한은 별개다. 드문 연구 작업은 package root의 `engine.prepare({ timeoutMs?, signal?, resident: true })`로 cycle 밖에서 명시적으로 모델을 준비하고 idle 종료를 억제할 수 있다. `resident` 기본은 prepare에서만 `true`이며, 기존 `decide()`의 60초 idle 동작은 바뀌지 않는다. 준비는 추론·채택이 아니다. 두 호스트는 각자 worker를 가질 수 있다.

**(2026-09-23 owner 결정, "heartbeat나 공유 daemon을 추가하지 않는다"는 이전 계약을 개정) L3: 선택적 상주 서버.** 각 호스트 프로세스가 스스로 worker를 띄우는 대신, 사용자 범위 `launchd` 에이전트 하나(`jev-control laya serve --home <JEV_HOME>`, `install --laya-agent`로만 설치, macOS 전용, dry-run 승인 후 적용)가 `JEV_HOME/run/laya.sock`(디렉터리 0700, 소켓 파일 0600) 위에서 짧은 연결(줄 단위 JSON 요청 1개 → 응답 1개 → 종료)만 받는다. 네트워크 포트나 HTTP는 없다. `laya.serverIdleUnloadMs`(providers.json 선택 필드, 기본 1,800,000ms=30분, 범위 60,000–86,400,000)만큼 추론이 없으면 서버 프로세스는 유지한 채 worker만 내려 메모리를 반환하고, 다음 요청이 다시 올린다. hook은 항상 `layaSpawn:false, wait:false`로 엔진을 만들어 서버/worker가 준비돼 있지 않으면 즉시 `LAYA_NOT_READY`/`LAYA_SERVER_UNAVAILABLE`로 통과하며(로드는 백그라운드에서 시작), MCP·CLI `decide`는 `layaSpawn:true`이고 서버 소켓이 있으면 `wait:true`(호출의 `timeoutMs` 안)로 기다린다. `jev-control laya server-status`와 `doctor`의 `layaServer` 섹션은 상태만 읽으며 요청 내용을 남기지 않는다.

입력이 공식 tokenizer의 head/options/state 예산에서 잘리거나 mask token을 치환해야 하면 적용하지 않는다. Laya bulk는 한 snippet씩 평가하고, 실패·불확실·전수조사 자료를 보존한다. Laya는 checkpoint·purpose·calibrationVersion과 임계값을 명시한 `qualification`이 없으면 높은 확률을 내도 ON에서 채택하지 않는다. 임계값 복사나 `qualification` 파일 존재 자체는 성능 증명이 아니다.

## 2. 수집 동의와 데이터 위치

```sh
jev-control training capture status
jev-control training capture on    # 사용자가 명시적으로 승인한 경우만
jev-control training capture off
```

전역 추론 모드와 수집 설정은 별개다. global OFF는 추론을 막는다. 과거에 동의하고 수집한 decision의 지연 outcome은 추론 OFF에서도 기록 가능하나, capture OFF면 새 outcome도 기록하지 않는다. capture OFF는 과거 파일을 삭제하는 명령이 아니다. 요청 시작부터 완료까지 같은 수집 동의 generation이 유지된 경우에만 decision을 저장한다.

기본 저장 위치:

```text
$JEV_HOME/training/
  raw/decisions/<event-id>.json
  raw/outcomes/<event-id>.json
  raw/evaluations/<event-id>.json
  datasets/<dataset-version>/canonical.jsonl
  datasets/<dataset-version>/preferences.jsonl
  manifests/<dataset-version>.json
  exports/<dataset-version>/laya/{train,calibration,test}.jsonl
$JEV_HOME/runner.json          # 0600, TTY로 사전 등록한 검증 명령(argv, purpose, 라벨 매핑). 결과가 아니라 등록 내용만 담는다.
$JEV_HOME/links/<key-hash>.json  # 0700/0600, tool_use_id/agent_id -> decision_id 최소 인덱스, 30일 보존
```

JSONL 동시 append 대신 **이벤트별 불변 JSON 파일**을 사용한다. 디렉터리 0700 / 파일 0600, 작업 트리·bare Git 저장소 내부 및 symlink 경로를 거부한다. UUID, checksum, O_EXCL, fsync 및 공유 쓰기 lock으로 중복/충돌을 확인한다. lock 충돌은 명시적 실패로 반환하며 몰래 성공 처리하거나 이전 lock을 훔치지 않는다. 프로세스 중단 후 `.lock`이 남으면 모든 writer 종료를 확인하고 해당 빈 lock 디렉터리만 수동 복구한다. 원본이나 백업 전체를 에이전트에 출력하지 않는다.

원본은 append-only다. 파일 손상은 해당 이벤트를 격리해 계산에서 제외하고 숫자·오류 코드로 보고한다. 한 종류당 100,000개 / 단일 event 48KiB / 스캔 64MiB / 파생 파일 64MiB 상한이다. 장기간 운영은 작업 구간별 별도 보관·내보내기가 필요하다. 자동 삭제나 DB 서버는 없다.

저장하지 않는 것: 실제 API 키·credential·access token, 환경 전체, 고객/개인정보, 전체 대화, 저장소 전체, 불필요한 파일 내용. 상태는 최대 4KiB의 최소 자료만 허용하고 필드/비밀값/개인정보 패턴을 다시 검사한다. JSON 문자열 안의 민감 필드와 export의 모든 행도 검사한다. 패턴 검사는 완전한 DLP가 아니다. 호출자는 입력을 최소화·비식별화하고 export 전 사람이 재검토해야 한다. 동일 OS 사용자·root에 대한 암호화 금고/위변조 방지는 아니다.

## 3. 실제 결과 연결

decision 요청에 `trace.task_id`(UUID), `trace.snapshot_id`(저장소·검증 기준 snapshot의 SHA-256)를 붙인다. 비교군은 같은 `trace.comparison_id`도 사용한다. trace가 없으면 일반 추론은 가능하지만 데이터셋에는 포함하지 않는다. 결과 `id`가 `decision_id`다.

일반 MCP/CLI `decide`는 질문별 canonical 값, 확률, 모델의 confidence 통계와 그 의미, provider, 모델/체크포인트/전처리 버전, 시각·지연·사용량을 분리 기록한다. router가 반환한 tier는 Jev가 추정한 intent/difficulty/risk와 다르다. **라우팅이 성공했다고 분류 feature를 정답 처리하면 안 된다.** 해당 질문별 독립 라벨이나 실제 비교 실행이 필요하다.

실제로 소유한 runner를 in-process로 통합했다면 `src/training/store.mjs`의 `outcome()`을 직접 호출해 `source:'runner'`로 기록할 수 있다(예: AEGIS처럼 jev와 같은 프로세스에서 도는 실행기). 그 외 CLI/MCP 경로는 아래처럼 나뉜다. 실측 아닌 시간·토큰은 생략한다. `checks`에는 실제 결과를 보관한 내용의 `sha256:...` 참조를 넣고 원본 출력 자체는 저장하지 않는다. 이 참조는 상관관계/무결성 단서이지, 외부에서 자동 검증한 전자 서명이 아니다.

**(2026-09-23 owner 결정) `jev-control training outcome`의 stdin JSON은 비신뢰 입력이다.** 비TTY 에이전트도 이 명령을 파이프로 호출할 수 있어, `MCP jev_record`와 동일하게 **항상 `trust:'host'`로 강제해 `source:'host_review'`로 낮춘다.** 호출자가 `source:'runner'`나 `source:'human'`, objective/human label을 stdin에 적어도 그대로 저장되지 않는다. 이 CLI는 호스트가 사후에 관찰한 약한 근거를 남기는 용도로만 쓴다.

```sh
jev-control training outcome < host-review-outcome.json   # 항상 source:'host_review'
jev-control training host < sanitized-host-baseline.json
jev-control training evaluate
jev-control dataset stats
jev-control dataset validate
jev-control dataset build [--allow-small]
jev-control dataset export --version <출력된 hash> --format laya
```

강한(`objective`/`human`) 라벨은 아래 세 경로에서만 생긴다. 세 경로 모두 호출자가 라벨 값이나 실행 결과를 직접 주입할 수 없다.

1. **직접 소유한 in-process runner** — `store.outcome()`을 코드에서 직접 호출.
2. **`jev-control runner allow`/`runner verify`** — TTY에서 사람이 `runner allow --name N --timeout-ms MS [--purpose P --question Q --pass-label V --fail-label V] -- ARGV...`로 명령을 사전 등록한다(이름을 다시 입력해 재확인). 에이전트는 이후 `jev-control runner verify --decision <id> --check N`로 **등록된 이름만** 고른다. jev가 등록된 argv를 `child_process.spawn(argv[0], argv.slice(1), {shell:false, stdio:'ignore'})`로 직접 실행하고 종료 코드로 `source:'runner'` outcome을 기록한다. 명령의 stdout/stderr는 절대 저장하지 않는다. `question_id`가 등록돼 있으면 정상 종료한 경우에만 종료 코드 0/그 외를 각각 `pass_label`/`fail_label`에 매핑해 `kind:'label'` 객관 라벨도 함께 남긴다. 시간 초과·실행 실패·시그널 종료는 실패한 command check만 남기고 라벨은 만들지 않는다. 명령 환경에서 `TYPESAFE_API_KEY`는 제거한다. `purpose`가 등록돼 있으면 decision의 실제 purpose와 일치해야 하고, **route purpose에는 라벨(`question_id`) 등록 자체를 거부한다** — route 질문은 intent/difficulty/risk이며 명령 성공/실패의 정답이 아니기 때문이다(아래 참고). `runner remove --name`으로 제거, `runner list`로 목록 확인.
3. **`jev-control training correct --decision <id>`** — TTY 전용 대화형 사람 교정. decision의 purpose/최소화된 state/질문별 후보를 보여주고 사람이 고른 값만 `source:'human'` 라벨로 남긴다.

`runner allow`/`remove`와 `training correct`는 모두 stdin·stdout이 TTY가 아니면 `HUMAN_TTY_REQUIRED`로 거부한다. **TTY 검사는 동일 OS 사용자 안에서의 "로컬에서 직접 조작했다"는 신호일 뿐, 사람임을 증명하지 않는다.** PTY에 붙어 도는 코딩 에이전트도 TTY를 가지므로, 이는 SECURITY.md가 명시한 동일 OS 사용자 위협 모델 밖의 경계와 같다.

정확한 입력 필드는 `src/training/schema.mjs`, 실행 가능한 전체 예제는 `examples/training-pipeline.mjs`다. 예제는 synthetic inference와 실제 무해한 Node assertion으로 연결만 검증하며 모델 정확도 벤치마크가 아니다.

`jev_record` MCP 도구는 `{kind:"outcome"|"host",data:{...}}`를 받는다. MCP에서 전달한 outcome은 무조건 **host_review**로 낮추고, objective/human을 사칭하는 label도 weak source로 바꾼다. Terminal 권한이 있는 동일 OS 사용자는 어떤 파일도 위조할 수 있으므로 이 구분을 적대적인 로컬 사용자에 대한 보안 경계로 오해하면 안 된다. 스킬은 자동으로 capture를 켜거나 자신의 주장을 human/runner로 제출하지 않는다.

## 3-1. 결정 ↔ 실행 연결과 SubagentStop (호스트 hook이 사용할 라이브러리)

`src/training/links.mjs`의 `createLinkIndex()`는 호스트가 준 `tool_use_id`/`agent_id`를 `decision_id`에 최소 인덱스로만 연결한다(`JEV_HOME/links/`, 0700/0600, 30일 보존, 최대 10,000개, 원문·transcript 없음). Claude는 PreToolUse(Agent)의 `tool_use_id`와 PostToolUse(Agent) 결과의 `agentId`로, Codex는 SubagentStart/Stop의 `agent_id`로 연결한다(2026-09-23 P0 실측). `recordSubagentStop(store, links, {host, agent_id, status})`는 연결된 decision이 있을 때만 `source:'host_review'` outcome을 남긴다. `status:'completed'`는 성공이 아니라 `host_review:'uncertain'`으로, `'failed'`/`'interrupted'`는 `host_review:'fail'`로 기록하며 `task_succeeded`는 항상 `null`이다. 이 라이브러리는 P3에서 설치되는 host hook이 호출하며, 그 자체로는 CLI 명령을 추가하지 않는다.

## 3-2. 최소 표본 게이트

`training.json`의 `minStrongLabelsPerPurpose`(기본 100, `jev-control training min-labels`로 조회, `training min-labels N` 변경은 TTY에서만)는 `dataset build`가 만드는 데이터셋의 purpose별 강한 라벨 표본 수 최소 기준이다. 기준 미달 purpose가 있으면 `dataset build`는 `DATASET_TOO_SMALL`과 purpose별 실제 개수를 반환하고 아무것도 쓰지 않는다. `--allow-small`을 명시하면 진행하되 manifest에 `small_sample_override:true`와 `min_strong_labels_per_purpose`를 남긴다. 이 값은 dataset_version 해시에 포함되지 않으므로 임계값을 바꿔도 이미 만든 데이터셋의 재현성(dataset_version)에는 영향이 없다. `dataset export`는 train/calibration/test 중 하나라도 비어 있으면 `--allow-small`로도 우회할 수 없는 `EMPTY_SPLIT`으로 거부한다(canonical 포맷은 split이 없어 해당 없음).

## 4. 평가와 라벨

Decision, Outcome, Evaluation은 별도 이벤트다. 실행한 답이 실제 prediction과 일치했는지 확인한 후에만 해당 provider의 downstream 성공을 집계한다. `apply=true`만으로 baseline 모델 호출을 생략했다고 계산하지 않는다. 실제 runner가 생략을 기록하고 실행 답/active arm이 일치해야 `baselineCallsReportedSkipped`에 들어간다.

- route: quality·time·tokens·cost·retry·escalation을 보존한다. 성공 하나로 최적 worker라는 라벨을 만들지 않는다.
- select: artifact 생성·runtime error·재시도 등의 근거를 보존한다.
- retry: 실제 재실행 필요성·실패·timeout을 보존한다.
- review: 뒤늦은 심각한 문제·regression·human correction을 보존한다.
- judge: 테스트/build/lint/typecheck/runtime/artifact 근거를 보존한다.
- escalate: 실제 escalation·추가 agent·override·재시도 근거를 보존한다.

학습 라벨은 질문별 objective assertion(동일 question_id/evidence_ref의 필수 label check) 또는 명시적 human correction만 허용한다. 공통 build 통과, provider agreement, host 사후 의견은 이를 대신하지 못한다. label_confidence는 제공된 supervision 신뢰 등급이며 자동 보정된 확률이 아니다. v2 정책의 최소 등급은 0.9이며 정책 버전에 포함한다.

하나의 실제 final execution과 이후의 독립 non-executed annotation은 함께 평가할 수 있다. 서로 다른/충돌하는 실제 final execution이 둘 이상이면 모호하다고 제외한다. correction 라벨이 충돌해도 다수결로 해결하지 않는다. 문제를 수정해 다시 실행했다면 새 decision_id로 기록한다. SHADOW prediction에 active 작업 성공을 복사하면 그 평가를 거부한다. SHADOW에도 실행 여부와 독립적인 human/객관 라벨을 붙여 calibration하는 것은 가능하다.

## 5. 비교, 데이터셋, Laya export

`compare --live`는 외부 전송을 명시적으로 허용한 경우만 Jev/Laya 두 군을 같은 동결 입력으로 실행한다. active provider는 하나이고 observer 결과 값은 응답에서 숨긴다. 호출 중 모드/provider가 바뀌면 이전 active 결과도 무효화한다. 비교는 추가 비용·지연을 갖는 평가 경로이며 운영 fast path가 아니다. host baseline은 별도로 독립 생성해 동일 comparison/task/snapshot에 기록한다.

통계는 identity/purpose별 latency, 실제로 따랐던 prediction의 outcome, probability Brier/ECE 및 agreement를 분리한다. entropy confidence를 작업 성공 확률로 사용하지 않는다. 오류·host fallback은 content-free 운영 telemetry의 providerActivity에서 집계한다. capture 데이터만으로 전체 오류 분모를 계산하면 안 된다. Base/Custom Laya는 checkpoint가 달라 별도 군이다. 원본 응답의 API 토큰 수와 로컬 tokenizer 토큰 수를 동일 비용으로 합산하지 않는다.

Builder는 연결 누락, 손상 schema/checksum, 중복 ID, 불명확 provenance, 낮은/충돌 label, 부족한 evidence를 제외한다. 동일 raw 이벤트·정책의 canonical bytes/version은 재생성 가능하다. 파생 Evaluation은 raw Decision/Outcome에서 다시 계산하므로 정책 변경 시 원본을 덮어쓸 필요가 없다. manifest에는 생성 시각, dataset/model provenance, source hashes, sample/purpose/provider/label-source 분포, filtering/evaluation/exporter 버전이 남는다.

중복 샘플의 **모든 task ID**를 보존한 뒤 task 또는 동일 request/state로 연결된 샘플을 하나의 split group으로 묶는다. 결정적 80/10/10 train/calibration/test split이다. 소량 데이터에서 세 split이 모두 채워진다는 보장은 없다. 비슷하지만 서로 다른 입력의 의미적 중복은 자동 검출하지 않으므로 실제 학습 전 프로젝트/시간별 별도 holdout과 leakage 감사를 추가해야 한다.

Laya export는 [공식 학습 노트북](https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb)의 계약을 고정했다. `state`, `questions`, `gold`는 각각 **JSON 문자열인 세 열**이다. `gold[question_id].probabilities`는 choice의 label 순서, noul의 false/true, score의 0-based ordinal 분포다. 단일 명시 라벨은 one-hot으로 export하고, fractional score 평균만으로 target 분포를 꾸며내지 않는다. runtime의 안전 prefix와 공식 Python `json.dumps(instructions)` 전처리도 exporter v2에 반영한다.

Exporter는 canonical 형식과 분리돼 있으며, 학습 실행 코드는 없다. 공식 notebook을 실행할 때 기본 공개 dataset loader 대신 export 파일을 명시적으로 로드하고, tokenizer admission을 다시 확인해야 한다. calibration/test 파일을 train에 합치면 안 된다. 공식 runtime/모델은 Apache-2.0이며 독립 export 코드의 MIT와 별도로 upstream LICENSE/NOTICE 및 수집 데이터·teacher output 이용 권리를 검토한다.

## 6. Laya checkpoint 수명주기 (`src/training/laya-lifecycle.mjs`, `jev-control laya ...`)

이 저장소는 학습 실행 코드를 갖지 않는다. 오프라인 fine-tuning은 `training/laya-kit/`의 별도 키트로 수행하고, 그 결과물(로컬에 준비된 checkpoint 폴더)을 아래 경로로 넘긴다. 모든 단계는 operator가 CLI로 직접 호출해야 하며 자동 학습·자동 승격은 없다.

```text
(별도 laya-kit 오프라인 학습) → laya register → laya holdout freeze → laya qualify → laya compare → laya promote → laya rollback

자격이 없는 checkpoint를 SHADOW·데이터 수집용으로 쓰려면 `laya register --python <절대경로>`(첫 등록 시 providers.json이 없어도 됨) 뒤 `laya activate --candidate <hash>`를 쓴다. activate는 qualification 없이 laya 블록을 설치하므로 ON에서도 결과를 채택하지 않는다. 이미 자격을 받은 활성 checkpoint는 `ACTIVE_CHECKPOINT_QUALIFIED`로 덮어쓰지 않는다. provider 선택은 바꾸지 않고, rollback이 promote와 같은 스택으로 되돌린다. checkpoint가 바뀌어도 운영 설정(startupTimeoutMs, idleTimeoutMs, serverIdleUnloadMs)은 유지된다.
```

산출물은 모두 `JEV_HOME/laya/` 아래(디렉터리 0700 / 파일 0600, symlink·bare-Git 경로 거부)에 있으며 `providers.json`과 분리돼 있다:

```text
$JEV_HOME/laya/checkpoints/<fingerprint>/         # register가 복사한 관리 대상 checkpoint 사본
$JEV_HOME/laya/candidates/<fingerprint>.json      # {python, modelPath, model, checkpoint, runtimeVersion, device}
$JEV_HOME/laya/holdouts/<name>.jsonl               # 고정 회귀 holdout 샘플(불변, 재생성 거부)
$JEV_HOME/laya/holdouts/<name>.json                # holdout manifest(dataset_version, sample_count, sha256)
$JEV_HOME/laya/qualifications/<fingerprint>.json  # 제안 qualification + calibration/test/holdout 근거(카운트·지표만, 원문 state 없음)
$JEV_HOME/laya/comparisons/<active>__<candidate>__<holdout>.json  # 활성 checkpoint 대비 shadow 비교 보고
$JEV_HOME/laya/history.jsonl                       # promote/rollback이 있을 때마다 이전 laya 블록을 남기는 append-only 로그
```

`register`는 절대 경로 checkpoint 디렉터리를 symlink 없이 검증하고, `python -I workers/laya_worker.py --fingerprint <dir>`(오프라인, 파일 해시만, 추론 없음)로 지문을 계산한 뒤 관리 폴더로 복사한다. 이미 같은 fingerprint의 사본이 있으면 재계산해 일치를 확인하고 재사용한다. `providers.json`은 건드리지 않는다.

`qualify`는 데이터셋의 calibration split에서 purpose별로 격자(0.50–0.99, 0.01 단위)를 탐색해 selective accuracy와 coverage 기준을 만족하는 가장 낮은 임계값을 찾는다. choice 질문은 confidence와 selected probability를 모두, noul 질문은 `max(p, 1-p)`(certainty)를, score 질문은 confidence를 그 임계값과 비교한다. qualification 스키마는 전역 임계값 하나(`minConfidence`/`minChoiceProbability`/`noulCertainty`)만 갖고 있으므로, 자격을 통과한 purpose들의 임계값 중 최댓값(가장 보수적인 값)을 세 필드 모두에 동일하게 적용한다. 자격 여부는 test split과 고정 holdout 모두에서 표본 수(`minTest`)·selective accuracy(`targetAccuracy`)·Wilson 95% 신뢰구간 하한(`minLowerBound`)을 만족해야 확정된다. **(2026-09-23 실측 버그 수정)** score 질문의 정답 일치는 `answer.value`(확률가중 기대값, 예: 2.0257처럼 연속값)와 정수 target index를 `===`로 비교하지 않는다 — 실제로 이 비교는 항상 거짓이 되어 score 질문이 있는 pooled purpose가 qualify를 통과할 수 없었다. 대신 `argmax(answer.probabilities)`(문자열 인덱스)를 target index와 비교한다. choice/noul 비교는 그대로다.

`qualify`/`compare` 모두 실제 평가에 쓰인 각 answered 표본에 대해 content-free 질문별 원본 집계 `{n, raw_agreement, refused}`를 결과에 남긴다(purpose별 pooled 필드는 그대로 유지). `qualify`는 split별로 나눈 `by_question.{calibration,test,holdout}[question_id]`, `compare`는 `by_question.{candidate,active}[question_id]`다. qualify를 split별로 나누는 이유: calibration은 epoch·임계값 선택에도 쓰여 낙관적이고, holdout은 test split을 고정한 사본이라 합치면 test를 두 번 센다(2026-09-24 실측 — 합산 수치가 test 단독보다 높게 보였다). `raw_agreement`는 임계값과 무관한 argmax 기준 원본 일치율(`n`분의 정답 개수)이다.

`compare`는 후보와 현재 `providers.json`의 활성 laya checkpoint(없으면 `--no-active-baseline` 명시 필요)를 같은 고정 holdout으로 각각 추론해 purpose별로 두 값을 기록한다. **`--no-active-baseline`을 주면 활성 checkpoint가 설정돼 있어도 그 추론 자체를 건너뛴다**(2026-09-23 실측 버그 수정: 이전에는 플래그가 `ACTIVE_BASELINE_REQUIRED` 가드만 건너뛰고 활성 checkpoint를 그대로 추론했다) — 보고서의 `active`는 이때 항상 `null`이고 purpose별 결과에 `active` 항목 자체가 없다. `raw`는 임계값 없이 모든 답을 채점한 정확도이고, `selective`는 그 checkpoint가 자격을 받은 purpose에서만 자기 임계값으로 채점한 정확도·coverage다. `raw`/`selective`는 `refused`(입력 admission 거부로 응답하지 못한 표본 수)도 함께 담는다. 활성 baseline이 개별 표본에서 공식 tokenizer admission 거부(`INPUT_TRUNCATED`, `INPUT_REWRITE_REFUSED`)를 내면 그 표본만 정답 없음(`refused:true`, 어떤 임계값에도 커버되지 않음)으로 기록하고 compare 전체를 중단하지 않는다 — 그 외 오류 코드는 그대로 전체를 중단시킨다. `promote`는 다음을 모두 만족할 때만 `providers.json`의 laya 블록을 원자적으로 교체한다: 후보 qualification이 `qualified:true`이고 비교와 **같은 holdout**으로 만들어졌을 것(`QUALIFICATION_HOLDOUT_MISMATCH`), 같은 holdout의 비교 보고가 현재 활성 checkpoint 기준으로 존재할 것, 자격 purpose마다 후보의 `raw` 정확도가 활성보다 `maxRegression`(기본 0.02) 넘게 나쁘지 않을 것(망각 검사), 활성도 그 purpose 자격이 있으면 `selective` 정확도·coverage도 같은 허용치 안일 것. 자격 없는 활성(예: 첫 fine-tune 전 base)과는 서로 다른 임계값의 coverage를 비교하지 않는다. 쓰기 전에 결과 설정을 런타임 로더와 같은 `validateProviderConfig`로 검증한다. `provider`(jev/laya) 선택 자체는 바꾸지 않는다. 조건을 하나라도 어기면 `PROMOTION_REFUSED`와 위반 목록을 반환하고 아무것도 쓰지 않는다. `rollback`은 promote를 스택처럼 하나씩 되돌린다. 이미 되돌린 checkpoint를 다시 적용하지 않으므로 rollback이 게이트 없는 재승격이 되지 않는다. 현재 `providers.json`의 checkpoint가 마지막 promote가 설치한 것과 다르면 `ROLLBACK_STATE_MISMATCH`로 거부하고, 되돌릴 promote가 없으면 거부한다.

## 7. 증류(teacher) 데이터 (`src/training/laya-distill.mjs`, `jev-control laya distill ...`)

**owner 결정 (2026-09-23, `docs/plan/2026-09-23-laya-local-performance.md`):** Laya 한국어 route 판단 품질이 zero-shot으로는 쓸 수 없는 수준(B3/B5 실측)이라, teacher 증류 + 사람 검수로 학습한다. teacher = Jev(TypeSafe). 합성 작업 문장 3,000개(한·영 절반)를 teacher에 보내고, 그중 owner가 검수한 200개(한·영 100개씩)만 calibration/test/holdout의 정답으로 쓴다. **teacher 라벨은 train split에만 허용하고, calibration·test·holdout은 사람 검수 라벨만 허용한다.** 근거: 공식 `LocalLLaMA/typed-decisions` 데이터셋의 gold 자체가 사람 라벨이 아니라 LLM teacher의 3회 샘플 평균 분포이고, teacher 자체 일치도(0.735)가 fine-tune 후 test 정확도(0.766)보다 낮다 — teacher는 학습 신호로는 쓸 만하지만 독립적인 정답 판정 기준은 될 수 없다. 이 한계 때문에 teacher가 만든 라벨을 평가/자격(qualify) 기준에 섞으면 "teacher의 실수를 teacher 기준으로 통과시키는" 순환 검증이 된다.

**외부 전송 범위.** `distill import`로 들어온 합성 문장만 `egress:'allowed'`로 표시되고, `distill label`이 그 문장만 TypeSafe로 보낸다. 실제 spawn에서 캡처된 shadow task 문장(`distill import-shadow`, 기존 training capture의 route decision에서 가져온 `state.task`)은 `egress:'forbidden'`으로 저장되며 어떤 경로로도 teacher에 보내지지 않는다. `distill label`은 `--confirm-egress` 없이 거부되고(`EXPLICIT_REMOTE_TEACHER_CONSENT_REQUIRED`), 전역 OFF/SHADOW 모드와 무관하게 동작하는 별도의 명시 운영 배치다(일반 `decide()` 경로를 쓰지 않는다). 호출 간격은 분당 50회 이하로 스로틀하고, 동시 호출은 1개, 실패한 호출을 자동으로 재시도하지 않는다 — 실패는 `teacher-failures.jsonl`에 코드만 남고, 같은 task는 성공 라벨이 없으므로 다음 `distill label` 실행에서 자동으로 재시도 대상이 된다(재개 가능).

**state 고정 context 이유.** `routeGuard`(src/routing.mjs)는 `context`가 `{complete:true, scope:'local', previousFailures:0, highImpact:false, modelLocked:false, exhaustive:false}`일 때만 모델까지 도달한다. 증류 샘플의 teacher 호출·학습 target·실제 추론 입력이 이 고정 context로 전부 일치해야 train된 모델이 실제 route 판단 입력 분포와 같은 것을 본다. `laya-distill.mjs`의 `FIXED_ROUTE_CONTEXT`가 이 값을 고정하고, `distill label`/`distill review`/`distill build` 모두 같은 헬퍼로 요청을 구성한다.

**저장 위치** (`JEV_HOME/laya/distill/<run>/`, 디렉터리 0700 / 파일 0600, append-only JSONL, `noSymlinks`·`outsideGit`와 동일한 안전 규칙 재사용):

```text
tasks.jsonl             {task_id, lang, domain, group, reviewable, task, source:'synthetic'|'shadow', egress:'allowed'|'forbidden', added_at}
teacher.jsonl           {task_id, model, answers:{intent,difficulty,risk 각 {probabilities}}, usage, at}
teacher-failures.jsonl  {task_id, code, at} — 실패만, 재시도는 다음 label 실행이 eligible 재계산으로 자동 수행
review.jsonl            {task_id, labels:{intent,difficulty,risk}, reviewer:'human-tty', at}
reference.jsonl         {task_id, labels:{intent,difficulty,risk}, source, role:'eval'|'train', at} — AI 기준 라벨(아래 참조)
```

**AI 기준 라벨 (`ai_reference`, 2026-09-23 owner 결정, `docs/plan/2026-09-23-laya-local-performance.md` "평가 기준").** owner가 TTY로 영어 선택지·문장을 검수하기 어렵다고 판단해, calibration/test/holdout 정답을 사람 검수 대신 **Claude(또는 지정한 다른 리뷰어 모델)의 기준 라벨**로 대체할 수 있다. `laya distill import-reference --run R --input FILE.jsonl --source MODEL [--role eval|train]`로 가져온다: 입력 각 줄은 `{lang:'ko'|'en', task, labels:{intent, difficulty(1–5), risk}}`(difficulty는 `review`와 동일하게 내부적으로 0-based로 저장), `task`는 `import`와 **동일한 task_id 규칙**(정규화한 문장의 sha256)으로 이미 저장된 task를 찾는다. 찾지 못한 task가 하나라도 있으면 **아무것도 쓰지 않고** `DISTILL_REFERENCE_UNKNOWN_TASK`로 그 실행 전체를 거부한다(부분 반영으로 조용히 라벨을 잃지 않기 위함). `--source`는 안전한 모델-id 패턴(`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`)만 허용하고, `reference.jsonl`에 이미 있는 task_id는 건너뛰고 개수만 센다. 이 라벨은 **절대 `human`이나 `runner`로 기록하지 않고 항상 `label_source:'ai_reference'`**이며, provenance에 라벨링 모델(`source`)을 `model`/`model_version`/`checkpoint`로 남긴다(`provider:'host'`, `runtime_version:'ai-reference'`). qualify·compare·`compare-teacher` 결과는 "Claude 일치율"이며 정확도가 아니다.

`role`은 그 라벨이 어느 split을 근거하는지를 정한다. `role:'eval'`(기본)은 사람 검수와 동일하게 그룹 키 해시로 결정적 50/50 calibration/test에 들어간다. `role:'train'`은 `split:'train'`에 들어가되 **같은 task의 Jev teacher 표본을 대체한다**(둘 다 남기지 않는다) — Jev teacher와 Claude의 300문항 실측 일치율이 낮아서(intent .85 / risk .68 / difficulty .38, 2026-09-23 실측) "Laya가 Claude 수준"이라는 owner 목표에는 train도 Claude 기준이 필요하다고 판단했기 때문이다. 한 task의 라벨 우선순위는 **사람 검수(eval) > role:eval 기준 라벨 > role:train 기준 라벨 > Jev teacher(train)**이다. 그룹 누출 방지는 사람 검수와 동일한 규칙을 따른다: 그룹에 eval을 근거하는 멤버(사람 검수 또는 role:'eval' 기준 라벨)가 하나라도 있으면, 그 그룹의 나머지 train 근거 멤버(role:'train' 기준 라벨이든 Jev teacher든)는 train에서 전부 제외되고 `manifest.counts.excluded_group_leak`에 집계된다.

`laya distill compare-teacher --run R`은 Jev teacher와 기준 라벨이 **둘 다 있는** task만 대상으로 숫자만 담은 일치율 리포트를 낸다(정확도 아님, teacher는 정답이 아니다) — `role:'eval'`과 `role:'train'` 라벨을 `eval_reference`/`train_reference`로 **분리**해서, 질문별 일치 건수/비율, 혼동행렬(teacher 답 × 기준 라벨 답), 언어별 일치율, difficulty는 추가로 평균절대오차(1–5 스케일)와 "1 이내" 비율을 함께 보고하며, `eval_reference`는 `buildDistillDataset`과 **동일한 공유 split 판정 함수**로 나눈 `by_split:{calibration:{compared,questions}, test:{compared,questions}}`를 추가로 포함한다(두 계산이 어긋날 수 없다).

**`group`/`reviewable` — 번역쌍 누출 방지 (2026-09-23 owner 결정).** 합성 문장 코퍼스에는 같은 작업의 한/영 번역쌍이 섞여 있고(긴 항목의 약 44%), 한쪽이 사람 검수로 calibration/test에 들어가고 다른 쪽이 검수 없이 teacher 라벨로 train에 남으면 평가가 누출·과대평가된다. `import`의 각 줄에 `group`(기존 `ID` 정규식과 동일한 형식의 문자열, 선택)을 붙이면 `buildDistillDataset`이 이를 `task.group ?? task_id`로 그룹 키를 잡아 (1) 그룹 키로 `group_id`를 계산하고 사람 검수 task의 calibration/test 분배도 그룹 키 해시로 통일하며(같은 그룹의 검수된 멤버는 항상 같은 split), (2) 검수된 멤버가 있는 그룹의 나머지 teacher-라벨 task는 train에서도 완전히 제외한다(`manifest.counts.excluded_group_leak`로 집계). `group`이 없으면 그룹 키가 `task_id` 자신이 되어, 이 변경 이전과 정확히 같은 `group_id`/split 해시가 나온다(회귀 없음). `distill review`의 언어별 표본 선택도 그룹당 한 멤버만 고른다(같은 그룹의 다른 멤버가 이번 선택에 이미 뽑혔거나 이미 검수됐으면 건너뛴다) — 두 번역쌍에 검수 예산을 중복으로 쓰지 않기 위함이다.

짧은 합성 증강 문장(약 2,000개, 번역쌍 신뢰 탐지가 불가능한 길이)은 `reviewable:false`로 import해서 애초에 검수 후보에서 제외한다. `distill review`는 `reviewable:false` task를 절대 선택하지 않으며, 그런 task는 teacher 라벨을 통해서만 train을 보강한다 — 사람 검수 calibration/test 집합이 실제 긴 에이전트 프롬프트만 반영하도록 하기 위함이다(`reviewable`을 생략하면 기본값 `true`).

**흐름 (`jev-control laya distill ...`):**

1. `import --run R --input FILE.jsonl` — `{lang:'ko'|'en', domain?, task, group?, reviewable?}`(task 1–2000자) 검증. `group`은 `ID` 정규식을 만족하는 문자열만 허용(번역쌍 등 그룹 키), `reviewable`은 boolean만 허용(기본 `true`). `containsSensitiveData` **또는** `buildDistillDataset`이 최종 샘플에 쓰는 것과 동일한 `safeContent` 검사(이메일·전화번호·주민번호·키 접두사 등 더 엄격한 정규식 포함) 중 하나라도 걸리는 줄은 제외하고 개수만 `skippedSensitive`로 보고한다(2026-09-23 버그 수정: 두 검사가 서로 달라 import는 통과했는데 build 전체가 `TRAINING_SENSITIVE_OR_OVERSIZED`로 실패하는 사례가 있었다 — `import-shadow`도 동일). 정규화한 문장 텍스트의 sha256으로 `task_id`를 만들어 파일 내부·기존 저장분과 중복 제거한다. `source:'synthetic'`, `egress:'allowed'`로 저장.
2. `import-shadow --run R` — 기존 training capture store에서 `purpose:'route'`인 decision들의 `state.task`를 가져와 같은 정규화·중복 제거·민감정보 검사를 거쳐 `source:'shadow'`, `egress:'forbidden'`으로 저장한다. 언어는 한글 포함 여부로 휴리스틱 판정한다(동일 OS 사용자용 로컬 도구이며 정밀한 언어 감지가 필요하지 않다).
3. `label --run R --confirm-egress [--limit N]` — `egress:'allowed'`이고 아직 teacher 라벨이 없는 task만 대상으로 `callTypeSafe`를 직접 호출한다(모델은 `features.json`의 `router.expectedModel`). 진행 출력은 개수·오류 코드·누적 usage만 담고 문장 내용은 출력하지 않는다.
4. `review --run R [--count 200]` — stdin·stdout이 TTY가 아니면 `HUMAN_TTY_REQUIRED`. teacher 라벨이 있고 `reviewable`이 `false`가 아닌 task 중 task_id 해시 순으로 언어별 `count/2`개를 결정적으로 고르되, 같은 그룹(`group ?? task_id`)의 다른 멤버가 이번 선택에서 이미 뽑혔거나 이미 검수됐으면 건너뛴다. 이미 `review.jsonl`에 있는 task도 건너뛴다(중단 후 재개 가능). task마다 `[k/N] lang=<ko|en>` 진행 헤더와 작업 원문을 먼저 보여준다. 질문마다 안내문 아래에 선택지 전체를 번호로 나열한다(choice는 criteria key 순서로 `key — 설명`, score는 1~5의 criteria 문구) — teacher 최상위 답에는 `*` 표시, 각 선택지에 teacher 확률(소수 둘째 자리)을 함께 보여준다. Enter는 teacher 답 수락, choice는 1-based 번호나 대소문자 무관 key 입력, score는 1~5 숫자 입력으로 override, `s`는 그 task 건너뛰기(라벨 미기록, 다음 실행에서 다시 후보), `q`는 지금까지 기록한 것만 저장하고 종료한다. 그 외 입력은 세션을 중단시키지 않고 한 줄 오류를 보여준 뒤 같은 질문을 다시 묻는다(연속 5회 무효 입력이면 그 task를 자동으로 `s`(건너뛰기) 처리해 고장난 입력 스트림이 무한 대기하지 않게 한다). 저장되는 `labels` 형식(choice는 key 문자열, score는 0-based 정수)은 이전과 동일하다.
5. `import-reference --run R --input FILE.jsonl --source MODEL [--role eval|train]` — 위 "AI 기준 라벨" 참조. `role` 기본 `eval`.
6. `build --run R` — 표준 `datasets/<version>`(canonical.jsonl + manifest) 레이아웃으로 쓴다(같은 `training/` store를 공유하므로 `dataset export --format laya`, `laya holdout freeze`, `laya qualify`가 그대로 동작한다). 한 task의 라벨 우선순위는 사람 검수(eval) > role:eval 기준 라벨 > role:train 기준 라벨 > Jev teacher(train)다. 사람이 검수한 task와 role:'eval' 기준 라벨 task는 그룹 키 해시로 결정적 50/50 calibration/test로 가고(같은 그룹의 멤버는 항상 같은 split) `label_source`가 각각 `'human'`/`'ai_reference'`(둘 다 soft 아님, 확정 one-hot). role:'train' 기준 라벨 task는 `split:'train'`, `label_source:'ai_reference'`이며 **같은 task의 Jev teacher 표본을 대체한다**(둘 다 나오지 않는다). 남은 teacher-라벨 synthetic task는 `split:'train'`, `label_source:'teacher'`, `target.probabilities`는 teacher 분포 그대로(soft target)로 들어간다. eval을 근거하는 task(사람 검수 또는 role:'eval' 기준 라벨)는 절대 train에 들어가지 않는다(누출 방지). 같은 그룹에 eval 근거 멤버가 있으면 그 그룹의 나머지 train 근거 멤버(role:'train' 기준 라벨이든 teacher든)도 train에서 제외된다(`counts.excluded_group_leak`로 집계). shadow task는 사람이 직접 라벨을 단 경우에만 human 샘플로 포함되고, 아니면 데이터셋에서 제외된다. manifest `counts`는 `split`/`lang`/`label_source` 외에 `label_source_by_split`(split × label_source 교차 집계)도 남긴다. 위 1번과 같은 `safeContent` 검사를 task별로 다시 실행해 실패한 task는 (import 시점을 우회한 예전 데이터 등) 어떤 질문의 샘플도 만들지 않고 통째로 제외하며 빌드 전체를 실패시키지 않는다 — 개수는 `counts.excluded_unsafe`에 집계되고, 민감정보 사유가 아닌 다른 실패(스키마 버그)는 그대로 예외를 던진다.
7. `compare-teacher --run R` — 위 "AI 기준 라벨" 참조. Jev teacher와 기준 라벨이 둘 다 있는 task만 대상으로 숫자만 담은 일치율 리포트(정확도 아님)를 `eval_reference`/`train_reference`로 분리해 낸다.
8. `status --run R` — task 수(source/lang별), teacher 라벨·실패 수, 검수 수, 그룹 수(`groups`), 검수 후보 수(`reviewable`), 기준 라벨 수(`reference_labels`, role별 `reference_labels_by_role`), 누적 teacher usage만 반환한다. 문장 내용은 절대 포함하지 않는다.

**`readDataset`(src/training/dataset.mjs) 확장.** 기존 canonical 검증(스키마·해시·split·one-hot 정합성)은 그대로 두고 다음을 추가했다: (1) `label_source:'teacher'`는 `split:'train'`에서만 허용하고, train이 아닌 곳에 있으면 일반 `INVALID_CANONICAL_DATASET`이 아니라 구분되는 `TEACHER_LABEL_IN_EVAL_SPLIT`으로 거부한다 — `readDataset`을 공유하는 `freezeHoldout`/`qualifyCandidate`/`exportDataset` 모두 이 가드를 거친다. (2) `label_source:'teacher'`인 샘플의 `target.probabilities`는 정확한 one-hot 일치 대신 "질문 옵션 키와 정확히 일치 + 합이 1±0.02"만 요구한다(soft target 허용). (3) `label_source:'ai_reference'`(owner 결정 2026-09-23)는 **어느 split에서도 허용**하며 `human`과 동일하게 정확한 one-hot `target.probabilities`를 요구한다(soft target 아님, `teacher`처럼 train 제한도 없음). (4) `raw_refs`는 기존 `{decisions:[...], outcomes:[...]}` 외에 `{distill:{run, task_id}}` 형태도 허용한다(증류 샘플에는 원본 decision/outcome 이벤트가 없다). 증류 샘플의 `task_id`/`snapshot_id`는 여전히 UUID/sha256 포맷 검증을 통과해야 하므로, `laya-distill.mjs`는 task 텍스트의 sha256을 UUIDv4 형태로 재인코딩해 `task_id`로 쓰고(원본 64-hex 해시는 `raw_refs.distill.task_id`에 보존), `snapshot_id`는 `digest('distill-run:'+run)`을 공유한다(코드 스냅샷이 없는 합성 데이터라 run 전체가 하나의 스냅샷이다).

**`laya qualify`/`laya compare`도 `ai_reference` 평가 표본을 반영한다.** 두 명령 모두 결과에 `evaluation_label_sources`(평가에 실제로 쓰인 표본의 label_source별 개수 — qualify는 calibration+test+holdout, compare는 그 비교가 쓴 holdout)와 `metric_semantics`(그중 하나라도 `ai_reference`면 `'agreement-with-ai-reference'`, 아니면 기존 `'accuracy'`)를 함께 남긴다. `laya holdout freeze`는 기존과 동일하게 데이터셋의 test split을 그대로 얼리므로 `ai_reference` 표본도 자동으로 holdout에 포함된다(별도 label_source 필터 없음).

**한계.** teacher 자체 오류가 train 라벨에 그대로 들어간다 — 이는 설계상 감수하는 트레이드오프이며, 그래서 calibration/test/holdout을 teacher와 독립된 사람 검수로만 고정했다. `laya qualify`의 자격 판정은 항상 이 사람 검수 split만 보므로, 자격 있는 checkpoint의 판단 신뢰도는 teacher 품질이 아니라 사람 검수 결과에 근거한다.

**teacher는 전체 task를, student는 동일한 규칙으로 head-fit된 task를 본다.** teacher(Jev/TypeSafe)는 B7이 측정한 로컬 tokenizer 예산과 무관하게 합성 task 문장 전체를 받는다. student(Laya)는 학습 때든 실제 추론 때든 같은 무손실 예산 제약을 받는다 — 이 불일치를 줄이기 위해 `workers/laya_worker.py`의 `fit_task_head(agent, state, questions)`가 `assert_lossless()`가 통과하지 않을 때만 발동하는 opt-in 경로를 추가했다: `state["task"]`의 **가장 긴 prefix**(다른 state 키·질문·지시문·선택지는 전혀 건드리지 않음)를 찾아 그 뒤에 고정 marker `" …[truncated]"`(`TRUNCATION_MARK`)를 붙이고, 그 결과가 다시 `assert_lossless()`를 통과하는지 검증한다. 어떤 prefix도 통과하지 못하면(예: context/질문 자체가 이미 예산을 넘거나 mask token이 섞였으면) 기존과 동일하게 거부한다. 이 경로는 `providers.json`의 `laya.inputFit`(기본 `'lossless'`, `register --input-fit lossless|task-head`로 checkpoint 등록 시 고정 — precision과 동일한 취급)이 `'task-head'`일 때만 켜진다. **training 저장 스키마(`src/training/schema.mjs` `validateProvenance`)는 provenance의 모든 필드가 문자열이어야 하므로, worker 응답의 `input_fit:{truncated, original_chars, kept_chars}`(문장 없이 숫자만, 정수 검증 실패 시 `{truncated:false}`로 취급)는 provenance 안이 아니라 정규화된 결과의 별도 `inputFit` 필드로만 남는다.** 그 대신 provenance의 `preprocessing_version`이 모드를 문자열로 나타낸다 — lossless는 `official-laya-0.3.4-lossless-v1`, task-head는 `official-laya-0.3.4-task-head-v1`(둘 다 `settings.laya.inputFit`이 결정하는 **설정된 모드**이며 그 요청이 실제로 잘렸는지는 반영하지 않는다). `jev-control metrics`(`providerActivity.laya.routeInputFitTruncated`)는 route purpose 한정으로, 엔진 텔레메트리가 요청마다의 `inputFit.truncated`를 읽어 집계한다.

**train 전처리도 동일한 fit을 identical하게 적용한다.** `training/laya-kit/train_from_export.py`는 standalone Kaggle kit이라 `workers/laya_worker.py`를 import할 수 없으므로, `fit_task_head()`/`assert_lossless()`를 그대로(byte-identical) 복사해 갖고 있다 — `tests/test_laya_kit_input_fit.py`가 두 사본이 여러 synthetic 케이스에서 동일한 결과를 내는지 검증한다. `build_training_item()` 호출 전, export의 각 row(state)에 대해 그 row 자신의 전체 질문 집합(export가 gold를 question_id별로 묶는 바로 그 질문들, 추론이 보내는 것과 같은 집합)을 넘겨 fit을 적용하고, `state["task"]`만 fit된 값으로 바꾼 뒤 질문별 `build_training_item`을 호출한다. 어떤 prefix도 맞지 않는 행은 그 행의 모든 질문을 기존 marker-loss drop과 같은 방식으로 버린다(`check_tokenizer_admission`이 여전히 그 비율을 본다). 로그에 `[input-fit] N states task-head truncated`로 잘린 state 수를 보고한다.

**실측 overhead** (M4 Pro, `<laya-venv>/bin/python scripts/laya-budget.py --model-dir <ckpt> --fit --runs 20`, EN/KO 2,500자 합성 task, 목표는 호출당 <15ms):

| checkpoint | EN kept_chars / median ms | KO kept_chars / median ms |
|---|---|---|
| english | 1,533 / 약 15.4–16.7ms | 294 / 약 16.0–17.3ms |
| multilingual | 이미 무손실(잘림 없음) / 약 2.4–2.5ms | 1,467 / 약 16.9–17.6ms |

fit_task_head는 분석적 token-budget 추정으로 시작점을 한 번 계산한 뒤(질문별 head/option tokenize + base/task tokenize) 그 지점에서 doubling-step으로 경계를 양쪽으로 감싸고(gallop) 마지막에만 그 좁은 구간을 binary search한다 — 최종 결과는 항상 `assert_lossless()`로 재검증한다(속도보다 정확성 우선). 실측상 english checkpoint는 목표 15ms에 근접하거나 근소하게(약 1–2ms) 초과했고 multilingual의 한국어 경로도 비슷했다; multilingual의 영어 경로는 애초에 무손실이라 가장 빠르다(호출 1회로 끝).

## 검증 후에만 다음 단계

Jev 실API, 실제 공식 Laya 가중치/MPS, Codex/Claude native 세션과 대표 한국어 업무의 품질·calibration은 offline fixture 테스트와 다르다. 별도로 실제 runtime smoke → blind shadow → 격리 paired downstream 실행 → 검증된 좁은 purpose만 ON 순서로 검증한다. 학습은 충분한 검증 라벨이 쌓인 뒤 offline training → holdout 평가 → shadow → 명시적 promotion으로 수행하며 이 저장소가 자동으로 시작하지 않는다.
