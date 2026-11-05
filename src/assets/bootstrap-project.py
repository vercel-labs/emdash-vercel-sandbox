"""Prepare a project privately and atomically expose only a valid Git repository."""
import hashlib
import os
import runpy
import subprocess
import sys
import tempfile


def git(*args):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
                             '-c', 'user.name=Emdash Sandbox', '-c', 'user.email=emdash-sandbox@example.invalid',
                             *args], env=env, capture_output=True, timeout=120)
    if result.returncode:
        raise ValueError('Project Git preparation failed: ' + args[0])
    return result.stdout.decode().strip()


def valid_project(directory, branch, head=None):
    if os.path.islink(directory) or not os.path.isdir(os.path.join(directory, '.git')):
        raise ValueError('Existing project is not a conventional Git repository; preserve it and move it aside before retrying setup')
    try:
        actual = git('-C', directory, 'rev-parse', '--verify', 'HEAD^{commit}')
        actual_branch = git('-C', directory, 'symbolic-ref', '--short', 'HEAD')
    except ValueError as error:
        raise ValueError('Existing project is incomplete; preserve it and move it aside before retrying setup') from error
    if (head and actual != head) or actual_branch != branch:
        raise ValueError('Existing project differs from the saved import; it was preserved')
    return actual


def prepare_project(destination, bundle=None, branch='main', head=None, bundle_sha=None, after_init=None):
    destination = os.path.abspath(destination)
    if os.path.realpath(destination) != destination:
        raise ValueError('Project destination must be canonical')
    if os.path.lexists(destination):
        if not os.path.isdir(destination) or os.path.islink(destination):
            raise ValueError('Project destination must be a directory')
        if os.listdir(destination):
            valid_project(destination, branch, head)
            return
    git('check-ref-format', '--branch', branch)
    staging = tempfile.mkdtemp(prefix='.emdash-project-setup-', dir=os.path.dirname(destination))
    try:
        if bundle:
            with open(bundle, 'rb') as source:
                if hashlib.file_digest(source, 'sha256').hexdigest() != bundle_sha:
                    raise ValueError('Saved repository bundle checksum mismatch')
            git('clone', '--template=', '--branch', branch, bundle, staging)
        else:
            git('init', '--template=', '-b', branch, staging)
            if after_init:
                after_init(staging)
            with open(os.path.join(staging, 'README.md'), 'x') as readme:
                readme.write('# Sandbox project\n')
            git('-C', staging, 'add', 'README.md')
            git('-C', staging, 'commit', '-m', 'Create remote project')
        valid_project(staging, branch, head)
        if os.path.lexists(destination):
            os.rmdir(destination)
        publish = runpy.run_path(os.path.join(os.path.dirname(__file__), 'publish-export.py'))['publish']
        publish(staging, destination)
    except BaseException:
        print('Project setup staging retained: ' + staging, file=sys.stderr)
        raise


if __name__ == '__main__':
    try:
        if len(sys.argv) == 2:
            prepare_project(sys.argv[1])
        elif len(sys.argv) == 6:
            prepare_project(*sys.argv[1:])
        else:
            raise ValueError('Expected project directory and optional bundle, branch, commit, checksum')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
