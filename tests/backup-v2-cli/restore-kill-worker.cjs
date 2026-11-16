// A separate production-JS controller is intentionally killed at the existing journal boundary.
const {
  OfflineBackupManager,
} = require('../../static/build/services/backup/offline');
const [dataRoot, backupRoot, snapshot] = process.argv.slice(2);
const manager = new OfflineBackupManager({
  dataRoot,
  backupRoot,
  fault: async (point) => {
    if (point === 'restore-after-old-rename') {
      process.stdout.write(point + '\n', () =>
        process.kill(process.pid, 'SIGKILL'),
      );
      await new Promise(() => {});
    }
  },
});
manager.restoreSnapshot(snapshot).then(
  () => {
    process.stderr.write('EXPECTED_CRASH_POINT_NOT_REACHED\n');
    process.exitCode = 2;
  },
  (error) => {
    process.stderr.write(
      String(error.error_code || error.code || 'RESTORE_FAILED') + '\n',
    );
    process.exitCode = 1;
  },
);
