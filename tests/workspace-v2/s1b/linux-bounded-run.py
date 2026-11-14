#!/usr/bin/env python3
"""Run native Linux qualification inside one owned private mount namespace.

This is test infrastructure, not an application/runtime installer. The caller
supplies an unused private receipt path and an absolute Node test command after
"--". Source/App DATA stays on the host filesystem; only the dedicated 32MiB
backup fault filesystem is tmpfs. No host mount or user account is changed.
"""
import argparse
import ctypes
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import pwd
import grp
import stat
import re
import functools

BUDGET = 32 * 1024 * 1024
MARKER = ".s1b-bounded-volume-owner.json"
CANCELLATION_SIGNALS = {signal.SIGTERM, signal.SIGHUP, signal.SIGINT}


def sync_native_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def native_signal_boundary(function):
    @functools.wraps(function)
    def run(*args, **kwargs):
        previous = {sig: signal.getsignal(sig) for sig in CANCELLATION_SIGNALS}
        original_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set())

        def cancel(signum, _frame):
            # Finish exact owned-process cleanup even if the caller repeats
            # its cancellation. SIGKILL remains outside a userspace guarantee.
            for sig in CANCELLATION_SIGNALS:
                signal.signal(sig, signal.SIG_IGN)
            error = KeyboardInterrupt("NATIVE_TOOL_CANCELLED_" + signal.Signals(signum).name)
            error.native_signal = signal.Signals(signum).name
            raise error

        try:
            for sig in CANCELLATION_SIGNALS:
                signal.signal(sig, cancel)
            return function(*args, **kwargs)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            signal.pthread_sigmask(signal.SIG_SETMASK, original_mask)

    return run


def write_private(path, data, exclusive=False):
    path = pathlib.Path(path)
    temporary = path.with_name("." + path.name + ".tmp-" + uuid.uuid4().hex)
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as out:
            json.dump(data, out, indent=2)
            out.write("\n")
            out.flush()
            os.fsync(out.fileno())
        if exclusive:
            os.link(temporary, path, follow_symlinks=False)
        else:
            current = path.lstat()
            if path.is_symlink() or current.st_uid != os.getuid() or current.st_nlink != 1:
                raise RuntimeError("S1B_RECEIPT_IDENTITY_UNSAFE")
            os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
        sync_native_directory(path.parent)


def mountinfo():
    return pathlib.Path("/proc/self/mountinfo").read_bytes()


def identity_snapshot():
    result = {}
    for name in ["/etc/passwd", "/etc/group"]:
        p = pathlib.Path(name)
        st = p.lstat()
        if not stat.S_ISREG(st.st_mode) or p.is_symlink() or st.st_nlink != 1:
            raise RuntimeError("S5R_HOST_IDENTITY_NOT_REGULAR")
        result[name] = {"dev": st.st_dev, "ino": st.st_ino,
                        "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
    return result


def native_identity_user(spec_file):
    spec = json.loads(pathlib.Path(spec_file).read_text())
    root = pathlib.Path(spec["root"])
    st = root.lstat()
    assert not root.is_symlink() and (st.st_dev, st.st_ino) == (spec["dev"], spec["ino"])
    assert os.getuid() == os.geteuid() == spec["uid"] == 10001
    assert os.getgid() == os.getegid() == spec["gid"] == 10001
    user, group = pwd.getpwuid(10001), grp.getgrgid(10001)
    assert user.pw_name == group.gr_name == "zhixus5r"
    assert user.pw_dir == spec["home"]
    status = dict(line.split(":", 1) for line in pathlib.Path("/proc/self/status").read_text().splitlines() if ":" in line)
    for key in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]:
        assert int(status[key].strip(), 16) == 0
    assert status["NoNewPrivs"].strip() == "1"
    proof = {"uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(),
             "pid": os.getpid(), "account": user.pw_name, "home": user.pw_dir,
             "capabilities": {key: status[key].strip() for key in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]},
             "no_new_privileges": True, "mount_namespace": os.readlink("/proc/self/ns/mnt"),
             "network_namespace": os.readlink("/proc/self/ns/net"),
             "private_identity": identity_snapshot()}
    for name in ["passwd", "group"]:
        assert proof["private_identity"]["/etc/" + name]["sha256"] == spec["identity_sha256"][name]
    write_private(root / ".native-user-proof.json", proof, exclusive=True)
    if spec["cwd"]:
        os.chdir(spec["cwd"])
    os.execve(spec["command"][0], spec["command"], dict(os.environ))


def inside(spec_file):
    # Allocation/Popen is a short blocked-signal critical section in the
    # parent. Restore delivery in this fresh interpreter before any mounts.
    signal.pthread_sigmask(signal.SIG_UNBLOCK, CANCELLATION_SIGNALS)
    spec = json.loads(pathlib.Path(spec_file).read_text())
    root = pathlib.Path(spec["root"])
    st = root.lstat()
    assert not root.is_symlink()
    assert (st.st_dev, st.st_ino) == (spec["dev"], spec["ino"])
    libc = ctypes.CDLL(None, use_errno=True)

    def mount(source, target, kind, flags, data):
        if libc.mount(source, target, kind, flags, data):
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))

    # MS_REC | MS_PRIVATE. Every subsequent mount is namespace-local.
    mount(None, b"/", None, 16384 | 262144, None)
    if spec.get("native_identity"):
        for name in ["passwd", "group"]:
            target = os.fsencode("/etc/" + name)
            mount(os.fsencode(root / "identity" / name), target, None, 4096, None)
            mount(None, target, None, 4096 | 32 | 1 | 2 | 4 | 8, None)
    if spec.get("private_tmp64"):
        mount(b"tmpfs", b"/tmp", b"tmpfs", 2 | 4,
              b"size=64m,mode=1777")
    network = None
    if spec.get("loopback_network"):
        import socket
        subprocess.run([spec["ip"], "link", "set", "dev", "lo", "up"], check=True,
                       env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"})
        assert socket.if_nameindex() == [(1, "lo")]
        routes = pathlib.Path("/proc/net/route").read_text().strip().splitlines()[1:]
        assert not routes
        sock = socket.socket()
        sock.settimeout(2)
        try:
            sock.connect(("203.0.113.1", 443))
            raise RuntimeError("S5R_EXTERNAL_NETWORK_UNEXPECTEDLY_REACHABLE")
        except OSError as error:
            if error.errno not in (101, 113):
                raise
            network = {"namespace": os.readlink("/proc/self/ns/net"),
                       "interfaces": socket.if_nameindex(), "ipv4_routes": routes,
                       "actual_external_connect_errno": error.errno}
        finally:
            sock.close()
    bounded = root / "bounded"
    options = "size=%d,mode=0700,uid=%d,gid=%d" % (
        BUDGET, spec["uid"], spec["gid"])
    mount(b"tmpfs", os.fsencode(bounded), b"tmpfs", 2 | 4 | 8,
          options.encode("ascii"))
    bs = bounded.stat()
    namespace = os.readlink("/proc/self/ns/mnt")
    marker = {"version": 1, "purpose": "S1B_OWNED_BOUNDED_TMPFS",
              "nonce": spec["nonce"], "root": str(bounded),
              "uid": spec["uid"], "dev": bs.st_dev, "ino": bs.st_ino,
              "namespace": namespace, "capacity_bytes": BUDGET,
              "provisioner": "PRIVATE_MOUNT_NAMESPACE_LAUNCHER"}
    write_private(bounded / MARKER, marker, exclusive=True)
    os.chown(bounded / MARKER, spec["uid"], spec["gid"])
    write_private(spec["inside_receipt"], {
        "pid": os.getpid(), "namespace": namespace, "bounded_fs": marker,
        "network": network,
        "identity": identity_snapshot() if spec.get("native_identity") else None,
        "private_mounts": [line for line in mountinfo().decode().splitlines()
                           if " " + str(bounded) + " " in line]}, exclusive=True)
    # The parent pins this namespace before any test child can be launched.
    # That makes later process cleanup immune to namespace inode reuse.
    gate = root / ".namespace-pinned.json"
    deadline = time.monotonic() + 10
    while not gate.exists():
        if time.monotonic() >= deadline:
            raise RuntimeError("S1B_NAMESPACE_PARENT_HANDSHAKE_TIMEOUT")
        time.sleep(.02)
    pinned = json.loads(gate.read_text())
    gs = gate.lstat()
    assert not gate.is_symlink() and gs.st_nlink == 1 and gs.st_uid == 0
    assert pinned == {"nonce": spec["nonce"], "namespace": namespace,
                      "parent_pid": spec["parent_pid"]}
    env = {} if spec.get("native_identity") else dict(os.environ)
    env.update(spec.get("environment", {}))
    env.update({"TMPDIR": spec["tmpdir"], "HOME": spec["home"],
                "PATH": spec["path"], "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                "XDG_CONFIG_HOME": str(pathlib.Path(spec["home"]) / ".config"),
                "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_TERMINAL_PROMPT": "0", "PIP_CONFIG_FILE": "/dev/null",
                "npm_config_userconfig": "/dev/null",
                "npm_config_globalconfig": "/dev/null",
                "npm_config_cache": str(root / "npm-cache"),
                "ZHIXU_S1B_BOUNDED_FS_ROOT": str(bounded),
                "ZHIXU_S1B_BOUNDED_FS_NONCE": spec["nonce"]})
    target = [sys.executable, str(pathlib.Path(__file__).resolve()),
              "--as-user", str(root / "user-spec.json")] if spec.get("native_identity") else spec["command"]
    args = ["/usr/bin/setpriv", "--reuid=" + str(spec["uid"]),
            "--regid=" + str(spec["gid"]), "--clear-groups",
            "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all",
            "--no-new-privs", *target]
    os.execve(args[0], args, env)


def namespace_pids(namespace):
    result = []
    for entry in pathlib.Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if os.readlink(entry / "ns/mnt") == namespace:
                result.append(int(entry.name))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    return result


def signal_owned(namespace, pid, sig):
    # A pidfd pins this exact process against PID reuse. The held namespace FD
    # prevents namespace inode reuse while proving this task's process domain.
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("S1B_NAMESPACE_CLEANUP_PIDFD_REQUIRED")
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        if os.readlink("/proc/%d/ns/mnt" % pid) != namespace:
            raise RuntimeError("S1B_NAMESPACE_PROCESS_IDENTITY_CHANGED")
        signal.pidfd_send_signal(fd, sig)
    except (FileNotFoundError, ProcessLookupError):
        pass
    finally:
        os.close(fd)


def stop_namespace_processes(namespace, forced, grace=8):
    end = time.monotonic() + grace
    while namespace_pids(namespace) and time.monotonic() < end:
        time.sleep(.05)
    for sig in [signal.SIGTERM, signal.SIGKILL]:
        for pid in namespace_pids(namespace):
            forced.append({"pid": pid, "signal": sig.name})
            signal_owned(namespace, pid, sig)
        end = time.monotonic() + 3
        while namespace_pids(namespace) and time.monotonic() < end:
            time.sleep(.05)
    if namespace_pids(namespace):
        raise RuntimeError("S1B_OWNED_NAMESPACE_PROCESSES_REMAIN")


@native_signal_boundary
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--nonce", required=True)
    parser.add_argument("--uid", type=int, default=10001)
    parser.add_argument("--gid", type=int, default=10001)
    parser.add_argument("--native-identity", action="store_true")
    parser.add_argument("--loopback-network", action="store_true")
    parser.add_argument("--private-tmp64", action="store_true")
    parser.add_argument("--execution-root")
    parser.add_argument("--execution-nonce")
    parser.add_argument("--execution-marker", default=".s5r-owner.json")
    parser.add_argument("--home")
    parser.add_argument("--tmpdir")
    parser.add_argument("--cwd")
    parser.add_argument("--path")
    parser.add_argument("--env", action="append", default=[])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        parser.error("native Linux root is required only for the private mount setup")
    if len(args.nonce) != 32 or any(c not in "0123456789abcdef" for c in args.nonce):
        parser.error("nonce must be 32 lowercase hexadecimal characters")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or not pathlib.Path(command[0]).is_absolute():
        parser.error("an absolute test executable is required after --")
    if min(args.uid, args.gid) < 1 or not pathlib.Path("/usr/bin/setpriv").is_file():
        parser.error("a non-root test UID/GID and existing setpriv are required")
    if args.native_identity and (args.uid != 10001 or args.gid != 10001):
        parser.error("native identity qualification uses actual UID/GID10001")
    ip = shutil.which("ip", path="/usr/sbin:/usr/bin:/sbin:/bin")
    if args.loopback_network and not ip:
        parser.error("existing iproute2 is required; no global install is performed")
    execution = None
    if args.execution_root:
        execution = pathlib.Path(args.execution_root)
        es = execution.lstat()
        if execution.resolve() != execution or not execution.is_dir() or es.st_uid != args.uid or es.st_mode & 0o077:
            parser.error("execution root must be exact canonical owned UID10001 mode0700")
        if not re.fullmatch(r"[a-f0-9]{32}", args.execution_nonce or "") or "/" in args.execution_marker:
            parser.error("execution root requires its existing explicit nonce and marker basename")
        ep = execution / args.execution_marker
        em = ep.lstat()
        owner = json.loads(ep.read_text())
        if ep.is_symlink() or em.st_nlink != 1 or em.st_uid not in (0, args.uid) or em.st_mode & 0o077:
            parser.error("execution owner marker is not private")
        if owner.get("root") != str(execution) or owner.get("nonce") != args.execution_nonce or (owner.get("dev"), owner.get("ino")) != (es.st_dev, es.st_ino):
            parser.error("execution root nonce/device/inode mismatch")
    elif args.home or args.tmpdir or args.cwd:
        parser.error("custom HOME/TMPDIR/cwd require an independently owned execution root")
    for value in [args.home, args.tmpdir, args.cwd]:
        if value:
            p = pathlib.Path(value)
            if p.resolve() != p or not p.is_dir() or not p.is_relative_to(execution):
                parser.error("execution path must be canonical and inside its exact owned root")
    if args.native_identity and args.home and any(c in args.home for c in (":", "\n", "\r", "\0")):
        parser.error("identity HOME contains an invalid passwd field character")
    environment = {}
    for setting in args.env:
        key, separator, value = setting.partition("=")
        if not separator or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key) or key.startswith(("LD_", "DYLD_", "NSS_")) or key in ("HOME", "TMPDIR", "PATH", "SSH_AUTH_SOCK", "NODE_OPTIONS") or "\0" in value:
            parser.error("unsupported controlled environment override")
        environment[key] = value
    receipt = pathlib.Path(args.receipt).absolute()
    if receipt.exists() or receipt.is_symlink() or not receipt.parent.is_dir():
        parser.error("receipt must be a new file in the caller's owned private evidence directory")
    parent = receipt.parent.lstat()
    if receipt.parent.resolve() != receipt.parent or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        parser.error("receipt parent must be canonical, privately owned, mode0700")
    before = mountinfo()
    identity_before = identity_snapshot() if args.native_identity else None
    # No cancellation can land between allocating an unmarked directory and
    # entering its cleanup boundary, or between Popen and recording the child.
    original_mask = signal.pthread_sigmask(signal.SIG_BLOCK, CANCELLATION_SIGNALS)
    root = pathlib.Path(tempfile.mkdtemp(prefix=("zhixu-s5r-native-" if args.native_identity else "zhixu-s1b-bounded-") + args.nonce[:12] + "-",
                                        dir="/var/tmp"))
    st = root.stat()
    spec = {"purpose": "S1B_NATIVE_PRIVATE_NAMESPACE_TEST", "nonce": args.nonce,
            "root": str(root), "dev": st.st_dev, "ino": st.st_ino,
            "uid": args.uid, "gid": args.gid, "command": command,
            "parent_pid": os.getpid(),
            "inside_receipt": str(receipt) + ".inside.json"}
    spec.update({"native_identity": args.native_identity,
                 "loopback_network": args.loopback_network,
                 "private_tmp64": args.private_tmp64, "ip": ip,
                 "home": args.home or str(root / "home"),
                 "tmpdir": args.tmpdir or str(root / "tmp"),
                 "cwd": args.cwd, "environment": environment,
                 "path": args.path or str(pathlib.Path(command[0]).parent) + ":/usr/bin:/bin:/usr/sbin:/sbin"})
    spec["cwd"] = args.cwd or spec["home"]
    if args.native_identity:
        spec["purpose"] = "S5R_NATIVE_PRIVATE_NAMESPACE_QUALIFICATION_TOOL"
    journal = {**spec, "status": "ALLOCATED",
               "host_mountinfo_before_sha256": hashlib.sha256(before).hexdigest(),
               "host_identity_before": identity_before}
    try:
        write_private(root / ".owner.json", spec, exclusive=True)
        for name in ["bounded", "tmp", "home", "npm-cache"]:
            p = root / name
            p.mkdir(mode=0o700)
            os.chown(p, args.uid, args.gid)
        if args.native_identity:
            identity = root / "identity"
            identity.mkdir(mode=0o700)
            texts = {"passwd": "root:x:0:0:root:/nonexistent:/usr/sbin/nologin\nzhixus5r:x:10001:10001:S5R isolated:" + spec["home"] + ":/usr/sbin/nologin\n",
                     "group": "root:x:0:\nzhixus5r:x:10001:\n"}
            spec["identity_sha256"] = {}
            for name, text in texts.items():
                p = identity / name
                fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o444)
                with os.fdopen(fd, "w") as f:
                    f.write(text)
                    f.flush()
                    os.fsync(f.fileno())
                spec["identity_sha256"][name] = hashlib.sha256(text.encode()).hexdigest()
            write_private(root / "user-spec.json", spec, exclusive=True)
            os.chmod(root / "user-spec.json", 0o444)
            # The root-only launch spec includes hashes only after creating the
            # private account files. It never copies host account contents.
            write_private(root / ".owner.json", spec)
        os.chown(root, args.uid, args.gid)
        journal.update(spec)
        write_private(receipt, journal, exclusive=True)
    except BaseException:
        current = root.lstat()
        assert not root.is_symlink() and (current.st_dev, current.st_ino) == (spec["dev"], spec["ino"])
        assert shutil.rmtree.avoids_symlink_attacks
        shutil.rmtree(root)
        raise
    namespace_fd = None
    namespace = None
    forced = []
    try:
        child = subprocess.Popen(["/usr/bin/unshare", "--mount", *(["--net"] if args.loopback_network else []), "--", sys.executable,
                                  str(pathlib.Path(__file__).resolve()), "--inside", str(root / ".owner.json")])
    except BaseException as error:
        current = root.lstat()
        assert (current.st_dev, current.st_ino) == (spec["dev"], spec["ino"])
        shutil.rmtree(root)
        journal.update({"status": "FAIL_TOOL_START",
                        "error_type": type(error).__name__, "owned_root_removed": True})
        write_private(receipt, journal)
        raise
    try:
        journal["child_pid"] = child.pid
        signal.pthread_sigmask(signal.SIG_SETMASK, original_mask)
        inside_receipt = pathlib.Path(spec["inside_receipt"])
        while child.poll() is None and namespace_fd is None:
            if inside_receipt.exists():
                info = json.loads(inside_receipt.read_text())
                assert info["pid"] == child.pid
                namespace = info["namespace"]
                journal["namespace"] = namespace
                try:
                    namespace_fd = os.open("/proc/%d/ns/mnt" % info["pid"], os.O_RDONLY)
                    assert os.readlink("/proc/%d/ns/mnt" % child.pid) == namespace
                    write_private(root / ".namespace-pinned.json", {
                        "nonce": spec["nonce"], "namespace": namespace,
                        "parent_pid": spec["parent_pid"]}, exclusive=True)
                except FileNotFoundError:
                    pass
            time.sleep(.02)
        code = child.wait()
        journal["test_exit_code"] = code
        if namespace:
            stop_namespace_processes(namespace, forced)
        journal["remaining_owned_namespace_pids"] = namespace_pids(namespace) if namespace_fd is not None else None
        archive = pathlib.Path(str(receipt) + ".retained.tar.gz")
        journal["retained_archive"] = str(archive)
        fd = os.open(archive, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as out:
            with tarfile.open(fileobj=out, mode="w:gz", compresslevel=1) as tar:
                # Symlinks/FIFOs are recorded, not followed or extracted.
                tar.add(root, arcname=root.name, recursive=True)
            out.flush()
            os.fsync(out.fileno())
        # The durable archive name, not only its contents, must precede
        # destruction of the sole source tree.
        sync_native_directory(archive.parent)
        archive_hash = hashlib.sha256()
        with archive.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                archive_hash.update(block)
        journal.update({"retained_sha256": archive_hash.hexdigest(),
                        "retained_bytes": archive.stat().st_size,
                        "retained_archive_durable": True})
        write_private(receipt, journal)
        if namespace_fd is not None:
            released_fd = namespace_fd
            namespace_fd = None
            os.close(released_fd)
        current = root.lstat()
        owner = json.loads((root / ".owner.json").read_text())
        assert not root.is_symlink() and root.resolve() == root
        assert (current.st_dev, current.st_ino) == (spec["dev"], spec["ino"])
        assert owner["nonce"] == args.nonce and shutil.rmtree.avoids_symlink_attacks
        shutil.rmtree(root)
        after = mountinfo()
        identity_after = identity_snapshot() if args.native_identity else None
        user_proof = root / ".native-user-proof.json"
        # The archive has already preserved this file before removing the root.
        # Read from the retained tar without extracting any path or link.
        native_user = None
        if args.native_identity:
            with tarfile.open(archive, "r:gz") as saved:
                member = saved.getmember(root.name + "/.native-user-proof.json")
                assert member.isfile() and member.size < 65536
                native_user = json.load(saved.extractfile(member))
        result = {**journal, "test_exit_code": code, "forced_owned_process_cleanup": forced,
                  "remaining_owned_namespace_pids": journal["remaining_owned_namespace_pids"],
                  "host_mountinfo_before_sha256": hashlib.sha256(before).hexdigest(),
                  "host_mountinfo_after_sha256": hashlib.sha256(after).hexdigest(),
                  "host_mountinfo_unchanged": before == after,
                  "host_identity_before": identity_before,
                  "host_identity_after": identity_after,
                  "host_identity_unchanged": identity_before == identity_after,
                  "native_user": native_user,
                  "owned_root_removed": not root.exists(),
                  "retained_archive": str(archive), "retained_sha256": archive_hash.hexdigest(),
                  "retained_bytes": archive.stat().st_size,
                  "status": "PASS" if code == 0 and not forced and before == after and identity_before == identity_after else "FAIL"}
        write_private(receipt, result)
        return 0 if result["status"] == "PASS" else 1
    except BaseException as error:
        # Retain the allocated root if evidence export or cleanup cannot be
        # completed safely. Its exact identity remains in the private receipt.
        cleanup_errors = []
        remaining = journal.get("remaining_owned_namespace_pids")
        if namespace_fd is not None and namespace:
            try:
                stop_namespace_processes(namespace, forced, grace=0)
                remaining = namespace_pids(namespace)
            except BaseException as cleanup_error:
                cleanup_errors.append({"phase": "namespace_cleanup", "error_type": type(cleanup_error).__name__,
                                       "error_message": str(cleanup_error)})
        journal.update({"status": "FAIL_TOOL_OR_CLEANUP",
                        "error_type": type(error).__name__,
                        "error_message": str(error),
                        "received_signal": getattr(error, "native_signal", None),
                        "owned_root_removed": not root.exists(),
                        "namespace": namespace,
                        "forced_owned_process_cleanup": forced,
                        "child_pid": child.pid,
                        "test_exit_code": child.poll(),
                        "remaining_owned_namespace_pids": remaining,
                        "cleanup_errors": cleanup_errors})
        for phase in ("mountinfo", "identity"):
            try:
                if phase == "mountinfo":
                    after = mountinfo()
                    journal["host_mountinfo_after_sha256"] = hashlib.sha256(after).hexdigest()
                    journal["host_mountinfo_unchanged"] = before == after
                else:
                    journal["host_identity_after"] = identity_snapshot() if args.native_identity else None
                    journal["host_identity_unchanged"] = identity_before == journal["host_identity_after"]
            except BaseException as probe_error:
                cleanup_errors.append({"phase": "host_" + phase, "error_type": type(probe_error).__name__,
                                       "error_message": str(probe_error)})
        write_private(receipt, journal)
        raise
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if namespace_fd is not None:
            os.close(namespace_fd)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        inside(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "--as-user":
        native_identity_user(sys.argv[2])
    else:
        sys.exit(main())
