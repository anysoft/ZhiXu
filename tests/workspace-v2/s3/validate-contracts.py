#!/usr/bin/env python3
"""Re-run frozen S0 structural checks without rewriting its historical receipt.

S0's first entry-audit assertions describe its original documentation-only HEAD.
Those five historical facts cannot describe an S3 implementation checkout. Verify
all frozen input hashes instead, retain those checks as explicitly historical,
and execute every remaining assertion from the byte-identical S0 validator.
"""
import ast
import hashlib
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[3]
FROZEN = ROOT / 'docs/architecture/v2/contracts/validate_contracts.py'
prior = json.loads((ROOT / 'tests/workspace-v2/s2-validation-results.json').read_text())
inputs = prior['frozen_s0_sha256']
for name, expected in inputs.items():
    assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, name
assert hashlib.sha256((ROOT / '.gitignore').read_bytes()).hexdigest() == '78f778aa7cc3494334676046b883b672c9e98f3fb28adfd3868b9aa99aef4893'

historical = {
    'HEAD_matches_source_baseline',
    'all_tracked_bytes_unchanged_from_entry_including_user_gitignore',
    'existing_gitignore_preserved',
    'only_three_authorized_prior_reports_updated',
    '899_file_inventory_not_regenerated',
}
tree = ast.parse(FROZEN.read_text(), filename=str(FROZEN))
# Remove only the receipt write and final print. Contract/source files stay read-only.
tree.body = [node for node in tree.body if not (
    isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and (
        isinstance(node.value.func, ast.Attribute) and node.value.func.attr == 'write_text'
        or isinstance(node.value.func, ast.Name) and node.value.func.id == 'print'
    )
)]
definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'check')
guard = ast.parse("if name in historical: checks.append({'name': name, 'status': 'HISTORICAL_S0_ENTRY_FACT_REPLACED_BY_FROZEN_HASH_PROOF'}); return").body[0]
definition.body.insert(0, guard)
ast.fix_missing_locations(tree)
namespace = {'__file__': str(FROZEN), 'historical': historical}
exec(compile(tree, str(FROZEN), 'exec'), namespace)
result = namespace['result']
result['scope'] = 'CURRENT_S3_FROZEN_S0_STRUCTURAL_REVALIDATION'
result['frozen_files_verified'] = len(inputs)
result['historical_entry_checks_replaced'] = sorted(historical)
result['current_structural_check_count'] = sum(c['name'] not in historical for c in result['checks'])
result['frozen_validator_sha256'] = hashlib.sha256(FROZEN.read_bytes()).hexdigest()
result['receipt_written'] = False
print(json.dumps(result, ensure_ascii=False, indent=2))
