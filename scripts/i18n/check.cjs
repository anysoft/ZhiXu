'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const { inspectToasts } = require('./toasts.cjs');
const walk = (directory) =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.name.startsWith('.')
        ? []
        : entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    );
const uiProps = new Set([
  'title',
  'label',
  'name',
  'message',
  'description',
  'placeholder',
  'tooltip',
  'alt',
  'aria-label',
  'okText',
  'cancelText',
  'emptyText',
  'help',
  'extra',
  'loadingText',
]);
function inventory() {
  const literals = [],
    toasts = [],
    calls = [];
  for (const full of walk(path.join(root, 'src')).filter((file) =>
    /\.[jt]sx?$/.test(file),
  )) {
    const file = path.relative(root, full),
      sf = ts.createSourceFile(
        file,
        fs.readFileSync(full, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
    const v2Module = path.join(root, 'src/v2/i18n');
    const v2TextImports = new Set(),
      v2HookImports = new Set();
    for (const statement of sf.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      if (
        path
          .resolve(path.dirname(full), statement.moduleSpecifier.text)
          .replace(/\.[jt]sx?$/, '') !== v2Module
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const specifier of bindings.elements) {
        const exported = (specifier.propertyName || specifier.name).text;
        if (exported === 'text') v2TextImports.add(specifier.name.text);
        if (exported === 'useText') v2HookImports.add(specifier.name.text);
      }
    }
    if (full.replace(/\.ts$/, '') === v2Module) v2TextImports.add('text');
    // Resolve the nearest lexical binding; an unrelated function called `t`
    // remains checked as before and is never assigned this namespace by path.
    function isV2TextCall(node) {
      if (!ts.isIdentifier(node.expression)) return false;
      const name = node.expression.text;
      for (let scope = node.parent; scope; scope = scope.parent) {
        if (
          ts.isFunctionLike(scope) &&
          scope.parameters.some(
            (parameter) =>
              ts.isIdentifier(parameter.name) && parameter.name.text === name,
          )
        )
          return false;
        if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
        for (const statement of scope.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          for (const declaration of statement.declarationList.declarations) {
            if (
              !ts.isIdentifier(declaration.name) ||
              declaration.name.text !== name
            )
              continue;
            const value = declaration.initializer;
            return (
              !!value &&
              ts.isCallExpression(value) &&
              ts.isIdentifier(value.expression) &&
              v2HookImports.has(value.expression.text)
            );
          }
        }
      }
      return v2TextImports.has(name);
    }
    function literalKeys(node) {
      if (!node) return [];
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        return [node.text];
      if (ts.isConditionalExpression(node))
        return [...literalKeys(node.whenTrue), ...literalKeys(node.whenFalse)];
      return [];
    }
    toasts.push(...inspectToasts(sf).map((toast) => ({ file, ...toast })));
    const add = (n, value, kind) =>
      literals.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        value,
        kind,
      });
    function displayed(n) {
      const p = n.parent;
      if (!p) return false;
      if (ts.isJsxAttribute(p))
        return uiProps.has(p.name.getText(sf)) && p.name.getText(sf) !== 'name';
      if (ts.isJsxExpression(p))
        return !ts.isJsxAttribute(p.parent) || displayed(p);
      if (ts.isPropertyAssignment(p))
        return (
          p.initializer === n &&
          ((uiProps.has(p.name.getText(sf).replace(/['"]/g, '')) &&
            p.name.getText(sf) !== 'name') ||
            (p.name.getText(sf) === 'name' &&
              file.endsWith('defaultProps.tsx')))
        );
      if (ts.isConditionalExpression(p))
        return n !== p.condition && displayed(p);
      if (ts.isParenthesizedExpression(p)) return displayed(p);
      if (ts.isBinaryExpression(p))
        return (
          [
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
            ts.SyntaxKind.PlusToken,
          ].includes(p.operatorToken.kind) && displayed(p)
        );
      if (ts.isArrowFunction(p))
        return (
          p.body === n &&
          ts.isPropertyAssignment(p.parent) &&
          p.parent.name.getText(sf) === 'render'
        );
      if (ts.isCallExpression(p))
        return /^(message|notification)\.(error|success|info|warning|warn)$/.test(
          p.expression.getText(sf),
        );
      return false;
    }
    function visit(n) {
      if (ts.isCallExpression(n)) {
        const namespaced = isV2TextCall(n);
        if (
          namespaced ||
          /^(intl\.(get|getHTML)|tr|t)$/.test(n.expression.getText(sf))
        )
          for (const key of namespaced
            ? literalKeys(n.arguments[0])
            : ts.isStringLiteral(n.arguments[0])
            ? [n.arguments[0].text]
            : [])
            calls.push({
              file,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              key: namespaced ? 'v2.' + key : key,
            });
      }
      if (ts.isJsxText(n) && /[A-Za-z\u3400-\u9fff]/.test(n.text))
        add(n, n.text.trim().replace(/\s+/g, ' '), 'jsx-text');
      if (
        (ts.isStringLiteral(n) ||
          ts.isNoSubstitutionTemplateLiteral(n) ||
          ts.isTemplateExpression(n)) &&
        displayed(n)
      ) {
        const value = ts.isTemplateExpression(n) ? n.getText(sf) : n.text;
        if (/[A-Za-z\u3400-\u9fff]/.test(value))
          add(n, value, 'presentation-expression');
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
  }
  return { literals, calls, toasts };
}
function check() {
  const resources = {},
    duplicates = [];
  for (const locale of ['zh-CN', 'en-US']) {
    const seen = new Set();
    resources[locale] = {};
    for (const directory of ['src/locales', 'src/v2/locales']) {
      const file = path.join(root, directory, locale + '.json'),
        raw = fs.readFileSync(file, 'utf8'),
        sf = ts.parseJsonText(file, raw);
      function visit(n) {
        if (ts.isPropertyAssignment(n)) {
          const key = n.name.text;
          if (seen.has(key)) duplicates.push({ locale, key });
          seen.add(key);
        }
        ts.forEachChild(n, visit);
      }
      visit(sf);
      Object.assign(resources[locale], JSON.parse(raw));
    }
  }
  const { literals, calls, toasts } = inventory(),
    zh = resources['zh-CN'],
    en = resources['en-US'];
  const missing = calls.filter(
    (x) => !Object.hasOwn(zh, x.key) || !Object.hasOwn(en, x.key),
  );
  const parity = [...new Set([...Object.keys(zh), ...Object.keys(en)])].filter(
    (key) => !Object.hasOwn(zh, key) || !Object.hasOwn(en, key),
  );
  const requiredPresentationKeys = [
    ...Object.entries(require('./enums.json')).flatMap(([domain, values]) =>
      values.map((value) => `status.${domain}.${value}`),
    ),
    ...require('./errors.json').map((code) => `error.${code}`),
  ];
  const missingPresentation = requiredPresentationKeys.flatMap((key) =>
    Object.entries(resources)
      .filter(([, messages]) => !Object.hasOwn(messages, key) || !messages[key])
      .map(([locale]) => ({ locale, key })),
  );
  const exemptions = fs.existsSync(path.join(__dirname, 'exceptions.json'))
    ? require('./exceptions.json')
    : [];
  const catalog = require('./ui-catalog.json');
  const classified = literals.map((row) => {
    const normalize = (value) =>
      value.startsWith('`') ? value.replace(/\s+/g, ' ') : value;
    const exception = exemptions.find(
      (x) => x.file === row.file && normalize(x.value) === normalize(row.value),
    );
    if (exception)
      return {
        ...row,
        classification: exception.classification,
        reason: exception.reason,
      };
    const item = catalog[row.value];
    if (item?.classification === 'TECHNICAL_TOKEN')
      return {
        ...row,
        classification: item.classification,
        reason: item.reason,
      };
    return { ...row, classification: 'UNCLASSIFIED' };
  });
  const semanticErrors = Object.keys(zh).filter(
    (key) =>
      /^(ui|status|error|common|field|validation|settings|v2)\./.test(key) &&
      !/^([a-zA-Z][a-zA-Z0-9]*\.)+[A-Za-z0-9_]+$/.test(key),
  );
  return {
    status:
      duplicates.length ||
      missing.length ||
      parity.length ||
      semanticErrors.length ||
      missingPresentation.length ||
      toasts.some((toast) => !toast.localized) ||
      classified.some((x) => x.classification === 'UNCLASSIFIED')
        ? 'FAIL'
        : 'PASS',
    keys: { zh: Object.keys(zh).length, en: Object.keys(en).length },
    duplicates,
    missing,
    parity,
    semanticErrors,
    missingPresentation,
    toasts,
    literals: classified,
  };
}
if (require.main === module) {
  const result = check();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}
module.exports = { inventory, check };
