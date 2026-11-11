'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  ts = require('typescript');
function wizard() {
  const slots = [],
    calls = [];
  let cursor = 0,
    resolve,
    reject;
  const react = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...props, children },
    }),
    useEffect: () => {},
    useState: (value) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = value;
      return [
        slots[i],
        (next) => {
          slots[i] = typeof next === 'function' ? next(slots[i]) : next;
        },
      ];
    },
    useRef: (value) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: value };
      return slots[i];
    },
  };
  const Form = Object.assign(() => {}, { Item: 'FormItem' });
  const mocks = {
    react,
    'react-intl-universal': { get: (key) => key },
    antd: {
      Button: 'Button',
      Row: 'Row',
      Input: Object.assign(() => {}, { Password: 'Password' }),
      Form,
      Typography: { Link: 'Link', Paragraph: 'Paragraph' },
      Steps: { Step: 'Step' },
    },
    '@/utils/brand': { PRODUCT_NAME: 'ZhiXu' },
    '@/utils/i18n': { useLocale: () => {} },
    '@/utils/config': { apiPrefix: '/api/', authKey: 'token' },
    '@/utils/http': {
      request: {
        put: (url, body) => {
          calls.push({ url, body });
          return new Promise((a, b) => {
            resolve = a;
            reject = b;
          });
        },
      },
    },
    './index.less': {},
    '@/assets/zhixu-logo.svg': 'logo',
  };
  const code = ts.transpileModule(
    fs.readFileSync('src/pages/initialization/index.tsx', 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    require: (n) => mocks[n],
    window: { location: { reload: () => {} } },
  });
  const render = () => {
    cursor = 0;
    return exports.default();
  };
  const nodes = (node) =>
    !node
      ? []
      : Array.isArray(node)
      ? node.flatMap(nodes)
      : typeof node === 'object'
      ? [node, ...nodes(node.props?.children)]
      : [];
  const button = (tree, key) =>
    nodes(tree).find(
      (n) => n.type === 'Button' && n.props.children.includes(key),
    );
  const form = (tree) => nodes(tree).find((n) => n.props.onFinish);
  return {
    render,
    button,
    form,
    calls,
    resolve: (v) => resolve(v),
    reject: (e) => reject(e),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
test('setup retains drafts on back navigation, defers creation until confirmation and prevents duplicate submits', async () => {
  const w = wizard();
  let tree = w.render();
  w.button(tree, '开始安装').props.onClick();
  tree = w.render();
  const draft = {
    username: 'tester',
    password: 'strong-test-password',
    confirm: 'strong-test-password',
  };
  w.form(tree).props.onValuesChange({}, draft);
  tree = w.render();
  w.button(tree, 'ui.setup.previous').props.onClick();
  tree = w.render();
  w.button(tree, '开始安装').props.onClick();
  tree = w.render();
  assert.equal(w.form(tree).props.initialValues.username, 'tester');
  w.form(tree).props.onFinish(draft);
  tree = w.render();
  assert.equal(w.calls.length, 0);
  w.button(tree, 'ui.setup.previous').props.onClick();
  tree = w.render();
  assert.equal(w.form(tree).props.initialValues.password, draft.password);
  const updated = { ...draft, username: 'revised' };
  w.form(tree).props.onFinish(updated);
  tree = w.render();
  const confirm = w.button(tree, 'ui.setup.confirm');
  confirm.props.onClick();
  confirm.props.onClick();
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].body.username, 'revised');
  assert.equal(w.calls[0].body.confirm, undefined);
  tree = w.render();
  assert.equal(w.button(tree, 'ui.setup.previous').props.disabled, true);
  w.resolve({ code: 200 });
  await tick();
  tree = w.render();
  assert.ok(w.button(tree, '去登录'));
  assert.equal(w.button(tree, 'ui.setup.previous'), undefined);
});
test('failed final submission keeps review editable and permits retry', async () => {
  const w = wizard();
  let tree = w.render();
  w.button(tree, '开始安装').props.onClick();
  tree = w.render();
  w.form(tree).props.onFinish({
    username: 'tester',
    password: 'strong-test-password',
    confirm: 'strong-test-password',
  });
  tree = w.render();
  w.button(tree, 'ui.setup.confirm').props.onClick();
  w.reject(new Error('network'));
  await tick();
  tree = w.render();
  assert.equal(w.button(tree, 'ui.setup.previous').props.disabled, false);
  w.button(tree, 'ui.setup.previous').props.onClick();
  tree = w.render();
  assert.equal(w.form(tree).props.initialValues.username, 'tester');
});
