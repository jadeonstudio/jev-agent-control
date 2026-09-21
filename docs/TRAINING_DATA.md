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
    "idleTimeoutMs": 60000
  }
}
```

공식 `laya==0.3.4`와 모델은 별도 검토·다운로드 절차로 미리 준비한다. 실행 중에는 다운로드하지 않는다. 모델 루트·자식·상위 경로 symlink 및 remote model code 설정을 거부한다. 공식 tokenizer 호환성 수정이 필요한 파일은 준비 단계에서 수정한 **복사본**을 고정한다. worker가 로딩 중 원본 모델 설정을 수정하지 않는다.

```sh
# 파일만 해시하는 오프라인 준비 확인. 추론·다운로드·학습 없음.
python3 -I workers/laya_worker.py --fingerprint /absolute/prepared-laya-checkpoint
jev-control provider status
jev-control provider laya
jev-control shadow
```

상태의 `ready`는 파일 수준 준비 여부이며 실제 모델 로딩·품질 합격이 아니다. worker가 런타임 버전·가중치/tokenizer/config fingerprint·실제 장치/precision을 확인한다. MPS 요청이 CPU로 떨어지면 조용히 채택하지 않고 실패로 돌린다. cold 시작 제한과 warm 추론 제한은 별개다. 드문 연구 작업은 package root의 `engine.prepare({ timeoutMs?, signal?, resident: true })`로 cycle 밖에서 명시적으로 모델을 준비하고 idle 종료를 억제할 수 있다. `resident` 기본은 prepare에서만 `true`이며, 기존 `decide()`의 60초 idle 동작은 바뀌지 않는다. 준비는 추론·채택이 아니며 heartbeat나 공유 daemon을 추가하지 않는다. 두 호스트는 각자 worker를 가질 수 있다.

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
```

JSONL 동시 append 대신 **이벤트별 불변 JSON 파일**을 사용한다. 디렉터리 0700 / 파일 0600, 작업 트리·bare Git 저장소 내부 및 symlink 경로를 거부한다. UUID, checksum, O_EXCL, fsync 및 공유 쓰기 lock으로 중복/충돌을 확인한다. lock 충돌은 명시적 실패로 반환하며 몰래 성공 처리하거나 이전 lock을 훔치지 않는다. 프로세스 중단 후 `.lock`이 남으면 모든 writer 종료를 확인하고 해당 빈 lock 디렉터리만 수동 복구한다. 원본이나 백업 전체를 에이전트에 출력하지 않는다.

원본은 append-only다. 파일 손상은 해당 이벤트를 격리해 계산에서 제외하고 숫자·오류 코드로 보고한다. 한 종류당 100,000개 / 단일 event 48KiB / 스캔 64MiB / 파생 파일 64MiB 상한이다. 장기간 운영은 작업 구간별 별도 보관·내보내기가 필요하다. 자동 삭제나 DB 서버는 없다.

저장하지 않는 것: 실제 API 키·credential·access token, 환경 전체, 고객/개인정보, 전체 대화, 저장소 전체, 불필요한 파일 내용. 상태는 최대 4KiB의 최소 자료만 허용하고 필드/비밀값/개인정보 패턴을 다시 검사한다. JSON 문자열 안의 민감 필드와 export의 모든 행도 검사한다. 패턴 검사는 완전한 DLP가 아니다. 호출자는 입력을 최소화·비식별화하고 export 전 사람이 재검토해야 한다. 동일 OS 사용자·root에 대한 암호화 금고/위변조 방지는 아니다.

## 3. 실제 결과 연결

decision 요청에 `trace.task_id`(UUID), `trace.snapshot_id`(저장소·검증 기준 snapshot의 SHA-256)를 붙인다. 비교군은 같은 `trace.comparison_id`도 사용한다. trace가 없으면 일반 추론은 가능하지만 데이터셋에는 포함하지 않는다. 결과 `id`가 `decision_id`다.

일반 MCP/CLI `decide`는 질문별 canonical 값, 확률, 모델의 confidence 통계와 그 의미, provider, 모델/체크포인트/전처리 버전, 시각·지연·사용량을 분리 기록한다. router가 반환한 tier는 Jev가 추정한 intent/difficulty/risk와 다르다. **라우팅이 성공했다고 분류 feature를 정답 처리하면 안 된다.** 해당 질문별 독립 라벨이나 실제 비교 실행이 필요하다.

실제 runner는 `src/training/store.mjs`의 `outcome()` 또는 `training outcome` stdin으로 결과를 남긴다. 실측 아닌 시간·토큰은 생략한다. `checks`에는 실제 결과를 보관한 내용의 `sha256:...` 참조를 넣고 원본 출력 자체는 저장하지 않는다. 이 참조는 상관관계/무결성 단서이지, 외부에서 자동 검증한 전자 서명이 아니다.

```sh
jev-control training outcome < sanitized-outcome.json
jev-control training host < sanitized-host-baseline.json
jev-control training evaluate
jev-control dataset stats
jev-control dataset validate
jev-control dataset build
jev-control dataset export --version <출력된 hash> --format laya
```

정확한 입력 필드는 `src/training/schema.mjs`, 실행 가능한 전체 예제는 `examples/training-pipeline.mjs`다. 예제는 synthetic inference와 실제 무해한 Node assertion으로 연결만 검증하며 모델 정확도 벤치마크가 아니다.

`jev_record` MCP 도구는 `{kind:"outcome"|"host",data:{...}}`를 받는다. MCP에서 전달한 outcome은 무조건 **host_review**로 낮추고, objective/human을 사칭하는 label도 weak source로 바꾼다. 강한 evidence는 별도 신뢰한 runner 또는 사용자의 명시적 correction 경로에서만 입력한다. Terminal 권한이 있는 동일 OS 사용자는 어떤 파일도 위조할 수 있으므로 이 구분을 적대적인 로컬 사용자에 대한 보안 경계로 오해하면 안 된다. 스킬은 자동으로 capture를 켜거나 자신의 주장을 human/runner로 제출하지 않는다.

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

## 검증 후에만 다음 단계

Jev 실API, 실제 공식 Laya 가중치/MPS, Codex/Claude native 세션과 대표 한국어 업무의 품질·calibration은 offline fixture 테스트와 다르다. 별도로 실제 runtime smoke → blind shadow → 격리 paired downstream 실행 → 검증된 좁은 purpose만 ON 순서로 검증한다. 학습은 충분한 검증 라벨이 쌓인 뒤 offline training → holdout 평가 → shadow → 명시적 promotion으로 수행하며 이 저장소가 자동으로 시작하지 않는다.
