"""Publish the active V4 project into its GitHub folder; CI gates the board UI deploy."""
import argparse, fnmatch, os, re, shutil, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_URL = 'https://github.com/gongxy810/moomoo-gex.git'
TARGET_NAME = 'Gex heatmap v4'

def git_path():
    found = shutil.which('git')
    if found: return found
    for candidate in (Path(os.environ.get('LOCALAPPDATA',''))/'Programs/Git/cmd/git.exe', Path('C:/Program Files/Git/cmd/git.exe')):
        if candidate.exists(): return str(candidate)
    raise RuntimeError('Git for Windows is required.')

def run(args, cwd=None, check=True):
    options = {'cwd': cwd, 'stdout': subprocess.PIPE, 'stderr': subprocess.PIPE, 'check': check}
    if os.name == 'nt': options['creationflags'] = subprocess.CREATE_NO_WINDOW
    result = subprocess.run(args, **options)
    if result.stdout and sys.stdout: sys.stdout.write(result.stdout.decode(errors='replace'))
    if result.stderr and sys.stderr: sys.stderr.write(result.stderr.decode(errors='replace'))
    return result

def ignored(rel, patterns):
    return any(fnmatch.fnmatch(rel, p) or (p.endswith('/') and (rel == p[:-1] or rel.startswith(p))) for p in patterns)

def sources():
    patterns = [p.strip() for p in (ROOT/'.gitignore').read_text(encoding='utf-8').splitlines() if p.strip() and not p.lstrip().startswith('#')]
    for parent, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in {'.git','.venv','node_modules','data','dist','__pycache__','browser-artifacts'}]
        for name in files:
            path = Path(parent)/name
            rel = path.relative_to(ROOT).as_posix()
            if path.is_symlink(): raise RuntimeError('Refusing to publish a symlink: '+rel)
            if not ignored(rel, patterns): yield path, rel

def publish(message):
    git = git_path()
    workspace = ROOT/'data'/'git-workspace'
    workspace.parent.mkdir(exist_ok=True)
    if not (workspace/'.git').is_dir():
        run([git,'clone','--depth=1','--sparse',REPO_URL,str(workspace)])
        run([git,'-C',str(workspace),'sparse-checkout','set',TARGET_NAME,'.github/workflows'])
        run([git,'-C',str(workspace),'config','user.name','gongxy810'])
        run([git,'-C',str(workspace),'config','user.email','144390746+gongxy810@users.noreply.github.com'])
    if run([git,'-C',str(workspace),'status','--porcelain'],check=True).stdout.strip():
        raise RuntimeError('GitHub staging checkout has uncommitted edits; inspect data/git-workspace first.')
    run([git,'-C',str(workspace),'pull','--ff-only','origin','main'])
    run([git,'-C',str(workspace),'config','core.autocrlf','false'])
    target = workspace/TARGET_NAME
    copied = set()
    secret = re.compile(rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|sb_secret_[A-Za-z0-9_-]{20,}|postgres(?:ql)?://[^\s:]+:[^\s@]+@')
    for source, rel in sources():
        raw = source.read_bytes()
        if secret.search(raw): raise RuntimeError('Potential credential found in '+rel)
        dest = target/rel
        if not dest.resolve().is_relative_to(target.resolve()): raise RuntimeError('Unsafe project path: '+rel)
        dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(raw); copied.add(rel)
    tracked = run([git,'-C',str(workspace),'ls-files','-z','--',TARGET_NAME]).stdout.decode().split('\0')
    for path in filter(None, tracked):
        rel = path[len(TARGET_NAME)+1:]
        dest = (target/rel).resolve()
        if rel not in copied and dest.is_relative_to(target.resolve()) and dest.is_file(): dest.unlink()
    workflow = workspace/'.github'/'workflows'/'gex-v4.yml'
    workflow.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT/'cloud'/'github-actions.yml', workflow)
    run([git,'-C',str(workspace),'add','--',TARGET_NAME,'.github/workflows/gex-v4.yml'])
    if run([git,'-C',str(workspace),'diff','--cached','--quiet'],check=False).returncode:
        run([git,'-C',str(workspace),'commit','-m',message])
    run([git,'-C',str(workspace),'push','origin','main'])
    print('Published V4. GitHub CI tests the checkpoint and stages its UI for deployment.',flush=True)

def fingerprint(): return tuple((rel,p.stat().st_mtime_ns,p.stat().st_size) for p,rel in sources())

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--watch',action='store_true');parser.add_argument('--message',default='Update GEX v4 from VS Code');args=parser.parse_args()
    if not args.watch: publish(args.message)
    else:
        previous=fingerprint();changed=None
        print('Watching V4; saved changes publish after 20 seconds of inactivity.',flush=True)
        while True:
            time.sleep(3);current=fingerprint()
            if current!=previous:previous=current;changed=time.monotonic()
            if changed and time.monotonic()-changed>=20:
                try: publish(args.message);changed=None
                except Exception as error: print(str(error),flush=True);changed=time.monotonic()+40
