'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const ts = require('typescript');
const { inspectToasts } = require('../../scripts/i18n/toasts.cjs');
const { inventory } = require('../../scripts/i18n/check.cjs');
const inspect = (body) =>
  inspectToasts(
    ts.createSourceFile(
      'fixture.tsx',
      `
import { message as toast, notification } from 'antd';
import intl from 'react-intl-universal';
import { t as tr, translateError } from './i18n';
${body}`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    ),
  );

test('toast audit catches raw backend messages and hardcoded text through dynamic severity and aliases', () => {
  const calls = inspect(`
    (ok ? toast.success : toast.warning)(response.data.message);
    toast['error']('Hardcoded text');
    notification.open({message: response.message});
    const raw = response.message; toast.error(raw);
    toast.error(tr(response.message));
  `);
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => !call.localized));
});
test('toast audit accepts localized branches and translated error variables, not backend messages as keys', () => {
  const calls = inspect(`
    (ok ? toast.success : toast.warning)(ok ? tr('ui.repositoryAccessSucceeded') : tr('ui.repositoryAccessFailed'));
    const msg = translateError(response.error_code); notification.error({message: msg});
    toast.success(intl.get('更新成功'));
  `);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.localized));
});
test('all current primary toast messages use localization and repository tests never show raw backend messages', () => {
  const { toasts } = inventory();
  assert.ok(toasts.length >= 45);
  assert.deepEqual(
    toasts.filter((call) => !call.localized),
    [],
  );
  const repository = toasts.find(
    (call) =>
      call.file === 'src/pages/repository/index.tsx' &&
      call.callee.includes('warning'),
  );
  assert.ok(repository);
  assert.doesNotMatch(repository.content, /\.message/);
  for (const locale of ['zh-CN', 'en-US']) {
    const messages = require('../../src/locales/' + locale + '.json');
    assert.ok(messages['ui.repositoryAccessSucceeded']);
    assert.ok(messages['ui.repositoryAccessFailed']);
  }
});
