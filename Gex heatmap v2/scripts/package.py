"""Reproducible local companion; excludes environment, captures and credentials."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from shutil import copyfile
root = Path(__file__).resolve().parent.parent
target = root/'dist'/'opend-gex-relay.zip'
target.parent.mkdir(exist_ok=True)
files = [root/name for name in ('opend_board.py', 'relay.py', 'market.py', 'snapshots.py', 'spx_calibration.py', 'providers.py', 'requirements.txt', 'README.txt', 'VALIDATION.md', 'start-windows.cmd')]
files += [p for p in (root/'web').rglob('*') if p.is_file() and p.suffix != '.zip']
files += [p for p in (root/'tradingview').rglob('*') if p.is_file()]
public_closes = root/'data'/'verified-index-closes.json'
if public_closes.is_file():
    files.append(public_closes)  # Public dated close metadata only; never captures or credentials.
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    for path in files:
        archive.write(path, path.relative_to(root))
print(target)
copyfile(target, root/'web'/'opend-gex-relay.zip')

