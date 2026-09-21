"""Offline boundary tests. No model, torch, network, or training is used."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('laya_worker', ROOT / 'workers/laya_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class WorkerBoundaries(unittest.TestCase):
    def assets(self, root):
        for name, content in {'model.safetensors': b'fixture-not-real-weights', 'rl_agent_config.json': b'{}',
                              'encoder/config.json': b'{}', 'tokenizer/tokenizer_config.json': b'{}'}.items():
            p = root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(content)

    def test_fingerprint_reproducible_and_tracks_all_assets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            self.assets(root)
            first = worker.fingerprint(str(root))
            self.assertEqual(first, worker.fingerprint(str(root)))
            (root / 'tokenizer/tokenizer_config.json').write_text('{"changed":true}')
            self.assertNotEqual(first, worker.fingerprint(str(root)))

    def test_missing_assets_remote_code_and_symlinks_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            with self.assertRaises(ValueError): worker.fingerprint(str(root))
            self.assets(root)
            (root / 'encoder/config.json').write_text('{"auto_map":{"AutoModel":"remote.py"}}')
            with self.assertRaises(ValueError): worker.fingerprint(str(root))
            (root / 'encoder/config.json').write_text('{}')
            (root / 'alias').symlink_to(root / 'encoder', target_is_directory=True)
            with self.assertRaises(ValueError): worker.fingerprint(str(root))

    def test_root_symlink_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            target = root / 'assets'
            target.mkdir()
            self.assets(target)
            (root / 'alias').symlink_to(target, target_is_directory=True)
            with self.assertRaises(ValueError): worker.fingerprint(str(root / 'alias'))

    def test_lossless_admission_with_synthetic_tokenizer(self):
        class Tok:
            mask_token = '<mask>'
            def __call__(self, value, **kwargs): return {'input_ids': list(range(len(value)))}
        tok = Tok()
        render = lambda q: list(q['crit'])
        serialize = lambda state: state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
        def build(t, state, q, max_len, head_max):
            count = len('%s question: %s' % (q['t'], q['ins'])) + sum(len(' '+v)+1 for v in render(q)) + len(serialize(state)) + 4
            return list(range(count)), list(range(len(render(q))))
        common = types.ModuleType('laya.common')
        common.render_options, common.serialize_state, common.build_sequence = render, serialize, build
        agent = types.SimpleNamespace(tok=tok, cfg={'max_len':512,'head_max_len':192},
            _to_internal=lambda q: {'t':q['type'],'ins':q['instructions'],'crit':q['criteria']})
        q={'worker':{'type':'choice','instructions':'Pick.','criteria':{'a':None,'b':None}}}
        with patch.dict(sys.modules, {'laya.common':common}):
            worker.assert_lossless(agent,'small',q)
            with self.assertRaises(ValueError): worker.assert_lossless(agent,'x'*1000,q)
            with self.assertRaises(ValueError): worker.assert_lossless(agent,'contains <mask>',q)
            long={'worker':{'type':'choice','instructions':'Pick.','criteria':{'x'*60:None,'b':None}}}
            with self.assertRaises(ValueError): worker.assert_lossless(agent,'small',long)

if __name__ == '__main__':
    unittest.main()
