# training/laya-kit -- Laya Kaggle T4x2 학습 준비 키트

이 폴더는 **학습을 실행하지 않는 준비물**이다. `jev-agent-control` 저장소는 온라인 학습이나
자동 fine-tuning/checkpoint 승격을 하지 않는다(`docs/TRAINING_DATA.md`). 실제 학습은 사람이
Kaggle(또는 동등한 2x NVIDIA T4 DDP 머신)에서 이 폴더를 업로드해 직접 실행해야 한다.

고정된 공식 자료:
- 저장소 커밋: `NandhaKishorM/laya@42626c348753fbb17572a813127df2278a1ec527`
- 노트북: `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb`
- 라이선스: 위 커밋의 `LICENSE`는 Apache-2.0. 같은 커밋에 별도 `NOTICE` 파일은 없음(트리 조회로 확인).
- `laya` 자체 버전: 같은 커밋의 `pyproject.toml`에 `version = "0.3.4"`로 명시.

## 파일 구성

| 파일 | 역할 |
|---|---|
| `check_export.py` | 학습 없이 export 폴더(`train/calibration/test.jsonl` + `manifest.json`)만 검사하는 표준 라이브러리 전용 스크립트 |
| `train_from_export.py` | 공식 notebook의 DDP 학습·평가 절차를 export 폴더 입력으로 옮긴 스크립트. Kaggle T4x2에서 사람이 실행 |
| `requirements.lock` | notebook이 설치하는 패키지 목록과, 검증 가능한 범위의 버전 고정 |
| `NOTICE` | 업스트림 Apache-2.0 고지 |

## 전체 흐름

```
jev-control dataset export --version <hash> --format laya
        │  (exports/<hash>/laya/{train,calibration,test}.jsonl + manifest.json)
        ▼
   check_export.py --export-dir exports/<hash>/laya   ← 로컬, 학습 없음
        │  (통과 시에만 다음 단계)
        ▼
   Kaggle Notebook(GPU T4 x2, Internet On)에 export 폴더 업로드
        │
        ▼
   train_from_export.py --export-dir <업로드된 export 경로> \
       --output-dir /kaggle/working/laya_finetuned_typed_decisions
        │  (torchrun --nproc_per_node=2 DDP 학습 + calibration + 평가)
        ▼
   checkpoint(model.safetensors, encoder/, tokenizer/, rl_agent_config.json,
              training_metadata.json) 다운로드
        │
        ▼
   jev-control laya register   ← checkpoint를 providers.json에 등록(운영자)
        ▼
   jev-control holdout freeze  ← 고정 holdout 동결(운영자)
        ▼
   jev-control ... qualify     ← qualification 생성
        ▼
   jev-control ... compare     ← 기존 active checkpoint 대비 shadow 비교
        ▼
   jev-control ... promote     ← **owner 명시 승인 후에만** 실행
```

`jev-control laya register`/`holdout freeze`/`qualify`/`compare`/`promote`의 정확한
서브커맨드 인자는 이 kit이 만들어진 시점의 CLI 구현을 따른다 -- 이 README는 순서만
보장하고, 각 명령의 플래그는 `jev-control --help`로 그때그때 확인한다(임의로 추측해
적지 않음).

## 실행 순서(사람이 직접)

1. **export 검증(로컬, GPU 불필요)**
   ```sh
   python3 training/laya-kit/check_export.py --export-dir exports/<hash>/laya
   ```
   실패하면 다음 단계로 넘어가지 않는다.

2. **Kaggle Notebook 설정**
   - Notebook options → Accelerator: `GPU T4 x2`
   - Notebook options → Internet: `On` (모델/패키지 다운로드에 필요)
   - `training/laya-kit/` 전체와 `exports/<hash>/laya/` 폴더를 Kaggle Notebook의
     Input/Working 디렉터리에 업로드한다.

3. **의존성 설치** (Kaggle Notebook 셀에서, 로컬에서 하지 않음)
   ```sh
   pip install -q -U laya==0.3.4 transformers datasets safetensors huggingface_hub pyarrow pandas scipy accelerate tabulate
   ```
   버전 미고정 패키지는 `requirements.lock`에 "확인 불가"로 표시된 이유를 참고.

4. **학습 실행**
   ```sh
   python3 training/laya-kit/train_from_export.py \
       --export-dir /kaggle/input/<업로드한-export>/laya \
       --output-dir /kaggle/working/laya_finetuned_typed_decisions
   ```
   - export manifest의 `exporter_version`/`upstream_contract`/`loader`/`source_data_sha256`가
     이 스크립트가 기대하는 값과 다르면 학습 전에 중단한다.
   - tokenizer admission(잘림) 검사가 먼저 실행되며, 잘리는 행 비율이
     `--max-truncated-fraction`(기본 2%)을 넘으면 중단한다. 강제로 진행하려면
     `--allow-truncation`.
   - 매니페스트/토크나이저 검사만 먼저 확인하고 싶으면 `--dry-run`(torchrun을 실행하지
     않음).

5. **산출물 다운로드**
   `output-dir` 아래 `model.safetensors`, `encoder/`, `tokenizer/`,
   `rl_agent_config.json`, `benchmark_report.json`(평가 성공 시), 그리고
   `training_metadata.json`(notebook 커밋, laya 버전, export 해시, 하이퍼파라미터,
   시작·종료 시각)을 로컬로 내려받는다.

6. **checkpoint 등록 → holdout 동결 → qualify → compare → promote**
   `docs/TRAINING_DATA.md`가 규정한 순서를 그대로 따른다. **promote는 owner의 명시 승인
   없이 실행하지 않는다.** 자동 승격은 이 저장소에 구현돼 있지 않다.

## 예상 시간 (출처 표시)

- 공식 notebook 셀 9의 마크다운은 `torchrun` DDP 학습 단계(cell 10)만을 두고
  "~4 to 6 minutes total"이라고 명시한다 — **분 단위**다. 이 kit의 학습 코드는 그
  루프를 그대로 옮겼으므로 학습 루프 자체의 소요 시간은 같은 자릿수로 예상된다.
- 노트북 전체(패키지 설치, 모델/데이터 다운로드, 전처리, 평가, 산출물 저장 포함)의
  총 소요 시간은 공식 문서에 별도로 명시돼 있지 않다 — **확인 불가**로 남긴다. Kaggle
  무료 세션은 GPU 세션당 시간 제한(계정/시점별로 바뀔 수 있음)이 있으므로 실행 전
  Kaggle 계정의 현재 할당량을 직접 확인한다.
- Kaggle 무료 GPU 할당량 자체(주당 시간, T4x2 세션 한도)는 Kaggle 정책이며 이 저장소
  문서로 확정할 수 없다 — **확인 불가**, 실행 전 Kaggle 콘솔에서 재확인 필요.
- 비용: Kaggle 무료 GPU 티어를 그대로 쓰면 추가 비용은 없다. Kaggle Pro/추가 컴퓨팅
  구매 여부는 사용자 계정 정책이며 이 kit이 강제하지 않는다.

## Mac에서 로컬로 돌릴 수 있는가 (MPS)

- 공식 절차는 `torch.distributed` NCCL 백엔드와 `torchrun --nproc_per_node=2`로 **CUDA
  DDP 전용**이다. NCCL은 NVIDIA GPU 간 통신 전용이므로 Apple Silicon의 MPS 장치에서는
  이 경로가 그대로 동작하지 않는다.
- 이번 작업에서 Mac MPS 단일 장치로 축소한 학습 spike는 수행하지 않았다. MPS 단일
  장치에서 RLCD+GRPO 루프가 동작하는지, 어느 정도 시간이 걸리는지는 **UNKNOWN**이며,
  이 kit의 no-go 판정 근거로 쓸 수 없다. MPS 경로가 필요하면 별도 작업으로 실제
  spike를 먼저 돌려야 한다.
- `docs/TRAINING_DATA.md`의 `providers.json` 예시에 `"device": "mps"`가 있는 것은
  **추론(inference) 시점**의 로컬 Laya worker 장치 설정이며, 이 학습 kit의 DDP
  학습 절차와는 별개다. 혼동하지 않는다.

## 반복 fine-tune의 망각(catastrophic forgetting) 위험과 holdout 게이트

- 매 fine-tune은 이전 checkpoint의 가중치를 덮어쓰는 새 학습이다. 새 export로 반복
  학습을 돌리면 이전에 잘 맞던 purpose/workflow에서 품질이 조용히 나빠질 수 있다
  (catastrophic forgetting) — 학습 손실이나 새 데이터셋의 accuracy만 보고는 감지할 수
  없다.
- 이 위험 때문에 `docs/TRAINING_DATA.md`는 checkpoint 교체를 **명시적 `laya promote`**
  하나로만 허용하고, 그 전에 반드시 **고정 holdout(freeze)** 대비 무회귀(non-regression)
  검증과 활성 checkpoint 대비 shadow 비교를 요구한다. 이 kit이 만드는
  `benchmark_report.json`/`training_metadata.json`은 그 검증에 쓰일 원자료일 뿐,
  그 자체로 품질 보증이 아니다.
- holdout은 학습 때마다 새로 뽑지 않고 고정해야 새 checkpoint가 "이전에 풀던 문제를
  못 풀게 됐는지"를 일관되게 비교할 수 있다. holdout을 매번 새로 만들면 이 비교 자체가
  무의미해진다.

## 데이터 권리·라이선스 검토 항목 (promote 전 owner 확인 필요)

- [ ] 업스트림 `laya` 런타임/모델: Apache-2.0 (위 NOTICE 참고). 상업적 사용/재배포
      조건 재확인.
- [ ] `LocalLLaMA/typed-decisions` 벤치마크 자체는 이 kit이 사용하지 않는다(공식
      notebook의 데이터 소스는 export 폴더로 대체됐다) — 다만 그 벤치마크의 데이터
      권리는 이 kit과 무관하게 별도로 검토해야 할 수 있다(예: 평가 방법론 재현 시).
- [ ] jev가 수집한 학습 데이터(decision/outcome/label)에 대해, 그 데이터를 만든 실제
      실행/annotation 주체(운영자 본인, 팀원, 특정 runner)로부터 fine-tuning 목적 이용에
      대한 동의·권리가 있는가.
- [ ] teacher 역할을 한 provider(예: TypeSafe Jev API)의 출력(probabilities, 라벨)을
      다른 모델(Laya) fine-tuning에 이용하는 것이 해당 provider의 이용 약관에
      위배되지 않는가 — 확인 불가 항목이면 promote 전에 반드시 확인.
- [ ] export에 개인정보·민감정보가 없는지 사람이 재검토했는가(`docs/TRAINING_DATA.md`의
      패턴 검사는 완전한 DLP가 아니다).

## 이 kit이 하지 않는 것

- 실제 모델 다운로드, pip 설치, GPU 학습, checkpoint 등록/승격을 대신 실행하지 않는다.
- Hugging Face Hub에 checkpoint를 공개 업로드하는 공식 notebook의 8번째 셀(선택 사항)은
  이 kit에 포함하지 않았다 — jev의 checkpoint 승격 경로는 로컬 `laya register`이지 공개
  Hub 배포가 아니기 때문이다. 필요하면 공식 notebook의 해당 셀을 별도로 참고한다.
