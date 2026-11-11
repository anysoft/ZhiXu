'use strict';
const ts = require('typescript');
const methods = new Set([
  'success',
  'error',
  'warning',
  'warn',
  'info',
  'loading',
  'open',
]);

// Audit primary toast text. Notification descriptions can contain user data or
// translated validation details, and remain part of the regular UI inventory.
function inspectToasts(source) {
  const hosts = new Map(),
    translations = new Set(),
    codeTranslations = new Set(),
    declarations = new Map();
  for (const node of source.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier)
    )
      continue;
    const moduleName = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (moduleName === 'react-intl-universal' && clause?.name)
      translations.add(clause.name.text + '.get');
    const bindings = clause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const spec of bindings.elements) {
      const imported = (spec.propertyName || spec.name).text;
      if (
        moduleName === 'antd' &&
        ['message', 'notification'].includes(imported)
      )
        hosts.set(spec.name.text, imported);
      if (
        /(?:^|\/)i18n$/.test(moduleName) &&
        ['t', 'translateError', 'translateEnum', 'translateStatus'].includes(
          imported,
        )
      ) {
        translations.add(spec.name.text);
        if (imported !== 't') codeTranslations.add(spec.name.text);
      }
    }
  }
  function index(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const values = declarations.get(node.name.text) || [];
      values.push(node.initializer);
      declarations.set(node.name.text, values);
    }
    ts.forEachChild(node, index);
  }
  index(source);
  function target(node) {
    if (ts.isParenthesizedExpression(node)) return target(node.expression);
    if (ts.isConditionalExpression(node))
      return target(node.whenTrue) || target(node.whenFalse);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
      return methods.has(node.name.text) && hosts.get(node.expression.text);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isStringLiteral(node.argumentExpression)
    )
      return (
        methods.has(node.argumentExpression.text) &&
        hosts.get(node.expression.text)
      );
    return false;
  }
  function localized(node, seen = new Set()) {
    if (!node) return false;
    if (ts.isParenthesizedExpression(node))
      return localized(node.expression, seen);
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source);
      return (
        translations.has(name) &&
        (codeTranslations.has(name) ||
          (!!node.arguments[0] && ts.isStringLiteral(node.arguments[0])))
      );
    }
    if (ts.isConditionalExpression(node))
      return localized(node.whenTrue, seen) && localized(node.whenFalse, seen);
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const values = declarations.get(node.text) || [];
      // Ambiguous bindings are deliberately not guessed; review at the call site.
      return (
        values.length === 1 &&
        localized(values[0], new Set([...seen, node.text]))
      );
    }
    return false;
  }
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && target(node.expression)) {
      let text = node.arguments[0];
      if (text && ts.isObjectLiteralExpression(text)) {
        const property = text.properties.find(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ['content', 'message'].includes(
              p.name.getText(source).replace(/['"]/g, ''),
            ),
        );
        text = property?.initializer;
      }
      calls.push({
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        callee: node.expression.getText(source),
        content: text?.getText(source) || '',
        localized: localized(text),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return calls;
}
module.exports = { inspectToasts };
