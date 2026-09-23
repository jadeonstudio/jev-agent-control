# Laya 로컬 성능·에이전트 효율 계획 (2026-09-23)

owner 요청: 이 Mac(Apple M4 Pro, GPU 16코어, 통합 메모리 24GB)에서 Laya가 온전한 성능을 내도록 다시 설치하고, Codex·Claude 사용 시 속도·비용 측면에서 실제로 효율적이게 만든다. 공개 리서치와 로컬 실측을 병행하고 저장소를 계속 갱신한다.

## owner 결정 (2026-09-23)

| 결정 | 내용 |
|---|---|
| 상주 서버 | 로그인 시 자동 시작(사용자 launchd 에이전트) + JEV_HOME 안 Unix 소켓(0600, 네트워크 포트 없음). 일정 시간 쓰지 않으면 모델을 내려 메모리 반환. 서버가 없거나 모델이 내려가 있으면 hook은 기다리지 않고 즉시 통과. 설치·제거는 dry-run 후 승인. 기존 계약("공유 daemon 없음")을 이 결정으로 개정한다. |
| 실적용 (2차) | 전부 적용: 설치본 갱신, Codex 블록 교체, english checkpoint 등록 + providers.json FP16·MPS, launchd 에이전트 설치·bootstrap. 전역 쓰기는 dry-run을 보이며 진행. |
| 판단 제공자 | Laya로 전환: SHADOW 데이터를 비용 0으로 수집. 자격이 없으므로 jev_decide 채택은 자격이 생길 때까지 멈춘다(원래 호스트 판단으로 돌아감). |
| 학습 방식 | teacher 증류 + 사람 검수: teacher 라벨은 train split에만 허용하고, calibration·test·holdout은 owner가 검수한 라벨만 쓴다. teacher 방식·비용은 추정치와 함께 별도 승인. |
| teacher·규모 (2026-09-23) | teacher = Jev(TypeSafe), 합성 작업 문장 3,000개(한·영 절반) + owner 검수 200개(한·영 100개씩). TypeSafe에는 합성 문장만 보내고, 실제 spawn 문장은 외부로 보내지 않는다. teacher 라벨은 train split에만, 검수 라벨은 calibration·test·holdout에만 쓴다. |
| 평가 기준 (2026-09-23 개정) | owner 목표는 "Laya가 Claude 수준으로, 훨씬 빠르게 판단"이다. owner가 영어 선택지·영어 문장 검수가 어렵다고 판단해 사람 검수 대신 **Claude 기준 라벨**(`label_source: ai_reference`, 라벨링 모델 기록)을 calibration·test·holdout 기준으로 쓴다. `human`으로 기록하지 않고, qualify·compare 결과는 "Claude 일치율"로 부르며 정확도라 하지 않는다. 실제 실행 결과(runner 등 objective 라벨)가 쌓이면 별도 기준으로 둔다. Jev teacher 라벨은 계속 train에만 쓰고, 같은 평가 세트에서 Jev와 Claude의 일치율을 먼저 재서 train 라벨 교체 여부를 정한다. |
| Codex 관리 블록 | "작업자 spawn 전 jev_route 호출" 안내를 의미 있는 크기의 독립 작업으로 좁히고, codex exec A/B로 추가 턴 비용을 실측한 뒤 유지·제거를 정한다. |

## 리서치 요약 (출처는 세션 기록, 2026-09-23 확인)

- **Laya 공식**: 인코더 전용 결정 모델. english = ModernBERT-large 기반 421M, context 512. multilingual = mmBERT-base 기반 322M, context 1024, 영어 대비 약 2배 빠름. typed-decisions = 421M, 4개 업무 흐름 전용 fine-tune. 한국어 MASSIVE intent 정확도 english 0.110 / multilingual 0.450(공식 BENCHMARKS.md). 공식 권장 서빙은 `Router(preload=True)` 상주. MPS·16비트 공식 수치 없음. 0.3.5는 Router 스레드 안전성·Python ≥3.10, 0.3.6은 로망스어 ASCII 라우팅 수정. MPS autocast PR #51, truncation 플래그 버그 #174는 미병합.
- **Apple Silicon 서빙**: M4 Pro에서 FP16의 속도 이득은 약 10%로 작다(비공식 실측). 메모리 절감이 주 이득. `torch.compile` MPS는 아직 프로토타입. MLX/ONNX+CoreML은 이 워크로드 직접 근거가 없고 반증 사례가 있다. launchd `KeepAlive`와 `EnablePressuredExit`는 동시에 쓸 수 없고 `TimeOut` 키는 무효라, 유휴 언로드는 앱이 직접 구현해야 한다.
- **라우팅 효과**: RouteLLM·FrugalGPT의 30–85% 절감은 비코딩 QA 기준이다. 2026 대규모 재평가(LLMRouterBench 등)에서는 다수 라우터가 단순 기준선을 넘지 못했다. 이득 조건은 난이도 분산이 큰 작업, 보정된 확신도 + 애매하면 상위 tier(abstain), 오분류 복구 비용이 낮을 것이다. 캐싱·effort 조절이 더 확실한 절감 수단이다.

- **학습 데이터 출처(공식 데이터 카드·README)**: `LocalLLaMA/typed-decisions`의 gold는 사람 라벨이 아니라 LLM teacher 출력이다(case당 temperature 0.7로 3회 샘플링한 분포의 평균, teacher 모델명 비공개). 영어만 있고 train 1,200행(약 3만 문항) / test 400행이며 Apache-2.0이다. 이 train 전체로 4 epoch fine-tune해 0.766을 냈고, 이는 teacher 자체 일치도 0.735보다 높다. 학습 시간은 공식 README 기준 2×T4 약 4–5시간이지만 학습 키트가 notebook 셀에서 옮긴 값은 약 4–6분이다. 둘이 충돌하므로 실제 실행 전까지 UNKNOWN이다. 한국어 fine-tune 사례는 확인되지 않았다. Kaggle 무료 GPU는 주당 약 30시간(가변), 세션당 12시간이다.

## 실측 기록

### B1. 기준선과 초기화 생략 (english, MPS, laya 0.3.4 / torch 2.14 / transformers 5.17, `scripts/laya-bench.py`)

입력: jev route 질문 3개(intent choice 7 / difficulty score 5 / risk choice 4), 영어 6 + 한국어 6 작업 문장. warm은 3회 예열 후 30회.

| 모드 | Agent 생성 | 프로세스 시작→첫 답 | 1질문 p50 | 3질문 p50 / p95 | MPS 텐서 | FP32 대비 |
|---|---:|---:|---:|---:|---:|---|
| fp32(현재) | 22.2s | 23.8s | 54.8ms | 121.8 / 150.7ms | 1,610MiB | 기준 |
| fp32 + 초기화 생략 | 1.9s | 3.5s | 58.0ms | 122.3 / 150.0ms | 1,610MiB | 36/36, 확률 차 0.0 |
| half(FP16 가중치) | 21.9s | 23.3s | 54.7ms | 115.2 / 147.4ms | 810MiB | 36/36, 최대 0.0074 |
| half + 초기화 생략 | 2.3s | 3.9s | 56.1ms | 118.0 / 149.7ms | 810MiB | 36/36, 최대 0.0074 |
| amp-fp16 / amp-bf16 | — | — | 62.6 / 61.3ms | 130.8 / 127.6ms | 1,610MiB(driver 3.1GiB) | 36/36 |

- 로드 24초 중 약 19초는 ModernBERT 가중치 무작위 초기화(`normal_`/`trunc_normal_`)였다. 이 값은 `load_state_dict(strict=True)`가 전부 덮어쓴다. transformers 공식 `no_init_weights()`로 건너뛰면 결과가 바뀌지 않는다(FP32 확률 차 0.0).
- 16비트는 속도 이득이 거의 없고(리서치와 일치) 메모리를 절반으로 줄인다. autocast는 더 느리고 메모리를 더 쓴다.
- zero-shot 품질(english, 합성 12문장): 영어 intent는 6/6이 그럴듯하다. 한국어 intent는 약하다(other 3건). difficulty는 운영 DB 교체·저장소 재설계를 1–2로 판단하는 등 약하다. 정답 라벨이 없는 관찰이며 정확도가 아니다.

### B2. checkpoint별 (MPS, 초기화 생략, 같은 입력)

| checkpoint | 파라미터 | 콜드 | 1질문 p50 | 3질문 p50 / p95 | MPS 텐서 fp32 → half |
|---|---:|---:|---:|---:|---:|
| english | 421M | 3.5–3.9s | 56–58ms | 118–122 / 150ms | 1,610 → 810MiB |
| multilingual | 322M | 3.7–4.2s | 23–24ms | 53 / 60–82ms | 1,236 → 631MiB |
| typed-decisions | 421M | 3.7–4.0s | 54–56ms | 116–120 / 142–146ms | 1,610 → 810MiB |

- multilingual은 english보다 약 2.2배 빠르다(공식 서술과 일치).
- 관찰(정답 라벨 없음): multilingual은 한국어 intent 12개 중 약 3개가 어긋나 보인다. multilingual·typed-decisions 모두 "운영 DB 비밀번호 교체"의 risk를 `safe`로 냈다. zero-shot risk 판단은 신뢰할 수 없으며, qualification 없이 ON에 쓰면 안 된다는 근거다.

### B3. 라벨 있는 개발 세트 평가 (`scripts/laya-eval-route.py`, `scripts/fixtures/route-dev-set.json`)

세트: 영어·한국어 쌍 24개씩(48). 라벨은 AI가 작성했고 사람 검토 전이다. checkpoint 비교용이며 자격 근거가 아니다. FP16(half + autocast) MPS.

| checkpoint | intent 영/한 | risk 영/한 | difficulty MAE | high→safe 오판 | 3질문 지연 p50 |
|---|---|---|---:|---:|---:|
| english | 0.75 / 0.33 | 0.38 / 0.21 | 1.07 | 3 | 128ms |
| multilingual | 0.58 / 0.25 | 0.33 / 0.08 | 1.22 | 5 | 53ms |
| typed-decisions | 0.71 / 0.38 | 0.54 / 0.58 | 1.05 | 8 | 123ms |

- intent 선택적 정확도(영어, english): 확신도 ≥0.7에서 13/24를 커버하고 그중 0.923이 맞다. ≥0.8에서는 10/24, 0.90.
- "multilingual 하나로 통일" 가설은 기각. 한국어에서도 english보다 못했다.
- 한국어 intent와 risk는 세 checkpoint 모두 zero-shot으로 쓸 수 없는 수준이다. difficulty는 평균 1단계 이상 어긋난다.
- MPS에서 `model.half()`만 적용하면 mixed-dtype matmul에서 Metal assert로 프로세스가 죽는다. fp16은 half 가중치 + 강제 autocast(fp16)가 검증된 조합이다.

### B5. 질문 문구 변형 (english·typed-decisions, FP16, 같은 개발 세트)

| checkpoint | 변형 | intent 영/한 | risk 영/한 | difficulty MAE 영/한 | high→safe 영/한 |
|---|---|---|---|---|---|
| english | jev 원문 | 0.75 / 0.33 | 0.38 / 0.21 | 1.03 / 1.11 | 3 / 0 |
| english | 작업 문장만 | 0.75 / 0.33 | 0.38 / 0.33 | 0.98 / 1.07 | 2 / 3 |
| english | 작업 문장만 + 짧은 선택지 | 0.75 / 0.29 | 0.50 / 0.58 | 0.96 / 1.16 | 4 / 3 |
| typed-decisions | jev 원문 | 0.71 / 0.38 | 0.54 / 0.58 | 1.01 / 1.09 | 4 / 4 |
| typed-decisions | 작업 문장만 | 0.75 / 0.33 | 0.33 / 0.25 | 0.99 / 1.11 | 0 / 0 |
| typed-decisions | 작업 문장만 + 짧은 선택지 | 0.79 / 0.21 | 0.58 / 0.50 | 1.01 / 1.23 | 2 / 1 |

- 문구를 바꿔도 한국어 intent·risk·difficulty의 한계는 그대로다. 변화 폭은 표본 24개의 잡음 수준이다. zero-shot 한계는 문구가 아니라 모델 능력 문제이며, 이 판단들에 쓰려면 사용자 작업 분포로 fine-tune이 필요하다.

### B6. 실적용 후 실제 경로 지연 (launchd 서버, english FP16 MPS, 2026-09-23)

- 실제 `claude -p` 세션, 맥락 표시 있는 implementer spawn 1건: hook이 서버로 판단(TypeSafe 호출 0), route 판단 607ms, pre-spawn hook 616ms, post-spawn `LINKED` 7.6ms, subagent-stop `RECORDED` 9.0ms.
- 소켓 직접 호출(판단 기록 없음): 연속 호출 p50 103ms. 쉬었다가 들어온 첫 호출은 2s 196ms, 5s 209ms, 10s 215ms, 30s 475ms, 60s 480ms.
- 같은 조건의 프로세스 내 비교(`scripts/laya-idle-bench.py`, 3질문): MPS FP16은 연속 107ms / 5s 후 198–205ms / 30–60s 후 419–481ms. CPU FP32는 연속 217–219ms / 5s 후 237–252ms / 30–60s 후 556–568ms. 쉬고 난 뒤의 느려짐은 GPU만의 현상이 아니며 CPU가 더 느리다. MPS FP16을 유지한다.
- keep-warm(주기적 더미 추론)은 spawn 간격(수 분)을 덮으려면 수십 회 추론이 필요해 에너지 대비 이득이 나쁘므로 넣지 않는다. 실제 hook 경로의 판단 지연은 드문 호출 기준 약 0.2–0.5초(+ Node 시작 약 50ms)이며, TypeSafe(약 0.65–0.73초 + API 비용)보다 빠르고 비용이 0이다.

### B7. 무손실 입력 예산 (`scripts/laya-budget.py`, route 질문 3개, worker assert_lossless와 같은 규칙)

| checkpoint | max_len / head | 영어 최대 | 한국어 최대 |
|---|---|---:|---:|
| english | 512 / 192 | 1,549자 | 296자(590B) |
| multilingual | 1024 / 256 | 2,512자 | 1,440자(2,976B) |
| typed-decisions | 1024 / 256 | 2,512자 | 697자(1,439B) |

- english는 한국어 토큰화 효율이 낮아 한국어 296자를 넘으면 `INPUT_TRUNCATED`로 판단하지 않는다. 실제 한국어 서브에이전트 프롬프트는 대부분 이보다 길어, english는 정확도(B3)뿐 아니라 용량 면에서도 owner 사용 패턴에 맞지 않는다.
- 결정: fine-tune 기반 모델은 multilingual(한국어 1,440자, 2.2배 빠름, FP16 631MiB). 증류 데이터 3,000개는 짧은 문장 2,000 + 실제 프롬프트형 긴 문장 1,000으로 구성한다(생성된 짧은 문장 중앙값 55자는 실제 입력 분포와 다름). hook의 판단 입력은 예산 안 앞부분으로 명시적으로 자르고 기록하는 방식을 추가한다(조용한 잘림 아님). 맞춤 모드는 `provenance.preprocessing_version`(`…-lossless-v1`/`…-task-head-v1`)으로, 요청별 잘림 여부는 provenance 밖 `inputFit`과 metrics `routeInputFitTruncated`로 남긴다(학습 decision 스키마는 provenance에 문자열 키만 허용하므로 객체를 넣으면 capture가 전부 실패한다 — 재현 테스트로 막음).
- **구현 완료 (2026-09-23):** `workers/laya_worker.py`의 `fit_task_head()`(opt-in, `providers.json` `laya.inputFit:'task-head'`, 기본 `'lossless'`는 기존 거부 동작 유지)가 예산을 넘는 route 입력에서 `state.task`만 최장 prefix + 고정 marker(`" …[truncated]"`)로 줄이고 최종 결과를 반드시 `assert_lossless()`로 재검증한다. `training/laya-kit/train_from_export.py`는 같은 함수를 byte-identical하게 복사해 train 전처리에도 identical하게 적용한다(`tests/test_laya_kit_input_fit.py`로 parity 검증). 상세: `docs/TRAINING_DATA.md` §7. 실측 overhead(M4 Pro, `scripts/laya-budget.py --fit --runs 20`, 2,500자 EN/KO): english EN kept 1,533자/median ≈15.4–16.7ms, english KO kept 294자/median ≈16.0–17.3ms, multilingual EN 이미 무손실/median ≈2.4–2.5ms, multilingual KO kept 1,467자/median ≈16.9–17.6ms — 목표(<15ms)에 근접하거나 근소하게(약 1–2ms) 초과했다(정확성 우선으로 마지막 결과는 항상 `assert_lossless()` 재검증을 거치므로 추가 최적화보다 정확성을 택함).

### B4. Codex A/B: spawn 전 명시 `jev_route` vs 바로 spawn (codex-cli 0.154.0, `codex exec`, 각 3회, 중앙값)

| | A: route 후 spawn | B: 바로 spawn | 차이 |
|---|---:|---:|---:|
| 입력 토큰 | 109,907 | 81,294 | +28,613 |
| 캐시 입력 | 88,704 | 60,800 | +27,904 |
| 캐시 안 된 입력 | 21,203 | 20,494 | +709 |
| 출력 토큰 | 227 | 66 | +161 |
| 시간 | 21.9s | 13.3s | +8.6s |

- 명시 route 호출은 spawn 1회당 약 8.6초와 메인 모델 추가 턴(캐시 입력 약 2.8만)을 더한다. 세션 컨텍스트가 클수록 추가 턴의 캐시 읽기도 커진다.
- 절감 근거는 없다(route 추천 0/1, zero-shot 품질 약함). 권장: Codex 관리 블록에서 route 호출 안내를 제거하고 hook 기록만 유지한다(owner 확인 후 적용).

## 단계

- [x] L0 기준선·리서치
- [x] L1 worker 최적화: `no_init_weights()` 로드, `precision: fp16`(half + 강제 autocast), identity·qualification을 precision에 묶음. 실제 가중치 e2e(english, MPS, jev 엔진 경유): fp32 콜드 3.8s / warm p50 149ms, fp16 콜드 2.7s / warm p50 144ms, intent·risk 22/22 일치, difficulty 최대 차 0.0089. 재현: `scripts/laya-e2e.mjs`.
- [x] laya 0.3.6 판단: 0.3.5·0.3.6 변경은 Router·다운로드·로망스어 라우팅 위주로 jev 경로(Agent 직접 사용)와 무관하다. 0.3.4 유지(재설치 불필요), 실제 이득은 로더·정밀도·상주 서빙에서 나온다.
- [x] L2 한국어 경로 평가: multilingual 통일 기각, 한국어는 zero-shot 불가 → fine-tune 필요 (B3)
- [x] L3 상주 서버: `jev-control laya serve`/`laya server-status`(`src/laya-server.mjs`, Unix 소켓 `JEV_HOME/run/laya.sock` 0600·`run/` 0700, 유휴 언로드 `laya.serverIdleUnloadMs`, `wait:false`면 준비 안 됐을 때 즉시 NOT_READY+백그라운드 로드), 엔진이 소켓 있으면 자동 사용(`layaSpawn`/`layaWait` 엔진 옵션), hook은 `layaSpawn:false,wait:false`로 항상 즉시 통과, MCP·CLI는 기본 `layaSpawn:true,wait:true`. launchd 설치기 `install/uninstall --laya-agent`(macOS 전용, dry-run 승인, plist에 JEV_HOME만). doctor `layaServer` 섹션. 실측(english, MPS, fp16, `scripts/laya-server-e2e.mjs`): 서버 콜드→ready 3.2s, status 왕복 0ms, hook p50/p95 서버 있음 184/321ms(실제 3질문 추론 포함) vs 서버 없음 52/58ms(즉시 통과), 유휴 언로드로 worker RSS 464MiB→0MiB, 언로드 후 재요청 재로드 3.9s, close() 후 소켓 파일 제거 확인. 테스트: `tests/laya-server.test.mjs`(13개), `tests/install-laya-agent.test.mjs`(8개), `tests/hooks.test.mjs`의 L3 케이스.
- [~] L4 품질: teacher 증류 + 사람 검수 경로
  - [x] 증류 파이프라인 `laya distill import|import-shadow|label|review|build|status` (7371af2): teacher 라벨은 train에만, 사람 검수는 calibration/test에만, `readDataset`이 teacher 라벨의 평가 split 유입을 `TEACHER_LABEL_IN_EVAL_SPLIT`로 거부
  - [x] 긴 입력 task-head 맞춤과 학습·추론 입력 일치, label 연속 5회 실패 중단·run 잠금 (30aeab4)
  - [x] 긴 문장 1차 생성분(haiku 워커 5개, 1,000개) 폐기: 기본 작업 약 10개를 "(케이스 N)"·"#N" 번호만 바꿔 반복하고 상투 문단으로 길이를 채움, 최대 약 850자. 재생성은 sonnet 워커 10개 × 100개, 직접 작성·템플릿 금지·길이 3구간·작업 유형 혼합·5-gram 유사도 검사 조건
  - [x] 긴 문장 재생성 1,000개(ko 500·en 500, 300~2,228자, 길이 3구간 170/170/160, 같은 언어 최대 5-gram 유사도 0.198, 번호 패턴 0). 길이 채우기로 생긴 문장 내 반복 56건은 구성 단계에서 제거
  - [x] 번역 쌍 발견: 긴 문장의 약 44%가 한국어·영어 번역 쌍. group 필드로 묶고 build가 검수된 group의 다른 멤버를 train에서 제외 (5afdc5b). 짧은 문장은 번역 쌍을 확실히 식별할 수 없어 `reviewable:false`로 train 보강에만 쓰고, 사람 검수 평가 세트는 실제 입력에 가까운 긴 문장에서만 뽑는다
  - [x] 3,000개 구성·import(run `d3k`): 짧은 2,000(도메인×언어 200씩, 가까운 중복 제외) + 긴 1,000, group 2,686개, 검수 대상 1,000, 민감정보·중복 제외 0
  - [x] teacher는 Jev 유지(owner 결정 2026-09-23). Claude teacher는 확률 분포를 직접 주지 않아 추가 샘플링 비용이 들고 우위가 측정되지 않아 보류
  - [x] 파일럿 20회(owner 승인): 20/20 성공, 모델 jev-1.13.0, 호출당 입력 짧은 869·긴 1,364(평균 1,093자) / 출력 124, 간격 중앙값 1.19s. 라벨 형태: intent 7범주 분산, difficulty 0~4 분산, 최대 확률 평균 0.67~0.81, risk는 safe 15/20으로 치우침
  - [x] 나머지 2,980회(owner 승인, 추정 입력 약 3.0M·출력 약 0.37M, 약 59분): 2,977 성공·3 실패(`MALFORMED_RESPONSE`, 자동 재시도 없음). 전체 라벨 2,997, 모델 jev-1.13.0 단일, 실측 입력 2,959,268·출력 372,719 토큰, 63.4분
    - 라벨 분포(긴 999): intent edit 383·explain 165·debug 161·architecture 147·research 97·other 32·operate 14 / difficulty(0~4) 3이 456으로 최다 / risk safe 676·caution 203·high 105·unknown 15. 짧은 1,998은 intent other 498, difficulty 2가 1,212로 몰림(짧은 문장은 정보가 적어 teacher도 판단을 유보)
    - teacher 일관성(번역 쌍 304쌍의 ko·en argmax 일치): intent 0.86, risk 0.83, difficulty 0.69. 같은 작업을 언어만 바꿨을 때도 difficulty는 약 3할이 갈리므로, difficulty는 teacher 라벨 자체의 잡음이 크고 soft target과 사람 검수가 특히 중요하다. 이 수치는 teacher 자기 일관성이지 정확도가 아니다
  - [x] owner TTY 검수 시작 후 중단: 선택지·영어 문장 판독이 어렵다는 owner 판단으로 평가 기준을 Claude 기준 라벨로 개정(위 결정 표)
  - [x] owner 추가 지시(2026-09-23): owner가 직접 하기로 한 일(검수·Kaggle 학습·승격·서버 재시작)을 Claude가 모두 수행. Kaggle 대신 로컬 M4 Pro MPS 학습(계정·자격증명 불필요, 추가 다운로드 없음)
  - [x] Claude 기준 라벨(Opus 워커, Jev 라벨 비공개): 평가 300(긴 문장, ko 150·en 150, group당 1개) + 학습 2,555(평가 group 형제 145개 제외). 값 오류 0
  - [x] Jev teacher vs Claude(평가 300): intent 0.847(ko 0.88·en 0.81), risk 0.677(ko 0.76·en 0.59), difficulty 0.377(±1 이내 0.82). 학습 2,552에서는 0.709/0.594/0.38. Jev는 risk를 덜 조심스럽게(safe→Claude caution 54건), intent에 architecture를 과하게 붙임. 목표가 Claude 수준이므로 **train 라벨도 Claude로 교체** (b0e809d)
  - [x] build(dataset 07988f22…): 전부 ai_reference, train 7,659 / calibration 423 / test 477 샘플, group 누수 제외 145, 예시 이메일 2건 제외(import·build 검사 통일, e988b85). export 검증 통과
  - [x] 학습 키트 결함 2건 발견·수정: gradient clipping이 첫 스텝 후 꺼지던 generator 버그(a474531), 24GB에서 batch 8 스왑(약 8.5초/step) → batch 4(약 0.8초/step)
  - [~] 로컬 학습(batch 4 × grad-accum 16, fp32, 4 epoch) → register(fp16·mps·task-head) → holdout freeze → qualify(Claude 일치율) → compare(english zero-shot 대비) → 조건 충족 시 promote·서버 재시작
- [x] L5 Codex A/B 실측(B4) 후 owner 승인으로 Codex 관리 블록에서 spawn 전 route 안내 제거, hook 기록만 유지
- [ ] L6 설치본 반영·문서·커밋
