# S5.R application shutdown policy

This implementation policy fills the normal-shutdown lifecycle gap using the existing S0 states and transitions. It does not change the frozen SQL, DTOs, signatures, queue identities or recovery ownership rules.

| Event | Required outcome |
| --- | --- |
| Unclaimed `QUEUED` Run at normal shutdown | Preserve its Run ID, submission key, deadline, occurrence link and zero attempts. The next controller resumes admission on that same identity. |
| Already admitted `RESOLVING` / `RUNNING` Run | Stop new claims. Allow five seconds for natural completion when the execution service begins draining. Preserve the actual success, failure or Task timeout. |
| Execution drain window expires | Request coordinated application interruption. Reap the child tree, restore materialized assets, verify source and persist `INTERRUPTED / EXECUTION_INTERRUPTED` before releasing the owner and Workspace FDs. Leave `cancel_requested=0`. Unproven cleanup remains `RECOVERY_REQUIRED`. |
| Explicit user cancellation | Persist user intent and retain existing coordinated `CANCELLED` semantics; application shutdown does not erase that intent. |
| Task timeout | Retain the Task's configured timeout and actual supervisor reason. A timeout already terminating a child remains `TIMEOUT`; the application drain window is a separate event. |
| Controller `SIGKILL` / owner loss | Retain inherited FD ownership until descendants have stopped. A new controller performs the existing safe recovery to `INTERRUPTED`, or retains `RECOVERY_REQUIRED` when cleanup cannot be proved. Never automatically rerun an already started unknown execution. |

The five-second execution window is not permission to release a live child's lease. It also does not promise that every application shutdown finishes within five seconds. HTTP admission closes first; already admitted HTTP handlers drain before execution ownership and the database are closed. Asset operations retain their existing safety checks and operation deadlines.

HTTP shutdown stops listening immediately and closes idle keep-alive connections. Active transports receive a five-second drain window, after which only this application's sockets are destroyed. An aborted connection is not cancellation of its admitted side effects: tracked async handlers and accepted background backup operations must settle before SQLite closes. Git synchronization, Task execution and notification/runtime services close through their respective owners. Recovery handlers cannot restart producers once application closing has begun.

The current application has paginated HTTP log polling. It exposes no WebSocket, SSE or independent long-polling endpoint; tests must identify the transport they actually exercise.

Set `ZHIXU_V2_SHUTDOWN_DIAGNOSTICS=1` to emit structured lifecycle events on stderr. Events contain monotonic elapsed milliseconds, fixed phase names and aggregate connection/request/handler counts. They contain no request headers, bodies, URLs, ENV values, credentials or tokens. Signal and process-exit events omit counters they do not measure. Diagnostics are optional and do not control cleanup.

S5's original WebKit timeout remains historical failure evidence. A controlled RC10 production CLI also reproduces an unfinished-request shutdown exceeding thirty seconds. This establishes an unbounded HTTP drain defect, without proving that the historical WebKit sample had that exact cause. Closure requires independent production-process browser samples with the context deliberately left open at SIGTERM, plus restart and ownership checks.
