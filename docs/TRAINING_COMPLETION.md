# v0.3 구현 복구 및 검증 기록

확인일: 2026-09-21. 작업 브랜치: `feat/decision-training-capture`.

중단된 응답과 별개로 구현은 커밋 `b22e438a2aa9592e95fe2bb50b0a7f57dac8a6f6`에 이미 보관되어 있었다. 이번 재개에서는 이 구현을 새로 만들거나 덮어쓰지 않고, 저장된 소스·공식 Laya export 계약·실행된 CI 로그를 확인했다. 이 기록을 추가하는 커밋은 실행 코드를 변경하지 않는다. `main`에 자동 병합하지 않는다.

사용자 컴퓨터의 원격 연결이 없어 Mac의 현재 working tree·미커밋 변경은 확인하지 못했다. 따라서 이 기록은 GitHub에 보관된 브랜치에 대한 검증이며, 사용자 컴퓨터의 설치·설정·키·현재 모드를 변경했다는 의미가 아니다. 로컬에서 업데이트할 때는 기존 remote·branch·미커밋 변경을 먼저 확인하고 보존해야 한다.

## 1. 구현된 경계

```text
Agent / 명시적 runner
  → 공통 모드·범위·예산·응답 검증
  → 선택된 provider 하나: Jev API 또는 공식 Laya Python worker
  → canonical Decision + provider/model/checkpoint provenance
  → 실제 실행은 host/runner가 담당
  → 별도 Outcome
  → purpose별 versioned Evaluation
  → 검증·중복 제거·그룹 분할된 canonical Dataset
  → 별도 Laya export 형식
```

Jev 전용 설치에는 Python이 필요 없다. Laya는 별도 준비한 공식 `laya==0.3.4` 환경과 로컬 모델을 사용한다. 자동 다운로드·provider cascade·online learning·fine-tuning·모델 승격은 없다. MCP 도구를 설치했다는 이유만으로 에이전트 내부의 모든 판단이나 작업 결과가 자동 수집되는 것은 아니다. 실제 runner가 `decision_id`에 맞는 outcome을 제출해야 한다.

## 2. 주요 파일

| 파일 | 역할 |
|---|---|
| `src/engine.mjs`, `src/inference.mjs` | 명시적 provider 선택, canonical provenance, 모드·취소·비교·수집 연결 |
| `workers/laya_worker.py` | 공식 Python 상주 worker, 로컬 fingerprint와 tokenizer 잘림 검사 |
| `src/training/schema.mjs`, `store.mjs` | 별도 Decision/Outcome/Evaluation 계약, 동의 기반 불변 raw 저장 |
| `src/training/evaluate.mjs` | 목적별 evidence, 독립 라벨 검증, agreement/calibration/실행 지표 |
| `src/training/dataset.mjs` | 재현 가능한 builder, 그룹 분할, canonical 및 Laya exporter |
| `src/training/host.mjs`, `cli.mjs` | 독립 host 기록과 명시적 수집·결과·dataset 명령 |
| `examples/training-pipeline.mjs` | 합성 판단부터 실제 무해한 assertion·dataset·export까지 오프라인 예제 |
| `tests/training*.test.mjs`, `tests/test_laya_worker.py` | 수집·평가·재현성·provider·worker 경계 회귀 테스트 |

## 3. 데이터 품질과 개인정보

**Decision != Ground Truth. Agreement != Accuracy. Telemetry != Training Dataset. Inference != Training.**

Training Capture는 기본 OFF다. 켜져 있는 동일 동의 generation 안에서만 최소 sanitized decision을 저장한다. outcome은 별도 이벤트이며, 일반적인 build 성공이나 provider 다수결을 질문별 정답으로 변환하지 않는다. 학습용 target은 질문별 객관적 assertion 또는 명시적 human correction이 있어야 한다. MCP로 제출한 평가는 weak host evidence로 처리한다. 동일 OS 사용자에 대한 위변조 방지나 cryptographic attestation을 제공하는 것은 아니다.

Raw evidence는 `$JEV_HOME/training/raw/`의 이벤트별 불변 JSON 파일에 저장하고 derived dataset과 manifest를 분리한다. Git worktree/bare repository 및 symlink 경로를 거부하고 디렉터리 0700·파일 0600, checksum·exclusive write·동시 쓰기 lock을 사용한다. 손상·고아·중복·충돌 라벨·출처 미상·근거 부족 샘플은 제외한다. 원본 요청과 선택지의 순서를 보존하고 같은 task/input/state 그룹을 학습·보정·평가 split 사이에 나누지 않는다.

API 키, credential, 환경 전체, 전체 저장소·대화, 불필요한 파일·고객/개인정보를 수집 대상으로 삼지 않는다. operational telemetry에는 원문 상태·질문·응답값을 추가하지 않는다. 비밀값/민감 필드 탐지는 최선의 방어이지 완전한 DLP가 아니므로 호출자의 최소화·비식별화와 export 전 검토가 필요하다. Capture OFF는 기존 데이터를 삭제하지 않으며, 그 이후 새 content-bearing capture를 막는다.

## 4. 공식 Laya export 계약

검토한 공식 기준:

- [Laya 공식 fine-tuning notebook, 고정 revision](https://github.com/NandhaKishorM/laya/blob/42626c348753fbb17572a813127df2278a1ec527/notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb)
- notebook blob SHA: `913799ccfe612c381f03df7df67d146a2a93c478`

공식 loader는 `state`, `questions`, `gold` 세 열 각각에 `json.loads`를 적용한다. exporter는 이 세 값을 JSON 문자열로 저장한다. Choice의 선택지 순서, Noul의 false/true 분포, Score의 0-based bin과 wire instruction 변환을 유지한다. 내부 canonical/raw 형식은 이 notebook 형식과 독립적으로 보존한다. `train`, `calibration`, `test` 파일을 분리하며 exporter는 학습을 실행하지 않는다.

## 5. 확인한 실제 검증 결과

기준 코드: `b22e438a2aa9592e95fe2bb50b0a7f57dac8a6f6`.

[GitHub Actions 실행 35592990733](https://github.com/jadeonstudio/jev-agent-control/actions/runs/35592990733)의 네 조합(macOS/Linux × Node.js 22/24)이 모두 성공했다. Ubuntu/Node 22의 실제 job log에서 다음 수치를 확인했다.

| 검증 | 결과 |
|---|---|
| JavaScript syntax | 41 modules 통과 |
| JavaScript 자동 테스트 | 169 통과 / 실패 0 / 건너뜀 0 |
| Python worker 경계 테스트 | 4 통과 |
| 기존 offline smoke | 성공, 외부 API 호출 0 |
| fast-path 및 classifier-design 예제 | 성공, 합성 분기 검증 |
| training-pipeline 예제 | 실제 무해한 assertion 성공 → 샘플 1개 → 동일 dataset 재생성 → Laya export 성공 |
| 테스트 후 Git working tree | 생성 데이터·소스 변경 없음 |

CI는 `contents: read`이고 유료 API 키·실제 모델 가중치 없이 실행한다. 따라서 이는 구현/계약/개인정보 경계의 회귀 검증이지, 실제 Jev 응답 품질·Laya 모델 추론·MPS 성능·native Codex/Claude 세션·토큰 절감률 검증이 아니다.

## 6. 실제 운영 수집과 fine-tuning 전 남은 일

사용자 환경에서 고정한 Laya 모델과 공식 runtime을 준비하고 fingerprint, 실제 장치, cold/warm 추론 및 입력 잘림 거부를 확인해야 한다. Jev live 계약과 각 호스트 MCP 연결도 별도로 확인한다. 이 과정에서 production provider·capture 모드를 임의로 켜지 않는다.

실제 runner가 task/snapshot/decision ID와 실행된 선택, 필수 검사 evidence, 실측 비용·시간·재시도·escalation을 제출하도록 연결해야 한다. outcome 또는 독립 라벨이 부족하면 builder가 샘플을 제외하는 것이 정상이다. SHADOW 결과에는 실행하지 않은 대체 모델의 성공을 복사하지 않는다.

충분한 purpose별 데이터와 독립적인 supervision을 모은 뒤 민감정보·라벨 품질·빈 split·중복 누출을 검토한다. 이후 별도 명시적 학습 작업에서 tokenizer admission, offline fine-tuning, holdout 평가, calibration, SHADOW 비교를 수행하고, 개선이 확인된 checkpoint만 명시적으로 배포한다.

명령과 정확한 입력 스키마는 [TRAINING_DATA.md](TRAINING_DATA.md), 실행 가능한 end-to-end 예제는 [training-pipeline.mjs](../examples/training-pipeline.mjs)를 참조한다. 수집과 학습을 자동 활성화하지 않는다.
