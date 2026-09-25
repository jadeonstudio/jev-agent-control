# training/laya-kit -- Laya Kaggle T4x2 학습 준비 키트

`jev-agent-control` 저장소는 온라인 학습이나 자동 fine-tuning/checkpoint 승격을 하지
않는다(`docs/TRAINING_DATA.md`). 공식 2xT4 DDP 경로(`train_from_export.py`, torchrun+NCCL)는
사람이 Kaggle(또는 동등한 2x NVIDIA T4 DDP 머신)에 이 폴더를 업로드해 직접 실행해야 하는
**준비물**이다. `--local` 플래그(§ "Mac에서 로컬로 돌릴 수 있는가")를 쓰면 같은 스크립트가
Apple Silicon MPS(또는 CPU)에서 torchrun/NCCL/DDP 없이 단일 프로세스로 **실제로 학습을
실행**한다 -- 이 경우도 checkpoint 등록(`laya register`)·promote는 여전히 사람이 명시
승인한다.

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

## 실행 순서(사람이 직접) -- multilingual checkpoint 기준 전체 러너북

owner 결정(2026-09-23): fine-tune 기준 checkpoint는 **multilingual**(mmBERT, `max_len=1024`
/ `head_max_len=256`)이다. HF 저장소 `convaiinnovations/laya`는 체크포인트별로 서브폴더가
나뉘어 있다 -- 로컬 `~/.local/share/laya/models/multilingual/.cache/huggingface/download/`
아래 파일 경로가 전부 `multilingual/`로 시작하는 것으로 로컬에서 직접 확인했다(반면 english
체크포인트의 같은 경로는 서브폴더 없이 루트에 바로 있다). 이 kit이 HF 저장소 파일 트리를
직접 열람할 수는 없었으므로, 서브폴더 이름은 아래처럼 `--model-subdir`로 사람이 명시한다.

0. **(로컬) 증류 데이터셋 빌드**
   ```sh
   jev-control laya distill build --run d3k
   jev-control dataset export --version <hash> --format laya
   ```
   `<hash>`는 `laya distill build`가 출력하는 `dataset_version`이다. 정확한 서브커맨드 인자는
   이 kit이 만들어진 시점의 CLI 구현을 따르며(§ 상단 안내), 최신 플래그는
   `jev-control training --help`(`TRAINING_HELP`, `src/training/cli.mjs`)로 그때그때 확인한다.

1. **export 검증(로컬, GPU 불필요)**
   ```sh
   python3 training/laya-kit/check_export.py --export-dir exports/<hash>/laya
   ```
   실패하면 다음 단계로 넘어가지 않는다.

2. **Kaggle Notebook 설정**
   - Kaggle → Datasets → New Dataset: `exports/<hash>/laya/` 폴더 전체를 업로드해 **private**
     Kaggle Dataset을 만든다(비공개로 유지; 공개 전환하지 않는다).
   - Notebook options → Accelerator: `GPU T4 x2`
   - Notebook options → Internet: `On` (모델/패키지 다운로드에 필요)
   - `training/laya-kit/` 전체와 방금 만든 private Dataset을 Kaggle Notebook의
     Input/Working 디렉터리에 연결(Add Input)한다.

3. **의존성 설치** (Kaggle Notebook 셀에서, 로컬에서 하지 않음)
   ```sh
   pip install -q -U laya==0.3.4 transformers datasets safetensors huggingface_hub pyarrow pandas scipy accelerate tabulate
   ```
   버전 미고정 패키지는 `requirements.lock`에 "확인 불가"로 표시된 이유를 참고.

4. **모델 다운로드 + 학습 실행**
   ```sh
   python3 -c "from huggingface_hub import snapshot_download; print(snapshot_download('convaiinnovations/laya'))"
   python3 training/laya-kit/train_from_export.py \
       --export-dir /kaggle/input/<업로드한-export>/laya \
       --model-dir <위에서 출력된 snapshot 경로> \
       --model-subdir multilingual \
       --output-dir /kaggle/working/laya_finetuned_multilingual
   ```
   - `--model-dir`을 생략하면 스크립트가 직접 `snapshot_download("convaiinnovations/laya")`를
     호출한다(네트워크, Kaggle에서만). `--model-subdir multilingual`은 그 snapshot 루트 아래
     `multilingual/` 서브폴더를 실제 checkpoint 디렉터리로 쓴다 -- 이 서브폴더에
     `rl_agent_config.json`/`tokenizer/`/`encoder/`가 없으면 학습 시작 전에 분명한 에러로
     중단한다(`validate_resolved_model_dir`). english 체크포인트처럼 서브폴더 없이 루트에
     바로 있는 경우는 `--model-subdir`을 생략한다(기존 동작 그대로 유지).
   - export manifest의 `exporter_version`/`upstream_contract`/`loader`/`source_data_sha256`가
     이 스크립트가 기대하는 값과 다르면 학습 전에 중단한다.
   - 각 row를 전처리하기 전, `workers/laya_worker.py`에서 byte-identical하게 복사한
     `fit_task_head()`가 그 row의 `state.task`만 최장 prefix + `" …[truncated]"` marker로
     줄여(다른 state 키·질문은 그대로) 실제 추론이 `laya.inputFit:'task-head'`로 받는 입력과
     동일한 형태를 train에도 준다. 로그의 `[input-fit] N states task-head truncated`가 잘린
     state 수다. 자세한 내용은 `docs/TRAINING_DATA.md` §7.
   - base checkpoint 자신의 `rl_agent_config.json`이 `max_len`/`head_max_len`을 학습 시
     최종값(1024/256, official notebook cell 4의 override)과 다르게 갖고 있어도(예: english
     체크포인트는 512/192), 전처리(`fit_task_head`/`build_training_item`)는 항상 학습이 실제로
     쓰는 최종값을 기준으로 admission을 판단한다(`resolve_effective_cfg`) -- multilingual/
     typed-decisions 체크포인트는 애초에 1024/256이라 이 보정이 값을 바꾸지 않는다.
   - tokenizer admission(잘림) 검사가 먼저 실행되며, 잘리는 행 비율이
     `--max-truncated-fraction`(기본 2%)을 넘으면 중단한다. 강제로 진행하려면
     `--allow-truncation`. (이 검사는 `fit_task_head`가 손대지 못하는 나머지 truncation —
     질문/옵션이 너무 크거나 fit할 prefix가 전혀 없는 행 — 을 여전히 잡아낸다.)
   - 매니페스트/토크나이저 검사만 먼저 확인하고 싶으면 `--dry-run`(torchrun을 실행하지
     않음). 로컬에서는 `datasets` 패키지가 없어 이 확인조차 통과하지 못한다(로컬 laya
     `.venv`는 추론 전용 -- `pip list`로 실측 확인함); Kaggle의 `pip install`(3단계) 이후에만
     의미가 있다.
   - 스크립트는 내부적으로 다음 형태의 `torchrun`을 직접 실행한다(사람이 직접 칠 필요는
     없음 -- 디버깅 시 참고용):
     ```sh
     torchrun --standalone --nproc_per_node=2 <output-dir>/train_ddp.py \
         <resolved-model-dir> <output-dir> <output-dir>/train_items.pt <output-dir>/calib_items.pt \
         <derived-model-name> <base-model-dir-name> <export-manifest의-exporter_version>
     ```
     `<derived-model-name>`은 저장되는 checkpoint의 `model_name`으로, base checkpoint 자신의
     `rl_agent_config.json.model_name`(없으면 `--model-subdir` 또는 모델 폴더 이름)에
     `-jev-ft`를 붙여 만든다(`derive_model_name`) -- 예: multilingual의 base `model_name`이
     `"rl-agent"`이면 `"rl-agent-jev-ft"`. 과거처럼 `"laya-typed-decisions"`로 고정되지
     않는다.
   - **예상 소요 시간**: 공식 notebook 셀 9는 `torchrun` 학습 루프(cell 10)만을 두고
     "~4 to 6 minutes total"이라 명시한다(분 단위). notebook 전체(설치·다운로드·전처리·평가
     포함)의 총 GPU-시간은 공식 문서에 없다 -- **확인 불가**로 남긴다. 실행 전 Kaggle 계정의
     현재 GPU 할당량을 직접 확인한다.

5. **산출물 다운로드**
   `output-dir` 아래 `model.safetensors`, `encoder/`, `tokenizer/`,
   `rl_agent_config.json`(이제 `model_name`/`base_model_dir_name`/`exporter_version`을
   함께 기록), `benchmark_report.json`(평가 성공 시), 그리고 `training_metadata.json`
   (notebook 커밋, laya 버전, export 해시, `base_model_dir_name`, `derived_model_name`,
   하이퍼파라미터, 시작·종료 시각)을 로컬로 내려받는다.

6. **(로컬) checkpoint 등록 → holdout 동결 → qualify → compare → promote**
   정확한 서브커맨드 플래그는 `src/training/cli.mjs`의 `TRAINING_HELP`(`jev-control training
   --help`로도 확인 가능)를 그대로 옮긴 것이다. 임의로 지어내지 않는다.
   ```sh
   jev-control laya register --checkpoint <다운로드한-절대경로> \
       --python /Users/jangjiyong/.local/share/laya/.venv/bin/python \
       --device mps --precision fp16 --input-fit task-head
   jev-control laya holdout freeze --dataset <hash>
   jev-control laya qualify --candidate <candidate-hash> --dataset <hash> --holdout <holdout-id>
   jev-control laya compare --candidate <candidate-hash> --holdout <holdout-id>
   jev-control laya promote --candidate <candidate-hash> --holdout <holdout-id>
   ```
   **promote는 owner의 명시 승인 없이 실행하지 않는다.** 자동 승격은 이 저장소에 구현돼
   있지 않다.
   - `laya register`에 `--model NAME`을 주지 않으면 이름은 `laya/<checkpoint 해시 앞 12자>`가
     된다(`src/training/laya-lifecycle.mjs` `registerCheckpoint`). 저장된
     `rl_agent_config.json.model_name`(derive_model_name이 만든 값)은 checkpoint 안의 기록일 뿐
     등록 이름으로 쓰이지 않는다.
   - **resident server 재시작은 필요 없다.** `src/inference.mjs`의 `createLayaClient().start()`
     는 매 infer 호출마다 providers.json의 laya 블록 해시(`digest(l)`)를 이전 child의
     identity와 비교하고, `promote`로 checkpoint가 바뀌면 자동으로 이전 worker를 내리고
     (`LAYA_CONFIG_CHANGED`) 새 checkpoint로 재기동한다(`src/laya-server.mjs`의
     `handleInfer`/`handlePrepare`도 요청마다 providers.json을 새로 읽는다) -- 코드로 직접
     확인함. 단 이 자동 반영은 **상주 서버 프로세스가 `inputFit`을 아는 코드(30aeab4 이후)로
     떠 있을 때만** 성립한다. 그 이전에 시작된 서버는 worker에 `inputFit`을 보내지 않아
     task-head가 적용되지 않으므로, 처음 task-head checkpoint를 쓸 때는 한 번 재시작한다.
     그 뒤로는 선택 사항이다:
     ```sh
     launchctl kickstart -k gui/$(id -u)/com.jev-agent-control.laya
     ```

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

## Mac에서 로컬로 돌릴 수 있는가 (MPS) -- `--local` 모드 (2026-09-23 구현·실측)

- 공식 절차는 `torch.distributed` NCCL 백엔드와 `torchrun --nproc_per_node=2`로 **CUDA
  DDP 전용**이다. NCCL은 NVIDIA GPU 간 통신 전용이므로 Apple Silicon의 MPS 장치에서는
  이 경로가 그대로 동작하지 않는다.
- `train_from_export.py --local`이 이 문제를 우회한다: `torchrun`/NCCL/DDP 없이 단일
  프로세스로 **동일한** loss(RLCD+GRPO)·optimizer(AdamW, encoder/head 분리 LR)·cosine LR
  schedule·epochs(기본 4, `--local`에서만 `--epochs`로 변경 가능 -- 아래 절)·per-device batch size·seed를 재사용한다(`TRAIN_DDP_SCRIPT` 내부를
  `run_training_loop()`/`finalize_and_save()`로 리팩터해 DDP 경로(`main_ddp`, 그대로
  유지)와 로컬 경로(`main_local`, world_size=1/rank=0)가 같은 함수를 호출). `datasets`
  패키지 없이(로컬 laya venv에는 미설치) 표준 라이브러리 `json`만으로 export의
  train/calibration/test.jsonl을 읽는다(`load_jsonl_rows`).
- **실행 예시** (multilingual base checkpoint, 이 저장소 기준):
  ```sh
  /Users/jangjiyong/.local/share/laya/.venv/bin/python training/laya-kit/train_from_export.py \
      --export-dir exports/<hash>/laya \
      --model-dir /Users/jangjiyong/.local/share/laya/models/multilingual/multilingual \
      --output-dir <출력-디렉터리> \
      --local --device mps
  ```
  - `--device mps|cpu` (기본 mps), `--grad-accum N`(기본: DDP 레시피의 effective global
    batch를 그대로 유지하도록 `--batch-size`로부터 자동 계산 -- 기본 batch-size 8일 때
    grad-accum 8, 즉 8*8=64로 DDP의 8*4*2=64와 동일), `--batch-size N`(기본 8, OOM 시
    줄이면 grad-accum이 비례해 자동으로 커져 effective batch를 유지), `--mps-autocast
    bf16|off`(기본 off -- MPS fp16 autocast는 학습에 불안정하다고 실측됨(§ B3), bf16은
    opt-in), `--max-steps N`(smoke 검증 전용, 지정한 micro-step 수만큼만 돌고 멈춤).
  - `fit_task_head()`/`resolve_effective_cfg()`(입력 예산 맞춤·admission 기준)는 DDP
    경로와 완전히 동일하게 적용된다(분기 없음).
  - 메모리 안전: epoch마다 `torch.mps.driver_allocated_memory()`를 로그(`[mem] epoch N
    mps_driver_allocated_mib=...`, MPS에 진짜 peak 카운터가 없어 best-effort 근사치).
    OOM이 나면(`RuntimeError`에 "out of memory") 학습을 멈추고 `--batch-size`를 반으로
    줄이고 `--grad-accum`을 비례해서 늘리라는 구체적 메시지를 낸다.
  - 산출물: `model.safetensors`(fp16, notebook과 동일 -- best-epoch 선택이 켜져 있으면
    선택된 epoch의 가중치), `encoder/`, `tokenizer/`, `rl_agent_config.json`(model_name/
    base_model_dir_name/exporter_version 포함, DDP와 동일 레이아웃), `training_metadata.json`
    (`mode:"local"`, `device`, 하이퍼파라미터에 실제 micro_batch/grad_accum/
    select_best_epoch 포함, `local_run`에 device/grad_accum/epochs_completed/wall_time_s,
    `epoch_selection`/`selected_epoch`는 아래 절 참고), 그리고 로컬 전용
    `local_training_run.json`.
- **Smoke 실측 (2026-09-23, M4 Pro, multilingual base, 합성 export 12/6/6행, `--local
  --device mps`)**: 합성 데이터로 12개 train 행 × 질문 3개 = 36 학습 시퀀스.
  `--max-steps 20`(micro-batch 20개, batch-size 8/grad-accum 8) 기준 총 11.953초 →
  약 **0.60초/micro-step**(첫 step은 MPS 커널 컴파일로 약 1.8초까지 느려짐 -- 정상
  구간은 이후). 체크포인트는 `laya.agent.Agent(output_dir, device='mps')`로 즉시
  로드돼 route 형태 질문(`intent` choice)에 정상 응답했다(`predict()` 0.64초).
  `check_tokenizer_admission`도 정상 통과(0/54 truncated).
- **실제 규모 실측 (2026-09-23, M4 Pro 24GB, multilingual base, 실제 증류 데이터 train 7,659행, 최대 1,024토큰)**:
  - `--batch-size 8`(기본): 활성값이 커서 여유 메모리가 21%까지 떨어지고 스왑(약 18GB)이
    일어나 **약 8.5초/micro-step**(4 epoch 약 9시간 투영). smoke의 0.60초는 짧은 합성 행이라
    이 메모리 병목을 드러내지 못했다(MPS 통합 메모리는 프로세스 RSS에 잡히지 않는다).
  - `--batch-size 4`(grad-accum 16, 유효 배치 64 동일): **약 0.72~0.88초/micro-step**,
    1 epoch 1,915 step 약 26분, 4 epoch 약 1시간 45분(투영). **24GB 기기에서는 batch-size 4를 권장한다.**
  - 스왑 사용량은 `sysctl vm.swapusage`로, 속도는 로그의 50 step 간격 시각으로 확인한다.
- **예상 소요 시간 (owner 목표 규모, 투영치 -- 위 실측으로 대체됨)**: owner 계획(`docs/plan/2026-09-23-laya-local-performance.md`)의
  실제 데이터 규모는 작업 문장 약 3,000개 × 질문 3개 = **약 9,000개 학습 시퀀스**(잘림
  없다고 가정, smoke에서 실측 잘림률 0%와 일치). 공식 epochs=4, batch-size=8 기준
  micro-batch 수 = `ceil(9000/8) * 4 = 4,500`. smoke에서 잰 정상 구간 0.60초/step을 그대로
  곱하면 `4,500 * 0.60s ≈ 2,700초 ≈ 45분`(**학습 루프만의 투영치** -- 모델 로드
  ~26초, calibration 온도 피팅, test 평가(케이스당 약 0.6초)는 별도로 더해야 하며, 실제
  9,000개 시퀀스에서의 MPS 스로틀링·열 관리 영향은 관측하지 않았으므로 실제 값과 다를 수
  있다). 공식 notebook의 "~4 to 6 minutes"(2×T4 DDP, world_size=2)와 비교하면 로컬 단일
  MPS 프로세스가 약 7~11배 더 걸리는 셈이나, 비용은 0이고 Kaggle GPU 할당량 소모도 없다.
- `docs/TRAINING_DATA.md`의 `providers.json` 예시에 `"device": "mps"`가 있는 것은
  **추론(inference) 시점**의 로컬 Laya worker 장치 설정이며, 이 학습 kit의 `--local`
  학습 경로와는 별개다(다만 같은 물리 장치를 쓴다). 혼동하지 않는다.

## Epoch별 최적 checkpoint 선택 (`--select-best-epoch`, 기본 ON, 2026-09-23 구현)

- **문제(실측)**: 2026-09-23 M4 Pro 실측 학습(multilingual base, 실제 증류 데이터 train
  7,659행, 4 epoch, batch 4 × grad-accum 16)이 마지막 epoch에서 심하게 과적합했다 --
  train argmax agreement(intent/difficulty/risk) ≈ 0.99/0.92/0.95인데 held-out
  test ≈ 0.72/0.58/0.60. 항상 마지막 epoch의 가중치만 저장하는 기존 동작은 최적이
  아닌 checkpoint를 승격 후보로 넘길 위험이 있다.
- **동작**: `train_from_export.py`가 매 epoch 끝(DDP/`--local` 공통, `run_training_loop()`의
  `epoch_end_fn` 콜백)에 모델을 eval 모드로 두고 `calib_items.pt`(`finalize_and_save()`가
  온도 피팅에 쓰는 것과 동일한, export의 실제 held-out `calibration.jsonl`)에 대해
  질문 유형별(choice/score/noul) argmax 일치율(`compute_calib_agreement()`)을 계산해
  `[select] epoch N calib_agreement choice=.. score=.. noul=.. mean=..`으로 로그한다.
  세 유형 평균(`mean`)이 이전 최고보다 개선되면 그 epoch의 state_dict를 CPU에 복사해
  들고 있는다(322M 파라미터 fp32 약 1.3GB, 학습 끝나면 로드 후 바로 해제). 학습 종료 후
  최고 epoch의 state_dict를 모델에 로드하고 나서 `finalize_and_save()`(온도 피팅 + 저장)를
  실행한다 -- 즉 저장되는 checkpoint는 항상 "가장 나은 calibration-agreement를 낸 epoch"이다.
  DDP에서는 rank 0만 평가하고, 매 epoch 끝에 전체 rank가 barrier로 동기화된다.
- **플래그**: `--select-best-epoch`(기본 ON)/`--no-select-best-epoch`(기존처럼 항상
  마지막 epoch 유지). `--local`/DDP 양쪽 모두 지원(`load_common_argv()`의 공유 argv
  슬롯으로 두 경로에 동일하게 전달).
- **메타데이터**: `<output-dir>/epoch_selection.json`(`select_best_epoch`,
  `selected_epoch`, epoch별 agreement 표 `epoch_agreements`)을 학습 스크립트가 쓰고,
  바깥쪽 `train_from_export.py`의 `main()`이 이를 읽어 `training_metadata.json`의
  `epoch_selection`/`selected_epoch` 필드로 접는다.
- **검증**: `tests/test_laya_kit_eval_and_epoch_select.py`의
  `ComputeCalibAgreement`(순수 집계 로직)와 `TrainDdpScriptEpochSelectionStructure`
  (임베딩된 `TRAIN_DDP_SCRIPT` 안의 `epoch_end_fn`/best-state 로직에 대한 정적 검사 +
  outer 모듈과의 parity)가 커버한다. 2026-09-23 M4 Pro `--local --max-steps` smoke에서
  `[select] epoch 1 calib_agreement choice=... score=... noul=... mean=...` 로그와
  `epoch_selection.json`/`training_metadata.json`의 `selected_epoch` 기록을 실측 확인했다.

## 과적합 완화용 정규화 플래그 (`--dropout`, `--rdrop-alpha`, 기본 OFF, `--local` 전용, 2026-09-24)

- **배경**: 2차 학습에서 train subset agreement 0.98/0.92/0.94 대 held-out 0.81/0.64/0.59로
  과적합이 컸다. multilingual base의 `encoder/config.json`은 attention/embedding/mlp
  dropout이 모두 0.0이라 encoder는 dropout 없이 학습된다(참고: `DecisionModel`의 2층 head는
  laya 코드에 하드코딩된 `nn.TransformerEncoderLayer` dropout 0.1을 원래부터 쓴다).
- **`--dropout P`** (0 < P ≤ 0.5, 기본 미설정 = checkpoint 설정 그대로): 학습 때 encoder의
  attention/embedding/mlp dropout을 P로 둔다. ModernBERT는 이 값을 모듈 생성 시점에
  복사하고, attention 출력 dropout은 0이면 `nn.Identity`로 만들어 버리므로 생성 뒤 설정을
  바꾸면 일부가 빠진다. 그래서 `build_model_with_encoder_dropout()`이 encoder 디렉터리를
  임시로 복사해 config만 바꾼 뒤 laya `build_model()`로 생성하고, 생성 직후
  `assert_encoder_dropout_applied()`가 실제 모듈 값을 검사한다(multilingual 기준 Dropout
  모듈 45개 + attention 22개가 모두 P가 아니면 중단, 결과는 `[local] encoder dropout applied: ...`
  로그와 `local_training_run.json`의 `encoder_dropout_check`). **저장되는
  `encoder/config.json`은 원래 checkpoint 값(0.0)을 유지**하므로 추론 설정·식별자는 그대로이고,
  추론·calibration 수집·epoch 선택·온도 피팅은 모두 eval 모드라 dropout이 꺼진다.
- **`--rdrop-alpha A`** (A ≥ 0, 기본 0 = 끔, `--dropout` 필수): R-Drop(Liang et al.,
  NeurIPS 2021). micro-batch마다 train 모드 forward를 두 번 돌려(서로 다른 dropout mask),
  기존 loss(RL + CE)를 두 pass 평균으로 쓰고 `A × 대칭 KL`(0.5·(KL(p1‖p2)+KL(p2‖p1)),
  질문별 유효 option에만, 질문 평균)을 더한다. grad-accum 나눗셈·gradient clipping·
  optimizer step마다의 `torch.mps.empty_cache()`는 그대로다.
- **비용 (2026-09-24 M4 Pro 24GB 실측, 실제 export에서 train 64행, batch 4, 48 micro-step)**:
  플래그 없음 1.34초/step·MPS 약 6.9GB, `--dropout 0.1`만 1.50초/step(약 1.1배)·약 6.4GB,
  `--dropout 0.1 --rdrop-alpha 1.0` 3.15초/step(약 **2.35배**)·약 **11.2GB**. R-Drop은
  forward/backward를 두 번 하므로 연산이 약 2배 이상 들고, 두 pass의 그래프를 동시에 들고
  있어 메모리도 크게 는다. 전체 규모 학습 전에 `--max-steps`로 메모리를 먼저 확인한다.
- **기록**: 두 값은 `local_training_run.json`(`dropout`, `rdrop_alpha`)과
  `training_metadata.json`의 `hyperparameters`에 남고(끄면 `null`), `[local] device=...`
  시작 줄에도 찍힌다. 두 플래그를 끈 기본 경로는 이전과 loss·가중치 갱신이 비트 단위로
  같다(`tests/test_laya_kit_regularization.py`).
- **주의(MPS)**: attention dropout이 켜진 encoder를 **train 모드 + `torch.no_grad()`**로
  돌리면 PyTorch MPS SDPA가 `NotImplementedError`를 낸다. 학습(grad 켜짐)과 eval 모드
  경로는 문제없으니, train 모드 그대로 no_grad 평가를 추가하지 않는다.

## Epoch 수 지정과 중단 후 이어서 학습 (`--epochs`, `--resume`, `--keep-resume`, `--local` 전용, 2026-09-25)

- **배경**: 전체 export(18,402행, batch 4 × grad-accum 16) 로컬 MPS 학습은 epoch당 약 1.85시간이고,
  밤샘 실행은 하지 않는다(노트북 소음). 6 epoch 학습은 이틀에 걸치므로 epoch 단위로 멈췄다 이어야 한다.
- **`--epochs N`** (1 ≤ N ≤ 20, 기본 4 = 이전 동작): 학습 루프 횟수와 cosine LR schedule 전체 길이
  (`T_max = (학습 항목 수 // (batch × grad-accum)) × N`)를 함께 정한다. `local_training_run.json`의
  `epochs`와 `training_metadata.json`의 `hyperparameters.epochs`에 기록된다. DDP 경로에서는 거부된다.
- **저장되는 것** (`--local`이면 항상, 완료된 epoch마다 `[select]` 판정 직후):
  `<output-dir>/resume/epoch-000N/`에 `training_state.pt`(모델 state_dict, AdamW 상태, scheduler 상태,
  Python·NumPy·torch CPU·MPS RNG 상태), `best_model.pt`(지금까지 calibration 일치율 최고 epoch의
  가중치 -- 이제 RAM 대신 디스크에 둔다. 새 최고가 아니면 이전 epoch의 파일을 hard link로 넘긴다),
  `state.json`(완료 epoch 수, global_step, epoch별 agreement, 최고 epoch/점수, 누적 학습 시간, 실행 설정).
  임시 디렉터리에 다 쓴 뒤 이름을 바꾸고 `resume/LATEST`를 원자적으로 교체하므로, 저장 도중
  끊겨도 LATEST는 항상 온전한 이전 epoch을 가리킨다. 최신 epoch 하나만 남기고 나머지는 지운다.
- **실행 설정 일치 검사**: `state.json`의 설정(export `manifest.json`·`train.jsonl`·`calibration.jsonl`
  sha256, exporter/dataset 버전, base 모델 경로와 `model.safetensors` sha256, 학습 스크립트 sha256,
  epochs, batch/grad-accum, device, mps-autocast, dropout, rdrop-alpha, select-best-epoch,
  max_len/head_max_len)이 현재 인자와 하나라도 다르면 `--resume`은 불일치 목록을 출력하고 멈춘다.
  `--max-steps`, `--keep-resume`, admission 검사 옵션은 비교하지 않는다. kit 코드가 바뀌어도
  (스크립트 sha256이 달라져) 이어서 학습할 수 없다 -- 멈춘 사이에는 kit을 고치지 않는다.
- **전처리 캐시**: `--resume`일 때 `<output-dir>/train_items.pt`/`calib_items.pt`가 있고 내용 digest가
  중단된 실행이 기록한 값과 같으면 전처리를 건너뛴다(export 일치는 위 설정 검사로 이미 확인됨).
  다르거나 없으면 다시 전처리하고, 그 결과 digest가 기록과 다르면 이어서 학습하지 않고 멈춘다.
- **재개 단위는 epoch**: epoch 중간에 끊으면 마지막으로 완료된 epoch부터 그 다음 epoch을 처음부터
  다시 돈다(끊긴 epoch의 진행분은 버려진다). 첫 epoch이 끝나기 전에 끊기면 재개할 상태가 없다.
  재개 시 완료된 epoch들의 셔플을 재생하고 RNG를 복원하므로, CPU에서는 끊김 없는 실행과 최종
  가중치·`epoch_agreements`·`selected_epoch`가 비트 단위로 같다(`tests/test_laya_kit_resume.py`).
  MPS는 커널 비결정성 때문에 완전히 같다는 보장은 없다. 새로 시작하는 `--local` 실행은
  torch seed를 42로 고정한다(이전에는 고정하지 않았다).
- **안전장치**: `--resume` 없이 같은 `--output-dir`에 재개 상태가 있으면 새 실행은 시작하지 않는다
  (중단된 실행을 덮어쓰지 않도록). 새로 시작하려면 `<output-dir>/resume/`를 직접 지운다.
  `--resume`인데 상태가 없으면 새로 시작하지 않고 멈춘다.
- **정리**: 최종 저장(온도 피팅, `model.safetensors`, 메타데이터) 성공 뒤 `resume/`를 지운다.
  `--keep-resume`이면 남기고 크기를 출력한다. `training_metadata.json`에는 원래 `started_at`과
  `resumed_at`/`resumed_from_epoch`가, `local_training_run.json`에는 모든 구간을 합한 `wall_time_s`와
  `resumed_from_epoch`가 남는다.
- **디스크 비용**: multilingual(파라미터 약 3.2억 개) 기준 `training_state.pt` 약 3.9GB(fp32 가중치
  1.3GB + AdamW 상태 2.6GB) + `best_model.pt` 1.3GB = 상시 약 5.2GB(실측 4.80GiB). 저장하는 순간에는 이전
  epoch과 새 epoch이 잠깐 같이 있어 최대 약 9~10GB가 필요하다. epoch마다 이만큼을 쓰는 시간이 더 든다.
- **밤에 멈추고 아침에 잇기** (예: 6 epoch, dropout 0.1):
  ```sh
  PY=/Users/jangjiyong/.local/share/laya/.venv/bin/python
  # 배열로 둔다(zsh는 따옴표 없는 "$ARGS" 문자열을 인자로 쪼개지 않는다).
  ARGS=(--export-dir exports/<hash>/laya
        --model-dir /Users/jangjiyong/.local/share/laya/models/multilingual/multilingual
        --output-dir <출력-디렉터리> --local --device mps --batch-size 4 --epochs 6 --dropout 0.1)
  # 1일차: 시작. 저녁에 "[resume] saved epoch N/6 checkpoint" 줄(또는 <출력-디렉터리>/resume/LATEST
  # 갱신)을 확인한 직후 터미널에서 Ctrl-C.
  PYTHONUNBUFFERED=1 $PY training/laya-kit/train_from_export.py "${ARGS[@]}" 2>&1 | tee -a train.log
  # 2일차 아침: 같은 인자에 --resume만 붙인다(다른 인자를 바꾸면 거부된다).
  PYTHONUNBUFFERED=1 $PY training/laya-kit/train_from_export.py "${ARGS[@]}" --resume 2>&1 | tee -a train.log
  ```
  epoch 중간에 Ctrl-C를 누르면 그 epoch의 진행분(최대 약 1.85시간)을 잃으므로, `[resume] saved epoch`
  줄이 찍힌 직후에 멈추는 것이 좋다. 로그를 파일로 보낼 때 `PYTHONUNBUFFERED=1`이 없으면 출력이
  버퍼에 쌓여 그 줄이 늦게 보인다. 백그라운드(`&`)로 띄운 프로세스는 SIGINT를 무시하므로 Ctrl-C/
  `kill -INT`가 듣지 않는다 -- 그 경우 `kill` (SIGTERM)로 멈춰도 마지막 완료 epoch부터 이어진다.
- **MPS 실측 (2026-09-25, M4 Pro 24GB, 실제 export에서 train 64행 + calibration 423행 + test 8행,
  `--batch-size 4 --epochs 2 --dropout 0.1`)**: 끊김 없는 실행 A와, epoch 2 도중 SIGTERM으로 끊은 뒤
  `--resume`으로 마친 실행 B의 `epoch_agreements`(0.3599/0.3777)와 `selected_epoch`(2)가 완전히 같았다.
  fp16 가중치는 0.003%(최대 차 6.1e-5)가 달랐는데, 끊김 없는 실행 두 번(A와 C)끼리도 0.0025%·최대 차
  6.1e-5로 같은 수준이 달라 MPS 실행 간 비결정성 범위 안이다. 재개 상태 크기는 epoch마다 4.80GiB,
  재개 시 전처리 캐시를 재사용했고, 설정 불일치(`--dropout 0.2`)와 상태가 있는데 `--resume` 없이 시작한
  경우는 둘 다 상태를 건드리지 않고 거부됐다.

## 학습 후 평가(`evaluate_checkpoint`) 버그 수정 (2026-09-23)

- **증상(실측)**: 위 실측 학습의 학습 후 평가 단계가
  `[eval] evaluation step failed or was skipped: 'label'`로 실패해 `test.jsonl` 기준
  metrics(accuracy 등)가 전혀 기록되지 않았다.
- **원인**: 공식 notebook의 평가 셀은 gold 답에 `label`/`score` 키가 있다고 가정하지만,
  jev export의 `exportDataset()`(`src/training/dataset.mjs`)은 `gold[qid]`를
  `{"probabilities": {...}}`로만 쓴다(`training/laya-kit/check_export.py`의
  `check_gold_probabilities()`가 이 형태를 강제). `evaluate_checkpoint()`가
  `g_ans["label"]`을 직접 읽어 choice/noul 질문에서 `KeyError('label')`이 났다.
- **수정**: `resolve_gold_label(q_type, g_ans, keys=None, n_levels=None)`이
  `build_training_item()`이 학습 타깃 라벨을 정하는 것과 동일한 방식
  (`target.index(max(target))`, 즉 probabilities의 argmax)으로 gold 라벨을 derive한다.
  명시적 `label` 키가 있으면(예: 수기로 만든 fixture) 그 값이 우선한다(하위 호환).
  choice/noul/score 세 분기 모두 이 함수를 쓰도록 고쳤고, score 타입의 gold scalar
  (`score_mae`/`within_1_level`용)도 `g_ans.get("score", ...)`가 없을 때 이 argmax
  레벨로 대체한다.
- **연쇄로 드러난 둘째 버그**: 위 수정 후 실측에서 새로운 에러
  `Cannot cast ufunc 'divide' output from dtype('float64') to dtype('int64')`가
  나왔다 -- objective/human 라벨의 gold probabilities는 one-hot(`targetDistribution()`이
  `1`/`0` 정수를 만듦)이라 JSON 왕복 시 Python `int`로 역직렬화되고, 그 값들로 만든
  `np.array(...)`가 `int64` dtype으로 추론돼 이어지는 in-place `/=`가 casting 에러를
  낸다. `p_probs`/`g_probs`/`p_probs_score` 세 배열 생성에 `dtype=np.float64`를 명시해
  고쳤다.
- **검증**: `tests/test_laya_kit_eval_and_epoch_select.py`의 `ResolveGoldLabel`(순수
  로직)과 `EvaluateCheckpointRealExportShape`(실제 export row 형태의 synthetic
  test.jsonl + fake `Agent`로 `evaluate_checkpoint()`를 end-to-end 실행, 정수값
  probabilities 케이스 포함)가 두 버그 모두 RED로 재현 후 GREEN을 확인했다. 2026-09-23
  M4 Pro `--local --max-steps` smoke에서 `[eval]` 실패 로그 없이
  `training_metadata.json.metrics`가 채워지는 것을 실측 확인했다.

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
