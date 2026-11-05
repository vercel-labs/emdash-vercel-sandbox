"""List registered project worktrees, without reading working-file contents."""
import json
import os
import resource
import subprocess
import tempfile


def git(root, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_OPTIONAL_LOCKS='0',
               GIT_NO_REPLACE_OBJECTS='1', GIT_TERMINAL_PROMPT='0', GIT_NO_LAZY_FETCH='1')
    def bounded():
        resource.setrlimit(resource.RLIMIT_FSIZE, (1024*1024, 1024*1024))
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        p = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
                            '-C', root, *args], stdout=out, stderr=err, env=env,
                           timeout=20, preexec_fn=bounded)
        if p.returncode:
            raise ValueError('Could not list project worktrees')
        out.seek(0)
        return out.read(1024*1024)


def list_worktrees(project='/home/emdash/project', worktrees='/home/emdash/emdash/worktrees'):
    repositories = [project]
    managed = os.path.join(os.path.dirname(worktrees), 'repositories', os.path.basename(project))
    managed_git = os.path.join(managed, '.git')
    if os.path.isdir(managed_git):
        if (os.path.realpath(managed_git) == managed_git
                and git(managed, 'rev-parse', '--show-toplevel')[:-1].decode() == managed
                and git(managed, 'rev-parse', '--path-format=absolute', '--git-common-dir')[:-1].decode() == managed_git
                and git(managed, 'config', '--get', 'remote.origin.url')[:-1].decode() == project):
            repositories.append(managed)
    result = []
    for repository in repositories:
        for record in git(repository, 'worktree', 'list', '--porcelain', '-z').split(b'\0\0'):
            fields = record.split(b'\0')
            entry = next((f[9:].decode() for f in fields if f.startswith(b'worktree ')), None)
            if not entry or (entry != project and not entry.startswith(worktrees + '/')):
                continue
            if os.path.realpath(entry) != entry or not os.path.isdir(entry):
                continue
            branch = next((f[7:].decode() for f in fields if f.startswith(b'branch ')), None)
            result.append(dict(path=entry, branch=branch))
    if len(result) > 1000:
        raise ValueError('Too many worktrees; select an exact task path')
    return result


if __name__ == '__main__':
    print(json.dumps(list_worktrees(), ensure_ascii=True))
