// Frontend regression with controlled API responses, not a backup or Git installation qualification.
// Build the v2 frontend first. Set ZHIXU_PLAYWRIGHT_MODULE / ZHIXU_BROWSER_EXECUTABLE if needed.
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { chromium } = require(process.env.ZHIXU_PLAYWRIGHT_MODULE ||
  'playwright');
(async () => {
  const root = path.resolve('static/dist-v2');
  const server = http.createServer((req, res) => {
    let file = path.join(root, new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
      file = path.join(root, 'index.html');
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'application/javascript'
        : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.html')
        ? 'text/html'
        : 'application/octet-stream',
    );
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ZHIXU_BROWSER_EXECUTABLE
      ? { executablePath: process.env.ZHIXU_BROWSER_EXECUTABLE }
      : {}),
  });
  try {
    for (const scenario of [
      'tracking',
      'backup-failure',
      'remote-copy',
      'stale-source',
      'manual-export',
      'copy-failure',
      'history',
    ]) {
      const context = await browser.newContext({ locale: 'zh-CN' }),
        page = await context.newPage();
      page.setDefaultTimeout(15000);
      let started = scenario !== 'tracking',
        polls = 0,
        backed = false,
        creates = 0,
        backupCalls = 0;
      const run = {
        id: 7,
        workspace_id: 1,
        status: 'BLOCKED',
        phase: 'COMPLETE',
        error_code: 'DIVERGED',
        before_commit: 'a'.repeat(40),
        target_commit: 'b'.repeat(40),
      };
      const ws = {
        id: 1,
        name: 'fixture',
        type: 'GIT',
        version: 1,
        source_generation: 1,
        content_revision: 1,
        lifecycle_state: 'READY',
        storage_state: 'PRESENT',
        git: { repository_id: 1, ref_type: 'branch', ref_name: 'main' },
        capabilities: {
          git: true,
          sync: true,
          write_files: true,
          read_files: true,
        },
      };
      await page.route('**/api/**', async (route) => {
        const r = route.request(),
          p = new URL(r.url()).pathname;
        let data = [];
        if (p === '/api/system')
          data = { mode: 'v2', initialized: true, ready: true };
        else if (p === '/api/user') data = { username: 'fixture' };
        else if (p === '/api/workspaces/1')
          data = {
            ...ws,
            content_revision: scenario === 'stale-source' && backed ? 2 : 1,
          };
        else if (p.endsWith('/sync-policy'))
          data = { version: 1, enabled: true, mode: 'MANUAL' };
        else if (p.endsWith('/git/status'))
          data = { clean: true, head: run.before_commit, changed_files: [] };
        else if (p.endsWith('/sync') && r.method() === 'POST') {
          started = true;
          data = { ...run, status: 'QUEUED', error_code: null };
        } else if (p.endsWith('/sync-runs/7'))
          data =
            scenario === 'tracking' && ++polls < 2
              ? { ...run, status: 'RUNNING', error_code: null }
              : run;
        else if (p.endsWith('/sync-history'))
          data = { items: started ? [run] : [] };
        else if (p === '/api/backups' && r.method() === 'POST') {
          backupCalls++;
          data = { id: 'backup-op', status: 'QUEUED' };
        } else if (p === '/api/backups/operations/backup-op') {
          backed = true;
          data =
            scenario === 'backup-failure'
              ? { status: 'FAILED', error_code: 'BACKUP_OPERATION_BUSY' }
              : { status: 'SUCCESS', result: 'snapshot-1' };
        } else if (p === '/api/backups/snapshot-1')
          data = {
            workspaces: [
              { workspace_id: 1, source_generation: 1, content_revision: 1 },
            ],
          };
        else if (p === '/api/workspaces' && r.method() === 'POST') {
          assert.ok(backed);
          assert.equal(backupCalls, 1);
          const b = r.postDataJSON();
          assert.equal(b.git.ref_name, 'main');
          assert.equal(b.discovery.enabled, false);
          creates++;
          data = {
            workspace: { id: 2 },
            operation: { id: 'create-op', status: 'PENDING' },
          };
        } else if (p === '/api/workspaces/2/operations/create-op')
          data =
            scenario === 'copy-failure'
              ? { status: 'FAILED', error_code: 'FETCH_FAILED' }
              : { status: 'SUCCESS' };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: 200, data }),
        });
      });
      await page.goto(
        'http://127.0.0.1:' +
          server.address().port +
          '/workspaces/1?tab=' +
          (scenario === 'history' ? 'sync-history' : 'git'),
      );
      if (scenario === 'history') {
        await page.getByRole('button', { name: '#7', exact: true }).click();
      }
      if (scenario === 'tracking')
        await page
          .getByRole('button', { name: '立即同步', exact: true })
          .click();
      await page.getByText('DIVERGED', { exact: true }).waitFor();
      assert.ok(scenario !== 'tracking' || polls >= 2);
      await page
        .getByRole('button', { name: '选择处理方式', exact: true })
        .click();
      const modal = page.getByRole('dialog');
      if (scenario === 'history') {
        await modal
          .getByRole('button', { name: '保留本地，暂不更新', exact: true })
          .click();
        assert.equal(backupCalls, 0);
      } else if (scenario === 'tracking') {
        await modal
          .getByRole('button', { name: '保留本地，暂不更新', exact: true })
          .click();
        assert.equal(backupCalls, 0);
        await page.getByText('DIVERGED', { exact: true }).waitFor();
      } else {
        await modal
          .getByLabel(
            scenario === 'manual-export'
              ? '导出后人工合并'
              : '备份后创建远端副本',
            { exact: true },
          )
          .check();
        await modal
          .getByRole('button', { name: '先创建完整备份', exact: true })
          .click();
        if (scenario === 'backup-failure') {
          await modal
            .getByText('BACKUP_OPERATION_BUSY', { exact: true })
            .waitFor();
          assert.equal(creates, 0);
          assert.equal(
            await modal
              .getByRole('button', { name: '确认创建远端副本', exact: true })
              .count(),
            0,
          );
        } else {
          await modal
            .getByRole('link', {
              name: '前往系统设置 → 备份与恢复，导出此备份',
              exact: true,
            })
            .waitFor();
          if (scenario === 'manual-export') assert.equal(creates, 0);
          else {
            const create = modal.getByRole('button', {
              name: '确认创建远端副本',
              exact: true,
            });
            assert.ok(await create.isDisabled());
            await modal.getByRole('checkbox').check();
            await create.click();
            if (scenario === 'stale-source') {
              await modal
                .getByText('SOURCE_SUPERSEDED', { exact: true })
                .waitFor();
              assert.equal(creates, 0);
            } else {
              await modal
                .getByRole('link', { name: '查看新工作区', exact: true })
                .waitFor();
              assert.equal(creates, 1);
              if (scenario === 'copy-failure')
                await modal
                  .getByText('FETCH_FAILED', { exact: true })
                  .waitFor();
            }
          }
        }
      }
      console.log('PASS', scenario);
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
