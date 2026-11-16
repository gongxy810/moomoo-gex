"""Deployment transaction tests using isolated fake commands, never live services."""
import unittest,os,sys,json,tarfile,subprocess,hashlib,shlex
from tempfile import TemporaryDirectory
from pathlib import Path
SCRIPT=Path(__file__).resolve().parents[1]/'cloud/pull-release.sh'

@unittest.skipIf(os.name=='nt','Bash deployment runs on the Linux server')
class DeployTests(unittest.TestCase):
    def exercise(self,good):
        with TemporaryDirectory(prefix='gex-deploy-test-') as temp:
            home=Path(temp);root=home/'gex-cloud';bins=home/'bin';bins.mkdir()
            for d in ['repo/.git','releases/old/cloud','runtime/node/bin','old-python']:(root/d).mkdir(parents=True)
            fixture=home/'fixture'/'Gex heatmap v3';(fixture/'cloud').mkdir(parents=True)
            (fixture/'requirements.txt').write_text('');(fixture/'cloud/gex-board.service').write_text('test')
            (fixture/'cloud/pull-release.sh').write_bytes(SCRIPT.read_bytes())
            archive=home/'fixture.tar'
            with tarfile.open(archive,'w') as tar:tar.add(fixture,arcname='Gex heatmap v3')
            envdir=root/'envs'/hashlib.sha256(b'').hexdigest();(envdir/'bin').mkdir(parents=True)
            (envdir/'ready').touch()
            def executable(path,text):path.write_text(text);path.chmod(0o755)
            executable(envdir/'bin/python','#!/bin/sh\nif [ "$1" = "-m" ]; then exit 0; fi\nexec '+shlex.quote(sys.executable)+' "$@"\n')
            executable(root/'runtime/node/bin/node','#!/bin/sh\nexit 0\n')
            executable(bins/'git','#!/bin/sh\ncase "$3" in rev-parse) echo new;; archive) cat '+shlex.quote(str(archive))+';; esac\n')
            executable(bins/'sleep','#!/bin/sh\nexit 0\n')
            result={'relay':True,'currentOnDisk':True,'webRoot':str(root/'releases'/('new' if good else 'old')/'web')}
            executable(bins/'curl','#!/bin/sh\nprintf %s '+shlex.quote(json.dumps(result))+'\n')
            executable(bins/'sudo','#!/bin/sh\necho "$*" >> '+shlex.quote(str(home/'sudo.log'))+'\n'+('exit 0\n' if good else 'case "$*" in *restart*) if [ ! -f '+shlex.quote(str(home/'failed'))+' ]; then touch '+shlex.quote(str(home/'failed'))+'; exit 1; fi;; esac\nexit 0\n'))
            (root/'current').symlink_to(root/'releases/old');(root/'python').symlink_to(root/'old-python');(root/'deployed-sha').write_text('old')
            run=subprocess.run(['bash',str(SCRIPT)],env={**os.environ,'HOME':str(home),'PATH':str(bins)+os.pathsep+os.environ['PATH']},capture_output=True)
            self.assertEqual(run.returncode,0 if good else 1,run.stderr.decode())
            self.assertEqual((root/'current').resolve(),root/'releases'/('new' if good else 'old'))
            self.assertEqual((root/'deployed-sha').read_text().strip(),'new' if good else 'old')
            if not good:self.assertEqual((root/'python').resolve(),root/'old-python')
    def test_healthy_new_release_is_published(self):self.exercise(True)
    def test_failed_restart_and_old_process_health_roll_back(self):self.exercise(False)

if __name__=='__main__':unittest.main()
