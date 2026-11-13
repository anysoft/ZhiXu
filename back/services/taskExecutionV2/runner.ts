import { performance } from 'perf_hooks';
import path from 'path';
import { ExecutionResult, safeExecutionError } from '../../shared/execution';
import HookExecutor from '../hookExecutor';
import TaskHookLifecycle from '../taskHookLifecycle';
import RunnerV2 from '../runnerV2';
import ExecutionRedactor from '../executionRedactor';
import { RuntimeLease } from '../runtimeProcess';
import { WorkspaceLease } from '../workspaceV2/lease';
import { WorkspaceStore } from '../workspaceV2/store';
import { WorkspaceRootResolver } from '../workspaceV2/roots';
import { FaultHook } from '../workspaceV2/types';
import {
  WorkspaceMaterialization,
  MaterializationRecoveryOwner,
} from './materialization';
import { WorkspaceExecutionPaths } from './paths';
import { WorkspaceExecutionContext } from './types';
import type { TaskWorkspace } from '../configMaterialization';

export interface WorkspaceAttemptRunnerOptions {
  fault?: FaultHook;
  event?: (type: string, metadata: Record<string, unknown>) => Promise<void>;
}

/** Apply the pinned language environment to every hook/supervisor phase too. */
class WorkspaceHookExecutor extends HookExecutor {
  constructor(
    fds: readonly number[],
    private readonly runtime: WorkspaceExecutionContext['runtime'],
  ) {
    super(fds);
  }
  async run(
    program: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv,
    timeoutSeconds: number,
    output: (chunk: string) => Promise<void>,
  ) {
    const clean = { ...environment };
    for (const key of Object.keys(clean)) {
      if (
        /^(?:NODE_PATH|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|PYTHONINSPECT|PYTHONBREAKPOINT|PYTHONEXECUTABLE|BASH_ENV|ENV|LD_.*|DYLD_.*)$/.test(
          key,
        )
      )
        delete clean[key];
    }
    clean.PATH = `${path.dirname(this.runtime.executable)}:/usr/bin:/bin`;
    if (this.runtime.venvRoot) {
      clean.VIRTUAL_ENV = this.runtime.venvRoot;
      clean.PYTHONNOUSERSITE = '1';
    } else delete clean.VIRTUAL_ENV;
    return super.run(program, args, cwd, clean, timeoutSeconds, output);
  }
}

/** Orchestrates existing real Runner, hook supervisor and materialization algorithms. */
export class WorkspaceAttemptRunner {
  readonly paths: WorkspaceExecutionPaths;
  readonly materialization: WorkspaceMaterialization;
  private lifecycle?: TaskHookLifecycle;
  private cancelled = false;
  private wake?: () => void;
  constructor(
    readonly store: WorkspaceStore,
    readonly roots: WorkspaceRootResolver,
    private readonly options: WorkspaceAttemptRunnerOptions = {},
  ) {
    this.paths = new WorkspaceExecutionPaths(store.dataRoot);
    this.materialization = new WorkspaceMaterialization(store, roots, options);
  }
  cancel() {
    this.cancelled = true;
    this.lifecycle?.cancel();
    this.wake?.();
  }
  get isCancelled() {
    return this.cancelled;
  }
  async backoff(seconds: number) {
    if (this.cancelled) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, seconds) * 1000);
      this.wake = finish;
    });
  }
  retry(result: ExecutionResult, context: WorkspaceExecutionContext) {
    return (
      !this.cancelled &&
      result.attempt < context.settings.max_attempts &&
      result.cleanupResult === 'SUCCESS' &&
      (result.status === 'TIMEOUT' ||
        (result.status === 'FAILED' &&
          !!result.primaryError &&
          ['EXIT_NONZERO', 'TIMEOUT', 'HOOK_EXECUTION_FAILED'].includes(
            result.primaryError.code,
          )))
    );
  }
  async recover(
    workspaceId: number,
    lease: WorkspaceLease,
    workspace?: Readonly<TaskWorkspace>,
    owner?: MaterializationRecoveryOwner,
  ) {
    await this.materialization.recover(
      await this.store.workspace(workspaceId),
      lease,
      workspace,
      owner,
    );
  }
  async cleanupRun(runId: number) {
    await this.paths.cleanupRunDirectory(runId);
  }
  async run(
    context: WorkspaceExecutionContext,
    attempt: number,
    lease: WorkspaceLease,
    pins: readonly RuntimeLease[],
    sink: (text: string) => Promise<void>,
    extraFds: readonly number[] = [],
  ): Promise<ExecutionResult> {
    const started = Date.now(),
      monotonic = performance.now();
    const result: ExecutionResult = {
      status: 'RUNNING',
      taskRunId: context.identity.taskRunId,
      attempt,
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      duration: 0,
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      primaryError: null,
      secondaryErrors: [],
      hookResults: [],
      cleanupResult: 'PENDING',
    };
    const cleanup: (() => Promise<void>)[] = [];
    let preparationRecoveryFailed = false;
    let materializationStarted = false;
    const redactor = new ExecutionRedactor([...context.secretValues], sink);
    try {
      await lease.assertHeld();
      if (context.source.workspaceId !== lease.workspaceId)
        throw Error('WORKSPACE_LEASE_REQUIRED');
      await this.materialization.preflight(context);
      const directory = await this.paths.attemptDirectory(
        context.identity.taskRunId,
        attempt,
      );
      cleanup.push(() =>
        this.paths.cleanupRunDirectory(context.identity.taskRunId),
      );
      // Config secrets are pinned private revisions, and enter the streaming
      // redactor before any hook/main output is accepted.
      for (const config of context.configSnapshot)
        if (config.is_secret)
          redactor.add([
            (
              await this.materialization.assets.readRevision(config.revision)
            ).toString('utf8'),
          ]);
      await this.options.fault?.('BEFORE_CONFIG_INJECTION', {
        run_id: result.taskRunId,
        attempt,
      });
      const fds = [
        ...new Set([
          ...lease.processLeaseFds,
          ...pins.map((pin) => pin.handle.fd),
          ...extraFds,
        ]),
      ];
      materializationStarted = true;
      const resources = await this.materialization.prepare(context, lease, fds);
      cleanup.push(resources.cleanup);
      await this.options.fault?.('AFTER_CONFIG_INJECTION', {
        run_id: result.taskRunId,
        attempt,
      });
      const executor = new WorkspaceHookExecutor(fds, context.runtime),
        runner = new RunnerV2(executor);
      this.lifecycle = new TaskHookLifecycle(executor);
      if (this.cancelled) this.lifecycle.cancel();
      await redactor.write(`[ATTEMPT ${attempt}]\n`);
      const execution = await this.lifecycle.run(
        {
          task: { id: context.identity.taskId },
          environment: {
            ...context.environmentSnapshot,
            variables: {
              ...context.environmentSnapshot.variables,
              PLATFORM_TASK_RUN_ID: String(context.identity.taskRunId),
              PLATFORM_TASK_ATTEMPT: String(attempt),
            },
          },
          secretValues: [...context.secretValues],
          workspace: context.workspace,
          hooks: [...context.hookSnapshot],
          directory,
          args: [...context.args],
          mainTimeout: context.settings.timeout_seconds ?? 0,
        },
        (text) => redactor.write(text),
        {
          redactor,
          event: async (type, metadata) => {
            await this.options.event?.(type, { attempt, ...metadata });
          },
          main: async (environment, output) => {
            await this.options.fault?.('BEFORE_RUNNER', {
              run_id: result.taskRunId,
              attempt,
            });
            let observed = false;
            const outcome = await runner.run(
              context,
              environment,
              async (text) => {
                if (!observed) {
                  observed = true;
                  await this.options.fault?.('DURING_RUNNER', {
                    run_id: result.taskRunId,
                    attempt,
                  });
                }
                await output(text);
              },
            );
            await this.options.fault?.('AFTER_CHILD_EXIT', {
              run_id: result.taskRunId,
              attempt,
            });
            return outcome;
          },
        },
      );
      const failures = execution.failures.map((item) => ({
        phase: item.phase,
        code: item.reason,
        ...(item.hook_id ? { hookId: item.hook_id } : {}),
      }));
      result.primaryError = execution.primary
        ? failures.find(
            (item) => `${item.phase}:${item.code}` === execution.primary,
          ) ?? { phase: 'LIFECYCLE', code: 'EXECUTION_FAILED' }
        : null;
      result.secondaryErrors = failures.filter(
        (item) => item !== result.primaryError,
      );
      result.hookResults = execution.hookResults;
      result.exitCode =
        execution.main?.exitCode ?? execution.main?.code ?? null;
      result.signal = execution.main?.signal ?? null;
      result.cancelled =
        this.cancelled || result.primaryError?.code === 'CANCELLED';
      result.timedOut = result.primaryError?.code === 'TIMEOUT';
      result.status = result.cancelled
        ? 'CANCELLED'
        : result.timedOut
        ? 'TIMEOUT'
        : result.primaryError
        ? 'FAILED'
        : 'SUCCESS';
    } catch (error) {
      result.primaryError = {
        phase: 'PREPARE',
        code: safeExecutionError(error),
      };
      result.cancelled = this.cancelled;
      result.status = this.cancelled ? 'CANCELLED' : 'FAILED';
      if (materializationStarted) {
        try {
          await this.recover(context.source.workspaceId, lease);
        } catch (recoveryError) {
          preparationRecoveryFailed = true;
          result.secondaryErrors.push({
            phase: 'CLEANUP',
            code: safeExecutionError(
              recoveryError,
              'WORKSPACE_RECOVERY_REQUIRED',
            ),
          });
        }
      }
    } finally {
      this.lifecycle = undefined;
      result.cleanupResult = preparationRecoveryFailed
        ? 'RECOVERY_REQUIRED'
        : 'SUCCESS';
      if (preparationRecoveryFailed) result.status = 'RECOVERY_REQUIRED';
      try {
        await this.options.fault?.('DURING_CLEANUP', {
          run_id: result.taskRunId,
          attempt,
        });
      } catch (error) {
        const failure = {
          phase: 'CLEANUP',
          code: safeExecutionError(error, 'EXECUTION_FAILED'),
        };
        if (!result.primaryError) result.primaryError = failure;
        else result.secondaryErrors.push(failure);
        if (result.status === 'SUCCESS') result.status = 'FAILED';
      }
      for (const operation of cleanup.reverse()) {
        try {
          await operation();
        } catch (error) {
          const failure = {
            phase: 'CLEANUP',
            code: safeExecutionError(error, 'WORKSPACE_RECOVERY_REQUIRED'),
          };
          if (!result.primaryError) result.primaryError = failure;
          else result.secondaryErrors.push(failure);
          result.cleanupResult = 'RECOVERY_REQUIRED';
          result.status = 'RECOVERY_REQUIRED';
        }
      }
      if (result.primaryError?.code.includes('RECOVERY_REQUIRED')) {
        result.status = 'RECOVERY_REQUIRED';
        result.cleanupResult = 'RECOVERY_REQUIRED';
      }
      result.duration = Math.max(0, Math.round(performance.now() - monotonic));
      result.finishedAt = new Date(started + result.duration).toISOString();
      await redactor.write(`[RESULT ${result.status}]\n`);
      await redactor.flush();
    }
    return result;
  }
}
