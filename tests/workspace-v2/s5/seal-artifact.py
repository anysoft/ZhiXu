#!/usr/bin/env python3
"""Hash every release entry and create a deterministic private review archive.

The caller separately proves source/build identity. This tool seals actual bytes,
permissions and internal symlink targets; a lockfile alone is not a byte manifest.
It never writes to the release root or publishes the resulting archive.
"""
import argparse
import gzip
import hashlib
import json
import os
import pathlib
import stat
import tarfile
import uuid


def artifact_entries(root):
    rows = []

    def visit(directory):
        for item in sorted(directory.iterdir(), key=lambda file: file.name):
            info = item.lstat()
            row = {'path': item.relative_to(root).as_posix(),
                   'mode': stat.S_IMODE(info.st_mode)}
            if stat.S_ISLNK(info.st_mode):
                target = os.readlink(item)
                if os.path.isabs(target) or not item.resolve().is_relative_to(root):
                    raise ValueError('RELEASE_SYMLINK_ESCAPES_ROOT')
                row.update(type='symlink', target=target)
            elif stat.S_ISDIR(info.st_mode):
                row['type'] = 'directory'
            elif stat.S_ISREG(info.st_mode):
                digest = hashlib.sha256()
                with item.open('rb') as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                row.update(type='file', bytes=info.st_size, sha256=digest.hexdigest())
            else:
                raise ValueError('RELEASE_SPECIAL_FILE_FORBIDDEN')
            rows.append(row)
            if row['type'] == 'directory':
                visit(item)

    visit(root)
    return rows


def verify_artifact_archive(archive, expected):
    observed = []
    with tarfile.open(archive, mode='r|gz') as reader:
        for member in reader:
            row = {'path': member.name, 'mode': member.mode}
            if member.isdir():
                row['type'] = 'directory'
            elif member.issym():
                row.update(type='symlink', target=member.linkname)
            elif member.isfile():
                digest = hashlib.sha256()
                with reader.extractfile(member) as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                row.update(type='file', bytes=member.size, sha256=digest.hexdigest())
            else:
                raise ValueError('ARCHIVE_SPECIAL_ENTRY_FORBIDDEN')
            observed.append(row)
    if observed != expected:
        raise ValueError('ARCHIVE_CONTENT_MANIFEST_MISMATCH')


def artifact_seal_main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--output-dir', type=pathlib.Path, required=True)
    parser.add_argument('--source-date-epoch', type=int, required=True)
    args = parser.parse_args()
    root, output = args.root, args.output_dir
    if (not root.is_absolute() or root.resolve() != root or root.is_symlink()
            or not root.is_dir() or not output.is_absolute()
            or output.resolve() != output or output.is_relative_to(root)
            or len(args.candidate) != 40
            or any(char not in '0123456789abcdef' for char in args.candidate)
            or args.source_date_epoch < 0):
        raise ValueError('EXPLICIT_CANONICAL_RELEASE_AND_FRESH_OUTPUT_REQUIRED')
    output.mkdir(mode=0o700)
    identity = output.stat()
    owner = {'stage': 'S5', 'purpose': 'PRIVATE_SEALED_RELEASE_ARCHIVE',
             'nonce': uuid.uuid4().hex, 'dev': identity.st_dev, 'ino': identity.st_ino}
    marker = output / '.s5-owner.json'
    marker.write_text(json.dumps(owner, indent=2) + '\n')
    marker.chmod(0o600)
    entries = artifact_entries(root)
    archive = output / 'release.tar.gz'
    with archive.open('xb') as destination:
        with gzip.GzipFile(filename='', mode='wb', fileobj=destination,
                           mtime=0, compresslevel=6) as compressor:
            with tarfile.open(fileobj=compressor, mode='w|', format=tarfile.PAX_FORMAT) as tar:
                for entry in entries:
                    record = tarfile.TarInfo(entry['path'])
                    record.uid = record.gid = 0
                    record.uname = record.gname = ''
                    record.mtime = args.source_date_epoch
                    record.mode = entry['mode']
                    if entry['type'] == 'directory':
                        record.type = tarfile.DIRTYPE
                        tar.addfile(record)
                    elif entry['type'] == 'symlink':
                        record.type = tarfile.SYMTYPE
                        record.linkname = entry['target']
                        tar.addfile(record)
                    else:
                        record.size = entry['bytes']
                        with (root / entry['path']).open('rb') as source:
                            tar.addfile(record, source)
    archive.chmod(0o600)
    if artifact_entries(root) != entries:
        raise ValueError('RELEASE_CHANGED_WHILE_SEALING')
    verify_artifact_archive(archive, entries)
    encoded = json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode()
    digest = hashlib.sha256()
    with archive.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    proof = {'candidate_git_sha': args.candidate,
             'source_identity_scope': 'CALLER_VERIFIED_SEPARATELY',
             'full_content_manifest_sha256': hashlib.sha256(encoded).hexdigest(),
             'archive_sha256': digest.hexdigest(), 'archive_bytes': archive.stat().st_size,
             'source_date_epoch': args.source_date_epoch,
             'archive_owner_normalized': True, 'gzip_timestamp': 0,
             'input_root_modified': False,
             'archive_content_manifest_verified': True,
             'entry_count': len(entries),
             'file_count': sum(entry['type'] == 'file' for entry in entries),
             'file_bytes': sum(entry.get('bytes', 0) for entry in entries),
             'symlink_count': sum(entry['type'] == 'symlink' for entry in entries),
             'entries': entries,
             'sealer_sha256': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}
    result = output / 'sealed-release.json'
    result.write_text(json.dumps(proof, indent=2, ensure_ascii=False) + '\n')
    result.chmod(0o600)
    print(json.dumps({key: value for key, value in proof.items() if key != 'entries'}))


if __name__ == '__main__':
    artifact_seal_main()
