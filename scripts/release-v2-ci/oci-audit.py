#!/usr/bin/env python3
"""Validate v2 OCI identity and transport bytes without extracting files to disk.
This is an identity/attestation gate, not a vulnerability or secret scanner.
"""
import hashlib
import json
import pathlib
import re
import sys
import tarfile

archive, arch, sha, out = sys.argv[1:]
assert arch in ('amd64', 'arm64') and re.fullmatch(r'[a-f0-9]{40}', sha)
with tarfile.open(archive) as tar:
    files = [m for m in tar.getmembers() if m.isfile()]
    members = {m.name.removeprefix('./'): m for m in files}
    assert len(members) == len(files), 'DUPLICATE_ARCHIVE_MEMBER'

    def read(name):
        return tar.extractfile(members[name]).read()

    def blob(descriptor):
        digest = descriptor['digest']
        assert re.fullmatch(r'sha256:[a-f0-9]{64}', digest), 'DIGEST_FORMAT'
        member = members['blobs/sha256/' + digest[7:]]
        assert member.size == descriptor['size'], 'BLOB_SIZE'
        # Stream large image layers; never materialize the whole image in memory.
        checksum = hashlib.sha256()
        with tar.extractfile(member) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(chunk)
        assert checksum.hexdigest() == digest[7:], 'BLOB_DIGEST'
        return member

    manifests = []

    def visit(index):
        for descriptor in index['manifests']:
            member = blob(descriptor)
            assert member.size < 32 * 1024 * 1024, 'OVERSIZE_MANIFEST'
            obj = json.loads(tar.extractfile(member).read())
            if 'manifests' in obj:
                visit(obj)
            else:
                manifests.append((descriptor, obj))

    visit(json.loads(read('index.json')))
    images = [(d, m) for d, m in manifests if d.get('platform', {}).get('os') == 'linux'
              and d.get('platform', {}).get('architecture') == arch]
    assert len(images) == 1, 'EXACTLY_ONE_TARGET_IMAGE'
    descriptor, manifest = images[0]
    config_member = blob(manifest['config'])
    cfg = json.loads(tar.extractfile(config_member).read())
    assert cfg['architecture'] == arch and cfg['os'] == 'linux', 'CONFIG_PLATFORM'
    runtime = cfg['config']
    assert runtime['User'] == '10001:10001', 'SERVICE_UID'
    assert runtime['Entrypoint'] == ['/usr/bin/tini', '--', 'node', 'scripts/release-v2/entrypoint.cjs'], 'V2_ENTRYPOINT'
    assert runtime['Healthcheck']['Test'] == ['CMD', 'node', 'scripts/release-v2/healthcheck.cjs'], 'V2_HEALTHCHECK'
    labels = runtime['Labels']
    assert labels['org.opencontainers.image.revision'] == sha, 'SOURCE_IDENTITY'
    assert labels['org.opencontainers.image.version'] == json.load(open('package.json'))['version'], 'VERSION_IDENTITY'
    assert labels['org.zhixu.application-mode'] == 'v2', 'V2_MODE'
    assert re.fullmatch(r'[a-f0-9]{40}', labels['org.zhixu.source-tree']), 'SOURCE_TREE'
    attestations = {}
    attestation_digests = []
    for d, m in manifests:
        if d.get('annotations', {}).get('vnd.docker.reference.digest') != descriptor['digest']:
            continue
        attestation_digests.append(d['digest'])
        blob(m['config'])
        for layer in m['layers']:
            member = blob(layer)
            obj = json.loads(tar.extractfile(member).read())
            kind = obj.get('predicateType', '')
            if 'spdx' in kind:
                attestations['sbom'] = obj
            if 'slsa' in kind:
                attestations['provenance'] = obj
    assert set(attestations) == {'sbom', 'provenance'}, 'ATTESTATIONS_REQUIRED'
    for layer in manifest['layers']:
        blob(layer)
    output = pathlib.Path(out)
    output.mkdir(parents=True, exist_ok=True)
    for key, value in attestations.items():
        (output / (key + '.json')).write_text(json.dumps(value, indent=2) + '\n')
    with open(archive, 'rb') as stream:
        archive_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    result = dict(status='PASS', architecture=arch, commit=sha, application_mode='v2',
                  manifest_digest=descriptor['digest'], config_digest=manifest['config']['digest'],
                  archive_sha256=archive_sha, attestation_digests=attestation_digests,
                  sbom='PASS', provenance='PASS', security_scan='DEFERRED')
    (output / 'image-audit.json').write_text(json.dumps(result, indent=2) + '\n')
