"""Publish this flat v3 folder into its existing GitHub repository subdirectory.

Use --watch for save-to-GitHub synchronization (20s debounce). Authentication is
handled by Git Credential Manager, never by a token in project files.
"""
import argparse,fnmatch,hashlib,os,re,shutil,subprocess,time,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PATTERNS=[s.strip() for s in (ROOT/'.gitignore').read_text().splitlines() if s.strip() and not s.startswith('#')]
def execute(*args,**kwargs):
    if os.name=='nt':kwargs.setdefault('creationflags',subprocess.CREATE_NO_WINDOW)
    if sys.stdout is not None and sys.stdout.fileno()!=1:
        kwargs.setdefault('stdout',sys.stdout);kwargs.setdefault('stderr',sys.stderr)
    return subprocess.run(*args,**kwargs)
def sources():
    patterns=[s.strip() for s in (ROOT/'.gitignore').read_text().splitlines() if s.strip() and not s.startswith('#')]
    for parent,dirs,files in os.walk(ROOT):
        dirs[:]=[d for d in dirs if d not in ('.git','.venv','node_modules','data','dist','__pycache__','browser-artifacts')]
        for name in files:
            p=Path(parent)/name;rel=p.relative_to(ROOT).as_posix()
            if p.is_symlink():raise RuntimeError('Review source symlink before publishing: '+rel)
            if any((rel.startswith(v.rstrip('/')+'/') or ('/'+v.rstrip('/')+'/') in '/'+rel) if v.endswith('/') else fnmatch.fnmatch(rel,v) for v in patterns):continue
            yield p,rel
def git_path():
    found=shutil.which('git')
    if found:return found
    for p in [Path(os.environ.get('LOCALAPPDATA',''))/'Programs/Git/cmd/git.exe',Path('C:/Program Files/Git/cmd/git.exe')]:
        if p.exists():return str(p)
    raise RuntimeError('Install Git for Windows first, then restart VS Code.')
def publish(message):
    guard_path=ROOT/'data/publish.lock';guard_path.parent.mkdir(exist_ok=True)
    with guard_path.open('a+b') as guard:
        guard.seek(0)
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(guard.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:return _publish(message)
        finally:
            guard.seek(0)
            if os.name=='nt':msvcrt.locking(guard.fileno(),msvcrt.LK_UNLCK,1)

def _publish(message):
    git=git_path();os.environ['PATH']=str(Path(git).parent)+os.pathsep+os.environ.get('PATH','');repo=ROOT/'data/git-workspace';repo.parent.mkdir(exist_ok=True)
    def run(*args):return execute([git,*args],cwd=repo if repo.exists() else ROOT,check=True)
    if not (repo/'.git').exists():
        execute([git,'clone','--depth=1','--sparse','https://github.com/gongxy810/moomoo-gex.git',str(repo)],check=True)
        run('sparse-checkout','set','Gex heatmap v3','.github/workflows')
        run('config','user.name','gongxy810');run('config','user.email','144390746+gongxy810@users.noreply.github.com')
    # Refuse to discard edits/conflicts in the staging checkout.
    dirty=execute([git,'status','--porcelain'],cwd=repo,stdout=subprocess.PIPE,check=True).stdout.strip()
    if dirty:raise RuntimeError('Staging checkout has uncommitted files; inspect data/git-workspace before retrying.')
    run('pull','--ff-only','origin','main')
    run('config','core.autocrlf','false')
    target=repo/'Gex heatmap v3'
    copied=set()
    for source,rel in sources():
        raw=source.read_bytes()
        if re.search(rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|sb_secret_[A-Za-z0-9_-]{20,}|postgres(?:ql)?://[^\s:]+:[^\s@]+@',raw):raise RuntimeError('Potential credential in '+rel)
        dest=target/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
        copied.add(rel)
    tracked=execute([git,'ls-files','-z','--','Gex heatmap v3'],cwd=repo,stdout=subprocess.PIPE,check=True).stdout.decode().split('\0')
    for tracked_path in filter(None,tracked):
        rel=tracked_path[len('Gex heatmap v3/'):];dest=(target/rel).resolve()
        if rel not in copied and dest.is_relative_to(target.resolve()) and dest.is_file():dest.unlink()
    workflow=repo/'.github/workflows/gex-v3.yml';workflow.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/'cloud/github-actions.yml',workflow)
    run('add','--','Gex heatmap v3','.github/workflows/gex-v3.yml')
    if execute([git,'diff','--cached','--quiet'],cwd=repo).returncode:
        run('commit','-m',message)
    run('push','origin','main')
    print('Published. GitHub tests gate automatic cloud deployment.',flush=True)
def fingerprint():return tuple((r,p.stat().st_mtime_ns,p.stat().st_size) for p,r in sources())
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--watch',action='store_true');p.add_argument('--message',default='Update GEX v3 from VS Code');a=p.parse_args()
    if not a.watch:publish(a.message)
    else:
        previous=fingerprint();changed=None
        print('Watching v3 sources; save changes to sync after 20 seconds of inactivity.',flush=True)
        while True:
            time.sleep(3);current=fingerprint()
            if current!=previous:previous=current;changed=time.monotonic()
            if changed and time.monotonic()-changed>=20:
                try:
                    # Each batch runs current publisher code, even after editing it.
                    python=str(Path(sys.executable).with_name('python.exe')) if os.name=='nt' else sys.executable
                    execute([python,str(__file__),'--message',a.message],check=True);changed=None
                except Exception as error:print(str(error),flush=True);changed=time.monotonic()+40
