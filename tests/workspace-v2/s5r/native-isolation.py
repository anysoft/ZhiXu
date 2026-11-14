#!/usr/bin/env python3
"""Native UID10001 qualification with private identity, tmpfs and loopback net.

This reuses the ENOSPC launcher's exact nonce/inode ownership, held namespace FD,
pidfd cleanup and durable retained evidence. It never changes host identities or
mounts, creates global users, or injects NSS/LD_PRELOAD into the application.
"""
import importlib.util
import pathlib
import sys

support = pathlib.Path(__file__).resolve().parent.parent / "s1b/linux-bounded-run.py"
spec = importlib.util.spec_from_file_location("s5r_native_isolation_support", support)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.argv[1:1] = ["--native-identity", "--loopback-network", "--private-tmp64"]
sys.exit(module.main())
