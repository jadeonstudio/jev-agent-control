"""How much task text fits losslessly in a Laya checkpoint for the jev route questions.

Uses the same admission rule as workers/laya_worker.py (assert_lossless): no silent truncation of state.
Prints the largest prefix length (characters) of long English/Korean task texts that still passes.
Offline; tokenizer only (no model weights loaded).

    <laya-venv>/bin/python scripts/laya-budget.py --model-dir /abs/ckpt
"""
import argparse, contextlib, io, json, os, sys
from pathlib import Path

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false")
sys.path.insert(0, str(Path(__file__).resolve().parent))
bench = __import__("laya-bench")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "workers"))
worker = __import__("laya_worker")

EN = ("Implement pagination for the /orders API endpoint. Keep the existing response shape, add cursor-based paging "
      "with a default page size of 50, update the TypeScript client in web/src/api/orders.ts, and add integration tests "
      "covering empty pages, the last page and invalid cursors. Do not change the database schema. ") * 8
KO = ("/orders API 엔드포인트에 페이지네이션을 구현해줘. 기존 응답 형태는 유지하고 기본 페이지 크기 50의 커서 기반 페이징을 추가한 뒤, "
      "web/src/api/orders.ts의 TypeScript 클라이언트를 고치고 빈 페이지·마지막 페이지·잘못된 커서를 다루는 통합 테스트를 추가해줘. "
      "DB 스키마는 바꾸지 마. ") * 8

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--model-dir", required=True); a = ap.parse_args()
    from transformers import AutoTokenizer
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        import laya.agent  # noqa: F401 (common helpers used by assert_lossless)
    cfg = json.loads((Path(a.model_dir) / "rl_agent_config.json").read_text())
    tok = AutoTokenizer.from_pretrained(str(Path(a.model_dir) / "tokenizer"))
    class Shim:  # the parts of Agent that assert_lossless reads
        pass
    agent = Shim(); agent.tok = tok; agent.cfg = cfg; agent._to_internal = laya.agent.Agent._to_internal
    def fits(text):
        try: worker.assert_lossless(agent, bench.state_for(text), bench.ROUTE_QUESTIONS); return True
        except ValueError: return False
    out = {"model_dir": a.model_dir, "max_len": cfg.get("max_len"), "head_max_len": cfg.get("head_max_len")}
    for name, text in (("en", EN), ("ko", KO)):
        lo, hi = 0, len(text)
        while lo < hi:  # largest prefix that passes
            mid = (lo + hi + 1) // 2
            if fits(text[:mid]): lo = mid
            else: hi = mid - 1
        out[f"{name}_max_chars"] = lo
        out[f"{name}_max_bytes"] = len(text[:lo].encode())
    print(json.dumps(out))

if __name__ == "__main__":
    main()
