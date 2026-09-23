"""Optional, offline-only bridge to official laya==0.3.4. No training or model downloading."""
import contextlib
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import sys
import time

MAX_FRAME = 65536

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def read_frame():
    line = sys.stdin.buffer.readline(MAX_FRAME + 1)
    if not line:
        return None
    if len(line) > MAX_FRAME or not line.endswith(b"\n"):
        raise ValueError("FRAME_TOO_LARGE")
    return json.loads(line)

def fingerprint(directory):
    root = Path(directory)
    if not root.is_absolute() or not root.is_dir():
        raise ValueError("LOCAL_MODEL_REQUIRED")
    if any(p.is_symlink() for p in [root, *root.parents]):
        raise ValueError('MODEL_SYMLINK_REFUSED')
    records = []
    # Hash every inference asset, not just the weights; temperature/tokenizer changes alter decisions.
    for p in sorted(root.rglob("*")):
        if p.is_symlink():
            raise ValueError("MODEL_SYMLINK_REFUSED")
        if not p.is_file() or p.suffix not in (".json", ".safetensors", ".txt", ".model"):
            continue
        if p.suffix == ".json":
            cfg = json.loads(p.read_text())
            if isinstance(cfg, dict) and (cfg.get("auto_map") or cfg.get("trust_remote_code")):
                raise ValueError("REMOTE_MODEL_CODE_REFUSED")
        h = hashlib.sha256()
        with p.open("rb") as f:
            for block in iter(lambda: f.read(1024 * 1024), b""):
                h.update(block)
        records.append([p.relative_to(root).as_posix(), h.hexdigest()])
    for rel in ("model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer_config.json"):
        if not (root / rel).is_file():
            raise ValueError("INCOMPLETE_LOCAL_MODEL")
    encoded = json.dumps(records, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()

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

def resolve_precision(init_msg):
    precision = init_msg.get("precision", "fp32")
    if precision not in ("fp32", "fp16"):
        raise ValueError("LAYA_INVALID_PRECISION")
    return precision

def load_agent(model_path, device, precision):
    """Create the Agent, skipping the lossless random-init step when transformers supports it
    (see main() for the B1 evidence), then switch to fp16 weights when requested.

    B2 measured: on MPS, `agent.model.half()` alone crashes the process on first inference
    (MPS matmul assert: destination/accumulator dtype mismatch) because `Agent.system_one` only
    enables `torch.autocast` on CUDA (`use_amp = self.device.type == "cuda"`), so half-precision
    weights hit a full-precision matmul path. `scripts/laya-bench.py`'s `half` mode works around
    this by forcing autocast on for every device; replicated here by monkeypatching
    `laya.agent.torch.autocast` (this mutates the real torch module for this process, since
    laya.agent just holds a reference to it) for the lifetime of the resident worker.
    Verified equivalence: english FP32 vs this fp16 path agree 36/36, max probability delta 0.0074.
    """
    import laya.agent
    laya.agent._fix_tokenizer_config = lambda _: None
    try:
        from transformers.initialization import no_init_weights
    except ImportError:
        no_init_weights = None
    load_mode = "no_init_weights" if no_init_weights is not None else "default"
    ctx = no_init_weights() if no_init_weights is not None else contextlib.nullcontext()
    with ctx:
        agent = laya.agent.Agent(model_path, device=device)
    if precision == "fp16":
        agent.model.half()
        torch = laya.agent.torch
        forced_dtype = torch.float16
        original_autocast = torch.autocast
        def _force_fp16_autocast(device_type, dtype=None, enabled=True, **kw):
            return original_autocast(device_type, dtype=forced_dtype, enabled=True)
        laya.agent.torch.autocast = _force_fp16_autocast
    return agent, load_mode

def main():
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if len(sys.argv) == 3 and sys.argv[1] == "--fingerprint":
        emit({"checkpoint": fingerprint(sys.argv[2]), "model_downloaded": False})
        return
    first = read_frame()
    if first is None:
        return
    c = first["init"]
    version = importlib.metadata.version("laya")
    if version != c["runtimeVersion"] or version != "0.3.4":
        raise ValueError("LAYA_RUNTIME_VERSION_MISMATCH")
    precision = resolve_precision(c)
    actual = fingerprint(c["modelPath"])
    if actual != c["checkpoint"]:
        raise ValueError("LAYA_CHECKPOINT_MISMATCH")
    tc = json.loads((Path(c["modelPath"]) / "tokenizer/tokenizer_config.json").read_text())
    if tc.get("tokenizer_class") in (None, "TokenizersBackend") or isinstance(tc.get("extra_special_tokens"), list):
        raise ValueError("TOKENIZER_PREPARATION_REQUIRED")
    # The official helper edits tokenizer config in place. Runtime model assets are immutable here.
    # B1 measured ~19s of the 24s cold load as random weight init (normal_/trunc_normal_) that
    # load_state_dict(strict=True) overwrites anyway; transformers' own no_init_weights() skips it
    # losslessly (verified: identical FP32 output probabilities, 36/36). Fall back to default init
    # if that helper is unavailable in the installed transformers version.
    load_start = time.monotonic()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        agent, load_mode = load_agent(c["modelPath"], c["device"], precision)
    load_ms = (time.monotonic() - load_start) * 1000
    if str(agent.device).split(":")[0] != c["device"]:
        raise ValueError("DEVICE_FALLBACK_REFUSED")
    identity = {"model": c["model"], "checkpoint": actual, "runtime_version": version,
                "device": str(agent.device), "precision": str(next(agent.model.parameters()).dtype),
                "load_mode": load_mode}
    emit({"ready": True, "identity": identity, "load_ms": round(load_ms, 1)})
    while True:
        msg = read_frame()
        if msg is None:
            break
        try:
            assert_lossless(agent, msg["state"], msg["questions"])
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = agent.system_one(msg["state"], msg["questions"])
            if str(agent.device).split(":")[0] != c["device"]:
                raise ValueError("DEVICE_FALLBACK_REFUSED")
            result["identity"] = identity
            emit({"id": msg["id"], "result": result})
        except ValueError as e:
            code = str(e)
            emit({"id": msg.get("id"), "error": code if code in ("INPUT_TRUNCATED", "INPUT_REWRITE_REFUSED", "DEVICE_FALLBACK_REFUSED") else "LAYA_INFERENCE_REJECTED"})
        except Exception:
            emit({"id": msg.get("id"), "error": "LAYA_INFERENCE_ERROR"})

if __name__ == "__main__":
    try:
        main()
    except Exception:
        emit({"error": "LAYA_STARTUP_REJECTED"})
        sys.exit(2)
