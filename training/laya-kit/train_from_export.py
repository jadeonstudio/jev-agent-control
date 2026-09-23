#!/usr/bin/env python3
# Copyright 2024 Convai Innovations (upstream `laya` package and the official
# fine-tuning notebook this file adapts).
# Copyright 2026 the jev-agent-control project (jev-specific adaptation).
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""train_from_export.py -- Laya RLCD+GRPO fine-tuning kit driven by a jev export.

This file is a *preparation artifact*. It is NOT executed by the assistant
that wrote it, does not download models, does not install packages, and does
not read the real JEV_HOME / ~/.local/share/laya. It is meant to be uploaded
to a Kaggle notebook (or an equivalent 2x NVIDIA T4 DDP machine) by a human
operator and run there, following training/laya-kit/README.md.

Upstream contract this file is pinned to (see docs/TRAINING_DATA.md section 5
and src/training/dataset.mjs LAYA_UPSTREAM / LAYA_EXPORT_VERSION):

    NandhaKishorM/laya@42626c348753fbb17572a813127df2278a1ec527
    notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb

Every training/eval section below is lifted from that notebook's cells with
**minimal** changes. Each such section is marked:

    # official-notebook-cell: <N> ("<markdown heading>")

Every place this file diverges from the official notebook is marked:

    # jev-change: <reason>

The single structural difference from the official notebook is the data
source: instead of the notebook's

    load_dataset("LocalLLaMA/typed-decisions", "all", split="train")
    load_dataset("LocalLLaMA/typed-decisions", "all", split="test")

this script reads the jev export folder produced by
`jev-control dataset export --format laya` (train.jsonl / calibration.jsonl /
test.jsonl, see docs/TRAINING_DATA.md section 5), via --export-dir, using the
loader recorded in that export's own manifest.json:

    datasets.load_dataset("json", data_files={
        "train": "train.jsonl", "validation": "calibration.jsonl", "test": "test.jsonl",
    })

calibration.jsonl and test.jsonl are never merged into the training split.
The official notebook's own gold-column shape (`gold[qid]["probabilities"]`)
already matches the jev export contract exactly, so `build_training_item()`
below is copied verbatim from the notebook.
"""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Upstream contract constants. These MUST match src/training/dataset.mjs
# (LAYA_UPSTREAM, LAYA_EXPORT_VERSION) exactly. If the export folder's
# manifest.json disagrees, this is either a stale export or a contract that
# has moved since this kit was written -- abort rather than guess.
# ---------------------------------------------------------------------------
EXPECTED_EXPORTER_VERSION = "laya-typed-decisions-json-v2"
EXPECTED_UPSTREAM_CONTRACT = (
    "NandhaKishorM/laya@42626c348753fbb17572a813127df2278a1ec527:"
    "notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb"
)
EXPECTED_LOADER = (
    'datasets.load_dataset("json", data_files={"train": "train.jsonl", '
    '"validation": "calibration.jsonl", "test": "test.jsonl"})'
)
NOTEBOOK_COMMIT = "42626c348753fbb17572a813127df2278a1ec527"
LAYA_VERSION_PINNED = "0.3.4"  # matches training/laya-kit/requirements.lock


class KitError(RuntimeError):
    """Raised for any condition that should abort before training starts."""


def die(message):
    raise KitError(message)


# ---------------------------------------------------------------------------
# Step 0: verify the export contract before touching any data.
# jev-change: the official notebook has no such check because it always
# reads the public LocalLLaMA/typed-decisions dataset directly. Exporting a
# local jev dataset makes this check load-bearing.
# ---------------------------------------------------------------------------
def verify_export_manifest(export_dir: Path) -> dict:
    manifest_path = export_dir / "manifest.json"
    if not manifest_path.exists():
        die(f"{manifest_path} not found -- run `jev-control dataset export --format laya` first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if manifest.get("exporter_version") != EXPECTED_EXPORTER_VERSION:
        die(
            f"export manifest exporter_version={manifest.get('exporter_version')!r} "
            f"!= expected {EXPECTED_EXPORTER_VERSION!r} -- this kit is pinned to a "
            "specific export contract; re-check src/training/dataset.mjs before proceeding"
        )
    if manifest.get("upstream_contract") != EXPECTED_UPSTREAM_CONTRACT:
        die(
            f"export manifest upstream_contract={manifest.get('upstream_contract')!r} "
            f"!= expected {EXPECTED_UPSTREAM_CONTRACT!r}"
        )
    if manifest.get("loader") != EXPECTED_LOADER:
        die(
            f"export manifest loader={manifest.get('loader')!r} "
            f"!= expected {EXPECTED_LOADER!r} -- the loader contract changed; "
            "update this script's data loading to match before proceeding"
        )
    if not manifest.get("source_data_sha256"):
        die("export manifest is missing source_data_sha256")
    if manifest.get("training_executed") is not False:
        die("export manifest.training_executed must be false for an unconsumed export")

    for split in ("train", "calibration", "test"):
        split_path = export_dir / f"{split}.jsonl"
        if not split_path.exists() or split_path.stat().st_size == 0:
            die(f"{split_path} missing or empty (EMPTY_SPLIT) -- calibration/test are never merged into train")

    print(f"[verify] export manifest OK: dataset_version={manifest.get('dataset_version')} "
          f"sample_count={manifest.get('sample_count')} source_data_sha256={manifest.get('source_data_sha256')}")
    return manifest


# ---------------------------------------------------------------------------
# jev-change: copied verbatim from workers/laya_worker.py (this kit must stay
# standalone for Kaggle, so it cannot import that module). `fit_task_head()`
# is the same opt-in "task-head fit" the inference worker applies when
# `providers.json` sets `laya.inputFit: 'task-head'` -- see
# docs/TRAINING_DATA.md section 7 and workers/laya_worker.py. Applying the
# IDENTICAL fit here, before building each training item, keeps train-time
# preprocessing consistent with what inference actually sends when a
# checkpoint is registered with that opt-in; tests/test_laya_kit_input_fit.py
# asserts both copies produce identical output on synthetic cases.
# ---------------------------------------------------------------------------
def assert_lossless(agent, state, questions):
    from laya.common import render_options, serialize_state, build_sequence
    tok = agent.tok
    max_len, head_max = agent.cfg.get("max_len", 512), agent.cfg.get("head_max_len", 192)
    for question in questions.values():
        q = agent._to_internal(question)
        fields = [q["ins"], serialize_state(state), *render_options(q)]
        if any(tok.mask_token in value for value in fields):
            raise ValueError("INPUT_REWRITE_REFUSED")
        head = tok("%s question: %s" % (q["t"], q["ins"]), add_special_tokens=False)["input_ids"]
        options = [tok(" " + option, add_special_tokens=False)["input_ids"] for option in render_options(q)]
        if any(len(option) > 48 for option in options):
            raise ValueError("INPUT_TRUNCATED")
        budget = head_max - sum(len(option) + 1 for option in options)
        state_tokens = tok(serialize_state(state), add_special_tokens=False)["input_ids"]
        expected = len(head) + sum(len(option) + 1 for option in options) + len(state_tokens) + 4
        if budget < 16 or len(head) > max(8, budget) or expected > max_len:
            raise ValueError("INPUT_TRUNCATED")
        sequence, markers = build_sequence(tok, state, q, max_len, head_max)
        if len(sequence) != expected or len(markers) != len(options):
            raise ValueError("INPUT_TRUNCATED")

TRUNCATION_MARK = " …[truncated]"

def fit_task_head(agent, state, questions):
    """Default lossless refusal stays the behavior of assert_lossless(); this is the opt-in path
    (see providers.json `laya.inputFit`) that instead finds the longest character prefix of
    state["task"] that still fits ALL given questions losslessly, leaving every other state key
    (context) untouched. Never truncates questions/instructions/options. Correctness is always
    verified by assert_lossless before returning; token-based estimation below only narrows the
    search window, it never decides the final answer.
    """
    try:
        assert_lossless(agent, state, questions)
        return state, {"truncated": False}
    except ValueError as e:
        original_error = e
    if str(original_error) == "INPUT_REWRITE_REFUSED" or not (isinstance(state, dict) and isinstance(state.get("task"), str)):
        raise original_error
    task = state["task"]
    original_chars = len(task)

    def candidate(p):
        return {**state, "task": task[:p].rstrip() + TRUNCATION_MARK}

    def fits(p):
        try:
            assert_lossless(agent, candidate(p), questions)
            return True
        except ValueError:
            return False

    # Narrow with a cheap analytic token-budget estimate before a short gallop+binary search. Each
    # fits() probe below re-runs assert_lossless() in full (head/options/state tokenize +
    # build_sequence), which is by far the most expensive step, so the estimate's job is to make
    # that search cover only a handful of characters instead of the whole task -- it is never
    # itself the answer, and fits(0) is always reached as a real probe below (never skipped), so
    # "no prefix passes" is still detected and raises the original error, exactly as before.
    try:
        from laya.common import render_options, serialize_state
        tok, max_len = agent.tok, agent.cfg.get("max_len", 512)
        min_state_budget = None
        for question in questions.values():
            q = agent._to_internal(question)
            head = tok("%s question: %s" % (q["t"], q["ins"]), add_special_tokens=False)["input_ids"]
            options = [tok(" " + option, add_special_tokens=False)["input_ids"] for option in render_options(q)]
            state_budget = max_len - len(head) - sum(len(o) + 1 for o in options) - 4
            min_state_budget = state_budget if min_state_budget is None else min(min_state_budget, state_budget)
        base_tokens = len(tok(serialize_state(candidate(0)), add_special_tokens=False)["input_ids"])
        task_tokens = max(1, len(tok(task, add_special_tokens=False)["input_ids"]))
        chars_per_token = original_chars / task_tokens
        remaining_tokens = max(0, min_state_budget - base_tokens)
        guess = min(original_chars, max(0, int(remaining_tokens * chars_per_token)))
    except Exception:
        guess = 0

    # Gallop out from the guess (doubling step) to bracket the true boundary in a few probes, then
    # binary search only that small bracket -- not the whole [0, original_chars] range, which is
    # what made an unbracketed binary search from a lone guess cost extra probes in practice.
    if fits(guess):
        lo, hi, probe, step = guess, original_chars, guess, 1
        while probe < hi:
            probe = min(hi, probe + step)
            if fits(probe):
                lo = probe
                step *= 2
            else:
                hi = probe
                break
    else:
        hi, probe, step, lo = guess, guess, 1, None
        while True:
            probe = max(0, probe - step)
            if fits(probe):
                lo = probe
                break
            hi = probe
            if probe == 0:
                break
            step *= 2
        if lo is None:
            raise original_error
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid - 1
    return candidate(lo), {"truncated": True, "original_chars": original_chars, "kept_chars": lo}


# ---------------------------------------------------------------------------
# official-notebook-cell: 3 ("Download & Preprocess Data for DDP")
# jev-change: `ds_train = load_dataset("LocalLLaMA/typed-decisions", ...)` is
# replaced by reading the local export split files via the manifest's own
# recorded loader string. `build_training_item()` is otherwise byte-for-byte
# identical to the notebook because the export's gold[qid]["probabilities"]
# shape already matches what the notebook expects.
# ---------------------------------------------------------------------------
def build_training_item(tok, cfg, state, q, gold_q, render_options, build_sequence, QTYPES):
    t = q["type"]
    crit = q.get("criteria", {})
    if t == "choice":
        keys = list(crit.keys())
        target = [gold_q["probabilities"].get(k, 0.0) for k in keys]
    elif t == "noul":
        target = [gold_q["probabilities"].get("false", 0.5), gold_q["probabilities"].get("true", 0.5)]
    elif t == "score":
        n_levels = len(crit) if isinstance(crit, list) else 4
        target = [gold_q["probabilities"].get(str(i), 0.0) for i in range(n_levels)]
    else:
        die(f"unknown question type {t!r}")

    s = sum(target)
    target = [v / s for v in target] if s > 0 else [1.0 / len(target)] * len(target)
    label = target.index(max(target))
    k = len(render_options({"t": t, "crit": crit}))

    seq, markers = build_sequence(tok, state, {"t": t, "ins": q["instructions"], "crit": crit}, cfg["max_len"], cfg["head_max_len"])
    if len(markers) != k:
        return None, True  # jev-change: also return a truncation flag instead of silently discarding
    return {
        "ids": seq,
        "markers": markers,
        "qtype": QTYPES[t],
        "target": target,
        "label": label,
    }, False


def preprocess_split(rows, tok, cfg, render_options, build_sequence, QTYPES, agent):
    """official-notebook-cell: 3 inner loop, generalized to any split's rows.

    jev-change: before building any question's training item for a row, the row's state is passed
    through fit_task_head() using ALL of that row's own questions (the same question set the
    export groups gold by, per state) -- the identical fit workers/laya_worker.py applies at
    inference when `providers.json` sets `laya.inputFit: 'task-head'`. Only state["task"] is ever
    shortened; every other state key, and every question/instructions/option, is untouched. The
    existing marker-loss drop (`build_training_item`'s own truncation check) still applies
    afterward, on the fitted state.
    """
    items = []
    truncated = 0
    total_questions = 0
    input_fit_truncated_states = 0
    for row in rows:
        state = json.loads(row["state"])
        questions = json.loads(row["questions"])
        gold = json.loads(row["gold"])
        try:
            fitted_state, fit_info = fit_task_head(agent, state, questions)
        except ValueError:
            # Neither the raw state nor any task prefix fits (e.g. context/questions alone
            # overflow): every question of this row is dropped the same way a marker-loss would be.
            truncated += len(questions)
            total_questions += len(questions)
            continue
        if fit_info["truncated"]:
            input_fit_truncated_states += 1
        for qid, q in questions.items():
            if qid not in gold:
                continue
            total_questions += 1
            item, was_truncated = build_training_item(tok, cfg, fitted_state, q, gold[qid], render_options, build_sequence, QTYPES)
            if was_truncated:
                truncated += 1
                continue
            if item is not None:
                items.append(item)
    print(f"[input-fit] {input_fit_truncated_states} states task-head truncated")
    return items, truncated, total_questions


# jev-change: tokenizer admission check the official notebook does not
# perform. The notebook silently drops any row whose sequence does not fit
# max_len/head_max_len (`if len(markers) != k: return None`). Silent
# truncation loss is exactly the failure mode docs/TRAINING_DATA.md forbids
# ("입력이 공식 tokenizer의 head/options/state 예산에서 잘리거나 mask token을
# 치환해야 하면 적용하지 않는다"), so this kit reports it and can abort.
def check_tokenizer_admission(truncated, total_questions, max_truncated_fraction, allow_truncation):
    fraction = (truncated / total_questions) if total_questions else 0.0
    print(f"[tokenizer-admission] {truncated}/{total_questions} question-rows "
          f"({fraction:.2%}) were truncated by the official tokenizer budget and dropped")
    if truncated and not allow_truncation and fraction > max_truncated_fraction:
        die(
            f"tokenizer admission failure: {fraction:.2%} of rows truncated, exceeds "
            f"--max-truncated-fraction={max_truncated_fraction:.2%}. Re-run with "
            "--allow-truncation to proceed anyway, or shorten state/instructions upstream."
        )


# ---------------------------------------------------------------------------
# official-notebook-cell: 4 ("DDP Training Script (train_ddp.py)")
# jev-change: (1) the calibration set is no longer `all_items[::15][:400]`
# sampled out of the training data -- it is the export's own held-out
# calibration.jsonl, preprocessed the same way as train, and passed in as
# CALIB_ITEMS_PATH. (2) EPOCHS/MICRO_BATCH/etc. are left as the notebook's
# literal values; nothing else in the training math (RLCD/GRPO loss, DDP
# wiring, AdamW param groups, cosine schedule) is modified.
# ---------------------------------------------------------------------------
TRAIN_DDP_SCRIPT = r'''
# official-notebook-cell: 4 ("DDP Training Script (train_ddp.py)") -- copied
# from the pinned notebook with only the jev-change noted at the top of
# train_from_export.py (calibration items come from CALIB_ITEMS_PATH, not an
# in-training-set slice).
import os, sys, time, json, random, math
import numpy as np
import torch
import torch.distributed as dist
from torch.nn.parallel import DistributedDataParallel as DDP
from safetensors.torch import load_file, save_file
from transformers import AutoTokenizer
from laya.common import build_model, proper_reward, QTYPES

def collate_train_batch(items, pad_id):
    n, L = len(items), max(len(it["ids"]) for it in items)
    kmax = max(len(it["markers"]) for it in items)
    ids = torch.full((n, L), pad_id, dtype=torch.long)
    att = torch.zeros((n, L), dtype=torch.long)
    mpos = torch.zeros((n, kmax), dtype=torch.long)
    mmask = torch.zeros((n, kmax), dtype=torch.bool)
    target = torch.zeros((n, kmax), dtype=torch.float32)
    for i, it in enumerate(items):
        ids[i, : len(it["ids"])] = torch.tensor(it["ids"])
        att[i, : len(it["ids"])] = 1
        k = len(it["markers"])
        mpos[i, :k] = torch.tensor(it["markers"])
        mmask[i, :k] = True
        target[i, : len(it["target"])] = torch.tensor(it["target"], dtype=torch.float32)
    return {
        "input_ids": ids,
        "attention_mask": att,
        "marker_pos": mpos,
        "marker_mask": mmask,
        "target": target,
        "qtype": torch.tensor([it["qtype"] for it in items]),
        "label": torch.tensor([it["label"] for it in items])
    }

def fit_one_temp(sel):
    if len(sel) < 10:
        return 1.0
    kmax = max(len(z) for z, _ in sel)
    Z = torch.full((len(sel), kmax), -1e4)
    T = torch.zeros((len(sel), kmax))
    for i, (z, t) in enumerate(sel):
        Z[i, :len(z)] = torch.tensor(z)
        T[i, :len(t)] = torch.tensor(t, dtype=torch.float32)
    log_t = torch.zeros(1, requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=0.1, max_iter=100)
    def closure():
        opt.zero_grad()
        loss = -(T * torch.log_softmax(Z / log_t.exp(), -1)).sum(-1).mean()
        loss.backward()
        return loss
    opt.step(closure)
    return float(torch.clamp(log_t.exp(), 0.1, 10.0).item())

def main():
    dist.init_process_group("nccl")
    rank = dist.get_rank()
    world_size = dist.get_world_size()
    local_rank = int(os.environ.get("LOCAL_RANK", "0"))
    torch.cuda.set_device(local_rank)
    device = torch.device("cuda", local_rank)

    model_dir = sys.argv[1]
    output_dir = sys.argv[2]
    train_items_path = sys.argv[3]
    # jev-change: fourth argv is the preprocessed calibration.jsonl items
    # (the export's real held-out split), replacing the notebook's
    # all_items[::15][:400] slice of the *training* data.
    calib_items_path = sys.argv[4]

    with open(os.path.join(model_dir, "rl_agent_config.json")) as f:
        cfg = json.load(f)
    cfg["gradient_checkpointing"] = True
    cfg["max_tokens_per_batch"] = 4096
    cfg["max_len"] = 1024
    cfg["head_max_len"] = 256

    tok = AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    model = build_model(cfg, encoder_dir=os.path.join(model_dir, "encoder"))

    weights = load_file(os.path.join(model_dir, "model.safetensors"))
    model.load_state_dict(weights, strict=True)

    model.encoder.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.head_checkpointing = True
    model.to(device)
    model.train()

    ddp_model = DDP(model, device_ids=[local_rank], find_unused_parameters=True)

    all_items = torch.load(train_items_path, weights_only=False)
    my_items = all_items[rank::world_size]

    EPOCHS = 4
    MICRO_BATCH = 8      # 8 sequences per forward pass per GPU
    GRAD_ACCUM = 4       # Effective batch across 2 GPUs = 64 sequences (8 * 2 * 4)
    GROUP_SIZE = 4       # GRPO baseline samples
    LR_ENCODER = 2.5e-5  # Encoder adaptation rate
    LR_HEAD = 1.0e-4     # Head adaptation rate
    SIGMA_START = 0.4    # Exploration noise
    SIGMA_END = 0.1

    enc_params = [p for n, p in ddp_model.named_parameters() if "encoder." in n]
    head_params = [p for n, p in ddp_model.named_parameters() if "encoder." not in n]

    optimizer = torch.optim.AdamW([
        {"params": enc_params, "lr": LR_ENCODER},
        {"params": head_params, "lr": LR_HEAD}
    ], weight_decay=0.01)

    total_updates = (len(my_items) // (MICRO_BATCH * GRAD_ACCUM)) * EPOCHS
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, total_updates), eta_min=1e-6)
    scaler = torch.amp.GradScaler("cuda", enabled=True)

    if rank == 0:
        print(f"Starting 2xT4 DDP training: {len(all_items)} total items | {len(my_items)} per rank | {EPOCHS} epochs")
    t0 = time.time()

    for epoch in range(EPOCHS):
        random.seed(42 + epoch + rank)
        random.shuffle(my_items)
        epoch_loss, n_batches = 0.0, 0
        optimizer.zero_grad(set_to_none=True)
        accum_step = 0

        progress = epoch / max(1, EPOCHS - 1)
        sigma = SIGMA_START + (SIGMA_END - SIGMA_START) * progress

        for b_idx in range(0, len(my_items), MICRO_BATCH):
            chunk = my_items[b_idx:b_idx + MICRO_BATCH]
            if not chunk:
                continue

            batch = collate_train_batch(chunk, tok.pad_token_id)

            with torch.autocast("cuda", dtype=torch.float16):
                logits, act = ddp_model(
                    batch["input_ids"].to(device),
                    batch["attention_mask"].to(device),
                    batch["marker_pos"].to(device),
                    batch["marker_mask"].to(device),
                    batch["qtype"].to(device)
                )

            logits = logits.float()
            mask = batch["marker_mask"].to(device)
            k = mask.sum(-1, keepdim=True).float()
            target = batch["target"].to(device)

            eps = torch.randn((GROUP_SIZE,) + logits.shape, device=device) * sigma * mask
            eps = (eps - eps.sum(-1, keepdim=True) / k) * mask
            z = logits.detach().unsqueeze(0) + eps
            q = torch.softmax(z.masked_fill(~mask, -1e4), -1)

            with torch.no_grad():
                r = proper_reward(q, target.unsqueeze(0), batch["qtype"].to(device), mask, w_sph=0.75, w_rps=1.0)
                adv = r - r.mean(0, keepdim=True)
                adv = adv / (adv.std() + 1e-6)

            logp = -(((z - logits.unsqueeze(0)) ** 2) * mask).sum(-1) / (2 * sigma ** 2)
            loss_rl = -(adv * logp).mean()
            loss_ce = -(target * torch.log_softmax(logits.masked_fill(~mask, -1e4), -1)).sum(-1).mean()
            loss = (loss_rl + 1.0 * loss_ce) / GRAD_ACCUM + 0.0 * act.sum()

            scaler.scale(loss).backward()
            accum_step += 1

            if accum_step % GRAD_ACCUM == 0 or (b_idx + MICRO_BATCH) >= len(my_items):
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(ddp_model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                scheduler.step()
                optimizer.zero_grad(set_to_none=True)

            epoch_loss += loss.item() * GRAD_ACCUM
            n_batches += 1

            if rank == 0 and (n_batches % 50) == 0:
                cur_lr = scheduler.get_last_lr()[0]
                print(f"  Epoch {epoch+1}/{EPOCHS} | Step {n_batches} | Loss: {loss.item()*GRAD_ACCUM:.4f} | Reward: {r.mean().item():.3f} | LR: {cur_lr:.2e}")

        if rank == 0:
            print(f"=== Epoch {epoch+1}/{EPOCHS} Completed in {time.time()-t0:.1f}s | Avg Loss: {epoch_loss/max(1, n_batches):.4f} ===")

    dist.barrier()

    if rank == 0:
        print("\nFitting post-training calibration temperatures...")
        del optimizer, scaler, scheduler
        torch.cuda.empty_cache()
        model.eval()
        # jev-change: real held-out calibration.jsonl items, not every-15th
        # training item.
        calib_items = torch.load(calib_items_path, weights_only=False)
        calib_preds = []
        with torch.no_grad():
            for c_idx in range(0, len(calib_items), 16):
                c_chunk = calib_items[c_idx:c_idx + 16]
                cb = collate_train_batch(c_chunk, tok.pad_token_id)
                with torch.autocast("cuda", dtype=torch.float16):
                    l_sub, _ = model(
                        cb["input_ids"].to(device),
                        cb["attention_mask"].to(device),
                        cb["marker_pos"].to(device),
                        cb["marker_mask"].to(device),
                        cb["qtype"].to(device)
                    )
                l_np = l_sub.float().cpu().numpy()
                for r, it in enumerate(c_chunk):
                    k = len(it["markers"])
                    calib_preds.append((it["qtype"], l_np[r, :k], it["target"]))

        fitted_temps = [1.2, 1.2, 1.2]
        try:
            for qt in range(3):
                sel = [(z, t) for q_type, z, t in calib_preds if q_type == qt]
                if sel:
                    fitted_temps[qt] = fit_one_temp(sel)
            print("Fitted calibration temperatures (choice, score, noul):", [round(t, 3) for t in fitted_temps])
        except Exception as e:
            print("Temperature fitting fallback:", e)
        os.makedirs(output_dir, exist_ok=True)
        sd = {k: v.half().contiguous().cpu() for k, v in model.state_dict().items()}
        save_file(sd, os.path.join(output_dir, "model.safetensors"))
        model.encoder.config.save_pretrained(os.path.join(output_dir, "encoder"))
        tok.save_pretrained(os.path.join(output_dir, "tokenizer"))

        cfg["fine_tuned"] = True
        cfg["model_name"] = "laya-typed-decisions"
        cfg["temperature"] = fitted_temps
        with open(os.path.join(output_dir, "rl_agent_config.json"), "w") as f:
            json.dump(cfg, f, indent=2)
        print(f"Model successfully saved to {output_dir}!")

    dist.destroy_process_group()

if __name__ == "__main__":
    main()
'''


# ---------------------------------------------------------------------------
# official-notebook-cell: 6/7 ("Run Benchmark Evaluation" / "Compute Official
# Metrics"). jev-change: reads test.jsonl from --export-dir instead of the
# HF `test` split, via the same row-shape (state/questions/gold JSON-string
# columns) the export writes.
# ---------------------------------------------------------------------------
def evaluate_checkpoint(output_dir, export_dir, laya_module):
    import numpy as np

    ece_score = laya_module.common.ece_score
    agent_ft = laya_module.Agent(output_dir, device="cuda")

    test_path = Path(export_dir) / "test.jsonl"
    predictions = []
    latencies_ms = []
    with test_path.open(encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]

    for row in rows:
        state = json.loads(row["state"])
        questions = json.loads(row["questions"])
        gold = json.loads(row["gold"])
        t0 = time.perf_counter()
        res = agent_ft.predict(state, questions)
        dt_ms = (time.perf_counter() - t0) * 1000
        latencies_ms.append(dt_ms)
        predictions.append({"pred": res["answers"], "gold": gold, "questions": questions, "latency_ms": dt_ms})

    accuracies, soft_accuracies, brier_scores, kl_divs, tv_distances = [], [], [], [], []
    score_maes, within_one, all_confs, all_corrects = [], [], [], []

    for item in predictions:
        pred_answers, gold_answers, questions = item["pred"], item["gold"], item["questions"]
        for qid, qdef in questions.items():
            p_ans, g_ans = pred_answers[qid], gold_answers[qid]
            q_type = qdef["type"]
            if q_type == "choice":
                keys = list(qdef["criteria"].keys())
                pred_choice = p_ans["choice"]
                gold_label = str(g_ans["label"])
                is_corr = float(pred_choice == gold_label)
                accuracies.append(is_corr); all_corrects.append(is_corr)
                p_probs = np.array([p_ans["probabilities"].get(k, 1e-6) for k in keys])
                g_probs = np.array([g_ans["probabilities"].get(k, 1e-6) for k in keys])
                p_probs /= p_probs.sum(); g_probs /= g_probs.sum()
                all_confs.append(float(p_probs.max()))
                soft_accuracies.append(float((p_probs * g_probs).sum()))
                brier_scores.append(float(((p_probs - g_probs) ** 2).sum()))
                tv_distances.append(float(0.5 * np.abs(p_probs - g_probs).sum()))
                kl_divs.append(float((g_probs * np.log(np.clip(g_probs / p_probs, 1e-12, 1e4))).sum()))
            elif q_type == "noul":
                p_val = p_ans["noul"]
                g_val = g_ans.get("noul", g_ans.get("probabilities", {}).get("true", 0.5))
                gold_label = str(g_ans["label"]).lower()
                pred_label = "true" if p_val >= 0.5 else "false"
                is_corr = float(pred_label == gold_label)
                accuracies.append(is_corr); all_corrects.append(is_corr)
                all_confs.append(float(max(p_val, 1.0 - p_val)))
                p_dist = np.array([1.0 - p_val, p_val])
                g_dist = np.array([1.0 - g_val, g_val])
                soft_accuracies.append(float((p_dist * g_dist).sum()))
                brier_scores.append(float(((p_dist - g_dist) ** 2).sum()))
                tv_distances.append(float(0.5 * np.abs(p_dist - g_dist).sum()))
                kl_divs.append(float((g_dist * np.log(np.clip(g_dist / p_dist, 1e-12, 1e4))).sum()))
            elif q_type == "score":
                p_score = p_ans["score"]
                g_score = g_ans.get("score", 0.0)
                score_maes.append(abs(p_score - g_score))
                within_one.append(float(abs(p_score - g_score) <= 1.0))
                n_levels = len(qdef.get("criteria", []))
                p_probs_score = np.array([p_ans["probabilities"].get(str(i), 0.0) for i in range(n_levels)])
                if p_probs_score.sum() > 0:
                    p_probs_score /= p_probs_score.sum()
                    p_lvl = int(np.argmax(p_probs_score))
                    all_confs.append(float(p_probs_score.max()))
                else:
                    p_lvl = int(round(p_score))
                    all_confs.append(0.5)
                g_lvl = int(g_ans.get("label", int(round(g_score))))
                is_corr = float(p_lvl == g_lvl)
                accuracies.append(is_corr); all_corrects.append(is_corr)

    metrics = {
        "accuracy": round(float(np.mean(accuracies)), 4) if accuracies else None,
        "soft_accuracy": round(float(np.mean(soft_accuracies)), 4) if soft_accuracies else None,
        "brier_score": round(float(np.mean(brier_scores)), 4) if brier_scores else None,
        "ece": round(float(ece_score(np.array(all_confs), np.array(all_corrects))), 4) if all_confs else None,
        "score_mae": round(float(np.mean(score_maes)), 4) if score_maes else 0.0,
        "within_1_level": round(float(np.mean(within_one)), 4) if within_one else 0.0,
        "latency_p50_ms": round(float(np.percentile(latencies_ms, 50)), 1) if latencies_ms else None,
        "latency_p95_ms": round(float(np.percentile(latencies_ms, 95)), 1) if latencies_ms else None,
        "kl_divergence": round(float(np.mean(kl_divs)), 4) if kl_divs else None,
        "total_variation": round(float(np.mean(tv_distances)), 4) if tv_distances else None,
        "n_cases": len(rows),
    }
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--export-dir", required=True, help="exports/<version>/laya folder with train/calibration/test.jsonl + manifest.json")
    parser.add_argument("--model-dir", default=None, help="Path to a pre-downloaded convaiinnovations/laya snapshot. If omitted, uses huggingface_hub.snapshot_download (network + model download -- do this on Kaggle, not locally).")
    parser.add_argument("--output-dir", required=True, help="Where to write the fine-tuned checkpoint + training_metadata.json")
    parser.add_argument("--max-truncated-fraction", type=float, default=0.02, help="Abort if more than this fraction of question-rows are dropped by tokenizer admission (default 2%%)")
    parser.add_argument("--allow-truncation", action="store_true", help="Proceed even if the truncated fraction exceeds --max-truncated-fraction")
    parser.add_argument("--dry-run", action="store_true", help="Verify export + tokenizer admission and stop before invoking torchrun (no GPU/model needed for the manifest check; still needs laya+tokenizer installed for the admission check)")
    parser.add_argument("--skip-admission-check", action="store_true", help="Skip the tokenizer admission pass entirely (NOT recommended; only for debugging the export-manifest check in isolation)")
    args = parser.parse_args()

    export_dir = Path(args.export_dir)
    output_dir = Path(args.output_dir)
    started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    manifest = verify_export_manifest(export_dir)

    if args.skip_admission_check and not args.dry_run:
        print("[WARN] --skip-admission-check set: proceeding without verifying tokenizer truncation")

    # official-notebook-cell: 3 imports (moved here so --dry-run's manifest-only
    # path above can run without laya/transformers installed).
    try:
        import torch
        from datasets import load_dataset
        from huggingface_hub import snapshot_download
        from laya.agent import _fix_tokenizer_config
        from laya.common import build_sequence, render_options, QTYPES
        import laya as laya_module
    except ImportError as exc:
        die(f"missing dependency ({exc}). Install training/laya-kit/requirements.lock on the training machine (Kaggle), not locally.")

    model_dir = args.model_dir
    if model_dir is None:
        print("[download] no --model-dir given: fetching convaiinnovations/laya via snapshot_download (network)")
        model_dir = snapshot_download("convaiinnovations/laya")
    _fix_tokenizer_config(model_dir)

    tok = AutoTokenizer = __import__("transformers").AutoTokenizer.from_pretrained(os.path.join(model_dir, "tokenizer"))
    with open(os.path.join(model_dir, "rl_agent_config.json")) as f:
        cfg = json.load(f)
    # jev-change: a minimal agent-shaped object exposing only what fit_task_head()/assert_lossless()
    # read (tok, cfg, ._to_internal) -- the same pattern scripts/laya-budget.py's Shim uses, since
    # the notebook's training path never constructs a real laya.agent.Agent.
    import types as _types
    agent_shim = _types.SimpleNamespace(tok=tok, cfg=cfg, _to_internal=laya_module.agent.Agent._to_internal)

    # official-notebook-cell: 3, jev-change described at module top: read the
    # export split files via the manifest's own recorded loader instead of
    # the public HF dataset.
    dataset = load_dataset(
        "json",
        data_files={
            "train": str(export_dir / "train.jsonl"),
            "validation": str(export_dir / "calibration.jsonl"),
            "test": str(export_dir / "test.jsonl"),
        },
    )

    train_items, train_truncated, train_total = preprocess_split(dataset["train"], tok, cfg, render_options, build_sequence, QTYPES, agent_shim)
    calib_items, calib_truncated, calib_total = preprocess_split(dataset["validation"], tok, cfg, render_options, build_sequence, QTYPES, agent_shim)

    if not args.skip_admission_check:
        check_tokenizer_admission(train_truncated + calib_truncated, train_total + calib_total, args.max_truncated_fraction, args.allow_truncation)

    print(f"[preprocess] train: {len(train_items)} sequences ({train_truncated} truncated of {train_total})")
    print(f"[preprocess] calibration: {len(calib_items)} sequences ({calib_truncated} truncated of {calib_total})")

    if not train_items:
        die("no trainable sequences after preprocessing (all truncated or empty train split)")
    if not calib_items:
        die("no usable calibration sequences after preprocessing")

    output_dir.mkdir(parents=True, exist_ok=True)
    train_items_path = output_dir / "train_items.pt"
    calib_items_path = output_dir / "calib_items.pt"
    torch.save(train_items, train_items_path)
    torch.save(calib_items, calib_items_path)

    if args.dry_run:
        print("[dry-run] export + tokenizer admission verified. Stopping before torchrun.")
        return 0

    ddp_script_path = output_dir / "train_ddp.py"
    ddp_script_path.write_text(TRAIN_DDP_SCRIPT, encoding="utf-8")

    # official-notebook-cell: 5 ("Launch Multi-GPU Fine-Tuning with torchrun")
    cmd = [
        "torchrun", "--standalone", "--nproc_per_node=2", str(ddp_script_path),
        str(model_dir), str(output_dir), str(train_items_path), str(calib_items_path),
    ]
    print("[train] executing:", " ".join(cmd))
    subprocess.run(cmd, check=True)

    finished_training_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    metrics = None
    try:
        metrics = evaluate_checkpoint(str(output_dir), str(export_dir), laya_module)
    except Exception as exc:  # pragma: no cover - depends on GPU runtime
        print(f"[eval] evaluation step failed or was skipped: {exc}")

    finished_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    # jev-change: the official notebook never writes structured run metadata;
    # docs/TRAINING_DATA.md's promotion flow (qualify -> compare -> promote)
    # needs it to attribute a checkpoint to a specific export + commit.
    training_metadata = {
        "notebook_commit": NOTEBOOK_COMMIT,
        "notebook_upstream_contract": EXPECTED_UPSTREAM_CONTRACT,
        "laya_version_pinned": LAYA_VERSION_PINNED,
        "export_dataset_version": manifest.get("dataset_version"),
        "export_source_data_sha256": manifest.get("source_data_sha256"),
        "export_sample_count": manifest.get("sample_count"),
        "hyperparameters": {
            "epochs": 4, "micro_batch": 8, "grad_accum": 4, "group_size": 4,
            "lr_encoder": 2.5e-5, "lr_head": 1.0e-4, "sigma_start": 0.4, "sigma_end": 0.1,
            "weight_decay": 0.01, "max_len": cfg.get("max_len", 1024), "head_max_len": cfg.get("head_max_len", 256),
        },
        "train_sequences": len(train_items),
        "train_truncated": train_truncated,
        "calibration_sequences": len(calib_items),
        "calibration_truncated": calib_truncated,
        "started_at": started_at,
        "finished_training_at": finished_training_at,
        "finished_at": finished_at,
        "metrics": metrics,
        "trained": True,
    }
    (output_dir / "training_metadata.json").write_text(json.dumps(training_metadata, indent=2), encoding="utf-8")
    print(f"[done] wrote {output_dir / 'training_metadata.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
