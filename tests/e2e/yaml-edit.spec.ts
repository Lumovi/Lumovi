/**
 * Edits to YAML text that leave the rest of it as it was written (`lib/yaml-edit`), tried as
 * plain functions: yaml-edit-cases' cases, given the source's edits.
 */
import * as yamlEdit from '../../src/renderer/src/lib/yaml-edit.ts'
import { test } from './fixtures.ts'
import { YAML_EDIT_CASES } from './yaml-edit-cases.ts'

for (const [title, run] of Object.entries(YAML_EDIT_CASES)) test(title, () => run(yamlEdit))
