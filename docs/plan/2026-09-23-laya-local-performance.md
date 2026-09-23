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

## 단계

- [x] L0 기준선·리서치
- [ ] L1 worker 최적화: 초기화 생략(검증된 동일성), 16비트 옵션, laya 0.3.6 호환성 검증
- [ ] L2 한국어 경로: 입력 언어로 english/multilingual 선택, 각 checkpoint 벤치마크
- [ ] L3 상주 서버: `jev-control laya serve`(Unix 소켓, 유휴 언로드, 준비 안 됐으면 즉시 NOT_READY), hook·MCP가 서버를 사용, launchd 설치기(dry-run·승인)
- [ ] L4 품질: 라벨 있는 평가 세트로 checkpoint·Jev 비교, qualification 경로(사람 라벨 필요)
- [ ] L5 Codex 블록 축소 + A/B 실측
- [ ] L6 설치본 반영·문서·커밋
