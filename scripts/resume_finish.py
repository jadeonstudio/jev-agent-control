from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
p = ROOT / 'src/training/dataset.mjs'
s = p.read_text()
old = "c => '" + chr(92) + "u' +"
if old not in s:
    raise RuntimeError('PATCH_BASE_MISMATCH: export unicode escaping')
p.write_text(s.replace(old, 'c => String.fromCharCode(92, 117) +'))
for name in ['AGENTS.md', 'SECURITY.md', 'docs/ARCHITECTURE.md', 'docs/TESTING.md']:
    p = ROOT / name
    p.write_text(p.read_text().rstrip() + '\n')
