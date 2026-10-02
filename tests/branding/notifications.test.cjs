'use strict';
require('reflect-metadata');
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const load = require('../../test/helpers/load-security-module.cjs');
const mocks = {
  '../config/util': {
    parseBody() {
      throw Error('Unexpected provider');
    },
    parseHeaders() {
      throw Error('Unexpected provider');
    },
  },
  './store': { shareStore: { setLang() {} } },
  './user': { __esModule: true, default: class User {} },
};
const language = load('back/shared/i18n.ts', mocks);
mocks['../shared/i18n'] = language;
const { setLang, tf } = language;
const NotificationService = load('back/services/notify.ts', mocks).default;
const nodemailer = require('nodemailer');
test('branded notification templates preserve payload structure and user content in both languages', async () => {
  let sent, mail;
  const service = new NotificationService({
    post: async (url, options) => {
      sent = { url, ...options };
      return { code: 0 };
    },
  });
  const original = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (options) => {
      mail = options;
      return { messageId: 'fixture' };
    },
    close() {},
  });
  try {
    for (const lang of ['zh', 'en']) {
      setLang(lang);
      const label = lang === 'en' ? 'Notification' : '通知';
      for (const type of ['room', 'contact']) {
        await service.testNotify(
          {
            type: 'aibotk',
            aibotkType: type,
            aibotkKey: 'fixture',
            aibotkName: 'recipient',
          },
          'User title',
          'User content',
        );
        assert.equal(
          sent.json.message.content,
          `【ZhiXu ${label}】\n\nUser title\nUser content`,
        );
        assert.equal(sent.json.message.type, 1);
        assert.equal(sent.json.apiKey, 'fixture');
        assert.equal(
          sent.json[type === 'room' ? 'roomName' : 'name'],
          'recipient',
        );
      }
      await service.testNotify(
        {
          type: 'email',
          emailUser: 'sender@example.invalid',
          emailTo: 'receiver@example.invalid',
          emailPass: 'fixture',
        },
        'User title',
        'User content',
      );
      assert.equal(mail.from, `"ZhiXu ${label}" <sender@example.invalid>`);
      assert.equal(mail.subject, 'User title');
      assert.equal(mail.html, 'User content');
      assert.equal(
        tf('%s 测试通知 https://github.com/anysoft/ZhiXu', 'ZhiXu'),
        lang === 'en'
          ? 'ZhiXu test notification https://github.com/anysoft/ZhiXu'
          : 'ZhiXu 测试通知 https://github.com/anysoft/ZhiXu',
      );
    }
  } finally {
    nodemailer.createTransport = original;
    setLang('zh');
  }
});
