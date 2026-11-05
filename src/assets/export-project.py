"""Bounded Git export. Requires Python 3 and Git; no third-party packages.

Only refs/history, the index and nonignored working files are exported. Hooks,
config, reflogs, ignored files and submodule repositories are not copied. Keep
writers idle during export; detected concurrent changes fail the operation.
Requires committed, nonshallow SHA-1 history and a full (nonsplit, nonsparse)
index. Ignored files and repository-local config are deliberately excluded.
"""
import base64
import json
import os
import resource
import re
import unicodedata
import stat
import subprocess
import sys
import tempfile

MIB = 1024 * 1024
LIMITS = dict(bundle=32*MIB, index=4*MIB, file=8*MIB, content=32*MIB,
              manifest=100*MIB, entries=20000, history=128*MIB, objects=100000)
ROOTS = ('/home/emdash/project', '/home/emdash/emdash/worktrees')
ENV = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
ENV.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
           GIT_OPTIONAL_LOCKS='0', GIT_NO_REPLACE_OBJECTS='1', GIT_TERMINAL_PROMPT='0', GIT_NO_LAZY_FETCH='1')


def git(root, *args, limit=4*MIB, input=None):
    # File-backed capture bounds child output without buffering an unbounded pipe.
    def bounded_child():
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        result = subprocess.run(['git', '-c', 'core.fsmonitor=false', '-c',
                                 'core.hooksPath=/dev/null', '-C', root, *args],
                                input=input, stdout=out, stderr=err, env=ENV,
                                timeout=90, preexec_fn=bounded_child)
        out.seek(0)
        data = out.read(limit+1)
        if result.returncode or len(data) > limit:
            raise ValueError('Git command failed or exceeded export bounds: ' + args[0])
        return data


def folded(value):
    return re.sub('[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]', '', unicodedata.normalize('NFD', value).lower())


def safe_path(value):
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > 4096:
        raise ValueError('Unsafe path')
    for part in value.split('/'):
        if (part in ('', '.', '..') or '\x00' in part or '\\' in part or ':' in part
                or part.rstrip(' .') != part or folded(part) in ('.git', 'git~1')):
            raise ValueError('Unsafe path: ' + repr(value))
    return value


def safe_link(name, target):
    if not target or target.startswith('/') or '\x00' in target or '\\' in target or ':' in target:
        raise ValueError('Unsafe symlink')
    resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
    safe_path(resolved) if resolved != '.' else None
    if any(folded(p) in ('.git', 'git~1') for p in target.split('/')):
        raise ValueError('Unsafe symlink into .git')


def read_entry(root_fd, name):
    parts = safe_path(name).split('/')
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except (FileNotFoundError, NotADirectoryError):
                return None
            os.close(fd)
            fd = child
        try:
            before = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if stat.S_ISDIR(before.st_mode):
            return None
        if stat.S_ISLNK(before.st_mode):
            target = os.readlink(parts[-1], dir_fd=fd)
            safe_link(name, target)
            return dict(path=name, type='symlink', target=target)
        if not stat.S_ISREG(before.st_mode) or before.st_size > LIMITS['file']:
            raise ValueError('Unsupported file type or file exceeds 8 MiB: ' + repr(name))
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, 'rb') as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError('File changed during export')
            data = source.read(LIMITS['file']+1)
            after = os.fstat(source.fileno())
        signature = lambda s: (s.st_ino, s.st_dev, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(data) > LIMITS['file'] or signature(before) != signature(opened) or signature(opened) != signature(after):
            raise ValueError('File changed during export or exceeds limit')
        return dict(path=name, type='file', mode=0o755 if before.st_mode & 0o111 else 0o644,
                    data=base64.b64encode(data).decode('ascii'))
    finally:
        os.close(fd)


def create_manifest(selection, roots=ROOTS):
    if (not os.path.isabs(selection) or os.path.realpath(selection) != selection
            or not any(selection == r or selection.startswith(r + '/') for r in roots)):
        raise ValueError('Select an exact absolute Git worktree under an allowed root')
    def members(repository):
        return [x[9:].decode('utf-8') for x in git(repository, 'worktree', 'list', '--porcelain', '-z').split(b'\0')
                if x.startswith(b'worktree ')]
    registered = members(roots[0])
    if selection not in registered:
        managed = os.path.join(os.path.dirname(roots[1]), 'repositories', os.path.basename(roots[0]))
        managed_git = os.path.join(managed, '.git')
        if (os.path.isdir(managed_git) and os.path.realpath(managed_git) == managed_git
                and git(managed, 'rev-parse', '--show-toplevel')[:-1].decode() == managed
                and git(managed, 'rev-parse', '--path-format=absolute', '--git-common-dir')[:-1].decode() == managed_git
                and git(managed, 'config', '--get', 'remote.origin.url')[:-1].decode() == roots[0]):
            registered = members(managed)
    if selection not in registered:
        raise ValueError('Selected path is not a registered project worktree')
    if git(selection, 'rev-parse', '--show-toplevel')[:-1].decode() != selection:
        raise ValueError('Selected path is not the exact worktree root')
    if git(selection, 'rev-parse', '--show-object-format').strip() != b'sha1':
        raise ValueError('Export currently requires a SHA-1 Git repository')
    if git(selection, 'rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('Shallow history cannot be exported as complete history')
    if git(selection, 'rev-parse', '--shared-index-path').strip():
        raise ValueError('Split index is unsupported; disable it before export')
    head = git(selection, 'rev-parse', '--verify', 'HEAD').strip().decode('ascii')
    branch = git(selection, 'rev-parse', '--symbolic-full-name', 'HEAD').strip().decode('utf-8')
    branch = None if branch == 'HEAD' else branch
    refs = git(selection, 'show-ref', '--head')
    index_path = git(selection, 'rev-parse', '--path-format=absolute', '--git-path', 'index')[:-1].decode()
    def read_index():
        try:
            with open(index_path, 'rb') as source:
                data = source.read(LIMITS['index']+1)
            if len(data) > LIMITS['index']:
                raise ValueError('Index exceeds 4 MiB')
            return data
        except FileNotFoundError:
            return None
    index = read_index()
    staged = git(selection, 'ls-files', '--stage', '-z')
    object_ids = set()
    records = staged.split(b'\0')[:-1]
    if len(records) > LIMITS['entries']:
        raise ValueError('Too many index entries')
    for record in records:
        metadata, raw_name = record.split(b'\t', 1)
        mode, oid, stage = metadata.split(b' ')
        safe_path(raw_name.decode('utf-8'))
        if mode not in (b'100644', b'100755', b'120000'):
            raise ValueError('Submodules and sparse directory indexes are unsupported')
        object_ids.add(oid)
    total = 0
    blobs = []
    for oid in sorted(object_ids):
        data = git(selection, 'cat-file', 'blob', oid.decode(), limit=LIMITS['file'])
        total += len(data)
        if total > LIMITS['content']:
            raise ValueError('Index and working content exceed 32 MiB')
        blobs.append(dict(oid=oid.decode(), data=base64.b64encode(data).decode('ascii')))
    history = git(selection, 'rev-list', '--objects', '--no-object-names', '--single-worktree', '--all', 'HEAD', limit=8*MIB).splitlines()
    if len(history) > LIMITS['objects']:
        raise ValueError('History exceeds object count bound')
    sizes = git(selection, 'cat-file', '--batch-check=%(objectsize)', input=b'\n'.join(history)+b'\n')
    if sum(int(size) for size in sizes.splitlines()) > LIMITS['history']:
        raise ValueError('History exceeds 128 MiB expanded size')
    # Shared refs remain complete; omit other worktrees' private HEAD pseudo-refs.
    bundle = git(selection, 'bundle', 'create', '--version=2', '-', '--single-worktree', '--all', 'HEAD', limit=LIMITS['bundle'])
    names = sorted(set(git(selection, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0')[:-1]))
    if len(names) > LIMITS['entries']:
        raise ValueError('Too many working file entries')
    entries = []
    root_fd = os.open(selection, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for raw_name in names:
            entry = read_entry(root_fd, raw_name.decode('utf-8'))
            if entry is not None:
                total += len(base64.b64decode(entry['data'])) if entry['type'] == 'file' else len(entry['target'].encode())
                if total > LIMITS['content']:
                    raise ValueError('Index and working content exceed 32 MiB')
                entries.append(entry)
    finally:
        os.close(root_fd)
    if index != read_index() or refs != git(selection, 'show-ref', '--head') or head != git(selection, 'rev-parse', 'HEAD').strip().decode():
        raise ValueError('Git state changed during export; pause writers and retry')
    result = dict(version=1, selection=selection, head=head, branch=branch,
                  bundle=base64.b64encode(bundle).decode('ascii'),
                  index=base64.b64encode(index).decode('ascii') if index is not None else None,
                  indexBlobs=blobs, entries=entries)
    encoded = json.dumps(result, ensure_ascii=True, separators=(',', ':'))
    if len(encoded) > LIMITS['manifest']:
        raise ValueError('Manifest exceeds 100 MiB')
    return encoded


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Expected one exact absolute worktree path')
        print(create_manifest(sys.argv[1]))
    except Exception as error:
        print('Export failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
