# Laya 로컬 성능·에이전트 효율 계획 (2026-09-23)

owner 요청: 이 Mac(Apple M4 Pro, GPU 16코어, 통합 메모리 24GB)에서 Laya가 온전한 성능을 내도록 다시 설치하고, Codex·Claude 사용 시 속도·비용 측면에서 실제로 효율적이게 만든다. 공개 리서치와 로컬 실측을 병행하고 저장소를 계속 갱신한다.

## owner 결정 (2026-09-23)

| 결정 | 내용 |
|---|---|
| 상주 서버 | 로그인 시 자동 시작(사용자 launchd 에이전트) + JEV_HOME 안 Unix 소켓(0600, 네트워크 포트 없음). 일정 시간 쓰지 않으면 모델을 내려 메모리 반환. 서버가 없거나 모델이 내려가 있으면 hook은 기다리지 않고 즉시 통과. 설치·제거는 dry-run 후 승인. 기존 계약("공유 daemon 없음")을 이 결정으로 개정한다. |
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
- [ ] L3 상주 서버: `jev-control laya serve`(Unix 소켓, 유휴 언로드, 준비 안 됐으면 즉시 NOT_READY), hook·MCP가 서버를 사용, launchd 설치기(dry-run·승인)
- [ ] L4 품질: 라벨 있는 평가 세트로 checkpoint·Jev 비교, qualification 경로(사람 라벨 필요)
- [~] L5 Codex A/B 실측 완료(B4), 블록 변경은 owner 확인 대기
- [ ] L6 설치본 반영·문서·커밋
