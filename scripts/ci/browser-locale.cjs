'use strict';
// Accessible selectors share the UI resource catalog. Fixture/user content is never translated.
const catalog = require('../i18n/ui-catalog.json');
const en = require('../../src/locales/en-US.json');
const zh = require('../../src/locales/zh-CN.json');
const locale = process.env.QL_I18N_LOCALE === 'zh-CN' ? 'zh-CN' : 'en-US';
const resources = locale === 'zh-CN' ? zh : en;
const manual = {
  确定: ['确定', 'OK'],
  取消: ['取消', 'Cancel'],
  关闭: ['关闭', 'Close'],
  'branch: main': ['分支: main', 'Branch: main'],
};
function ui(value) {
  if (typeof value !== 'string') return value;
  if (manual[value]) return manual[value][locale === 'zh-CN' ? 0 : 1];
  const environment = /^(Python|Node) Environment$/.exec(value);
  if (environment)
    return resources['ui.template.valueEnvironment'].replace(
      '{p0}',
      environment[1],
    );
  const runtimeDefault = /^(Repository|Subscription) Runtime Default$/.exec(
    value,
  );
  if (runtimeDefault)
    return resources['ui.template.valueRuntimeDefault'].replace(
      '{p0}',
      resources['status.scope.' + runtimeDefault[1].toUpperCase()],
    );
  const saveDefault = /^Save (Repository|Subscription) Default$/.exec(value);
  if (saveDefault)
    return resources['ui.saveScopeDefault'].replace(
      '{scope}',
      resources['status.scope.' + saveDefault[1].toUpperCase()],
    );
  const profile = /^(.*) \((\d+) Profiles\)$/.exec(value);
  if (profile)
    return resources['ui.template.valueValueProfiles']
      .replace('{p0}', profile[1])
      .replace('{p1}', profile[2]);
  const credential =
    /^(.*) \((ssh_key|https_token|anonymous), (enabled|disabled)\)$/.exec(
      value,
    );
  if (credential)
    return `${credential[1]} (${credential[2]}, ${
      resources['status.credentialState.' + credential[3]]
    })`;
  if (value === '添加 BEFORE Hook')
    return resources['ui.hookAdd'].replace(
      '{phase}',
      resources['status.hook.BEFORE'],
    );
  if (resources['error.' + value]) return resources['error.' + value];
  const field = value.replaceAll(' ', '_');
  if (resources['field.' + field]) return resources['field.' + field];
  const key = catalog[value]?.key;
  if (key) return resources[key];
  if (Object.hasOwn(resources, value)) return resources[value];
  const legacy = Object.keys(en).find(
    (key) => en[key] === value || zh[key] === value,
  );
  if (legacy) return resources[legacy];
  const enumKey = Object.keys(en).find(
    (key) => key.startsWith('status.') && key.endsWith('.' + value),
  );
  if (enumKey) return resources[enumKey];
  return value;
}
function pattern(value) {
  return new RegExp(
    '^' +
      ui(value)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .split('')
        .join('\\s*') +
      '$',
  );
}
async function configure(page) {
  await page.addInitScript((preference) => {
    if (!localStorage.getItem('zhixu.language'))
      localStorage.setItem('zhixu.language', preference);
  }, locale);
}
function operationLabel(kind, status) {
  return resources['ui.operationStatus']
    .replace('{kind}', resources['status.backupKind.' + kind] || kind)
    .replace('{status}', resources['status.backupOperation.' + status]);
}
module.exports = { ui, pattern, locale, configure, operationLabel };

function buttonName(value) {
  return /^[\u3400-\u9fff]{2}$/.test(ui(value)) ? pattern(value) : ui(value);
}
module.exports.buttonName = buttonName;

function runTitle(id) {
  return resources['ui.template.runValue'].replace('{p0}', String(id));
}
module.exports.runTitle = runTitle;
