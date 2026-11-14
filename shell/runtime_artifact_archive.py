#!/usr/bin/env python3
"""Validate/extract authenticated Runtime inputs. Never extract through links."""
import os
import posixpath
import shutil
import sys
import tarfile


def inspect(source, prefix):
    entries = {}
    total = 0
    count = 0
    for member in source:
        count += 1
        name = member.name.rstrip('/')
        if count > 200000 or '\\' in name or '\0' in name or name.startswith('/') or any(x in ('', '.', '..') for x in name.split('/')):
            raise ValueError('archive path')
        parts = name.split('/')
        if parts[0] != prefix:
            raise ValueError('archive prefix')
        relative = '/'.join(parts[1:])
        if not relative:
            if not member.isdir():
                raise ValueError('archive root')
            continue
        if relative in entries or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError('archive entry')
        total += member.size
        if member.size < 0 or total > 2 * 1024 * 1024 * 1024:
            raise ValueError('archive limit')
        entries[relative] = member
    if not entries:
        raise ValueError('empty archive')
    for relative, member in entries.items():
        parent = posixpath.dirname(relative)
        while parent:
            if parent in entries and not entries[parent].isdir():
                raise ValueError('non-directory ancestor')
            parent = posixpath.dirname(parent)
        if member.issym() or member.islnk():
            link = member.linkname
            if not link or link.startswith('/') or '\\' in link or '\0' in link:
                raise ValueError('archive link')
            if member.islnk():
                if not link.startswith(prefix + '/'):
                    raise ValueError('archive hardlink')
                target = posixpath.normpath(link[len(prefix) + 1:])
            else:
                target = posixpath.normpath(posixpath.join(posixpath.dirname(relative), link))
            allowed_target = target in entries and (entries[target].isfile() or (member.issym() and entries[target].isdir()))
            if target in ('.', '..') or target.startswith('../') or not allowed_target:
                raise ValueError('archive link escape')
        elif member.isfile():
            # Read complete payload even in validation mode; tar headers alone
            # do not establish that a compressed or sparse input is complete.
            consumed = 0
            with source.extractfile(member) as reader:
                while True:
                    chunk = reader.read(1024 * 1024)
                    if not chunk:
                        break
                    consumed += len(chunk)
            if consumed != member.size:
                raise ValueError('truncated archive')
    return entries


def run(mode, archive, prefix, destination=None):
    with tarfile.open(archive, 'r:*') as source:
        entries = inspect(source, prefix)
        if mode == 'validate':
            return
        if mode != 'extract' or not destination or os.path.lexists(destination):
            raise ValueError('destination')
        os.mkdir(destination, 0o700)
        for relative, member in entries.items():
            target = os.path.join(destination, relative)
            os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
            if member.isdir():
                os.makedirs(target, mode=0o700, exist_ok=True)
            elif member.isfile():
                with source.extractfile(member) as reader, open(target, 'xb') as writer:
                    shutil.copyfileobj(reader, writer)
                os.chmod(target, 0o700 if member.mode & 0o111 else 0o600)
        for relative, member in entries.items():
            target = os.path.join(destination, relative)
            if member.issym():
                os.symlink(member.linkname, target)
            elif member.islnk():
                os.link(os.path.join(destination, member.linkname[len(prefix) + 1:]), target)


if __name__ == '__main__':
    try:
        run(*sys.argv[1:])
    except Exception:
        sys.stderr.write('RUNTIME_ARTIFACT_ARCHIVE_INVALID\n')
        sys.exit(1)
