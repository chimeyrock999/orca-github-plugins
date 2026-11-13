// The `workflow_dispatch` inputs read from workflow files, as real repos write them.
import { assert, test } from 'orca/testing'
import { dispatchInputs } from './workflow-inputs'

// cli/cli's deployment.yml (abridged): typed inputs, quoted descriptions, a trailing blank line.
const DEPLOYMENT = `name: Deployment
run-name: \${{ inputs.tag_name }} / \${{ inputs.environment }}

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref_name }}

on:
  workflow_dispatch:
    inputs:
      tag_name:
        required: true
        type: string
        description: "The tag name for the release (e.g. v2.100.0, or v2.100.0-rc.1 for a pre-release)."
      environment:
        default: production
        type: environment
        description: "The deployment environment."
      dry_run:
        description: "Perform a dry run without publishing artifacts or creating a release"
        type: boolean
        default: true
      
jobs:
  validate-tag-name:
    runs-on: ubuntu-latest
`

test('typed inputs with their defaults, required flags and descriptions', () => {
  assert.deepEqual(dispatchInputs(DEPLOYMENT), {
    dispatch: true,
    inputs: [
      { name: 'tag_name', type: 'string', required: true, default: null, options: [], description: 'The tag name for the release (e.g. v2.100.0, or v2.100.0-rc.1 for a pre-release).' },
      { name: 'environment', type: 'environment', required: false, default: 'production', options: [], description: 'The deployment environment.' },
      { name: 'dry_run', type: 'boolean', required: false, default: true, options: [], description: 'Perform a dry run without publishing artifacts or creating a release' }
    ]
  })
})

test('a choice keeps its options; comments and plain descriptions read', () => {
  const yaml = `on:
  workflow_dispatch:
    inputs:
      os:
        description: Operating system to test # which runner
        required: true
        default: all
        type: choice
        options:
          - all
          - ubuntu-latest
          - 'windows-latest'
      level:
        type: number
        default: '3'
`
  const { inputs } = dispatchInputs(yaml)
  assert.deepEqual(inputs?.[0], { name: 'os', type: 'choice', required: true, default: 'all', options: ['all', 'ubuntu-latest', 'windows-latest'], description: 'Operating system to test' })
  assert.deepEqual(inputs?.[1], { name: 'level', type: 'number', required: false, default: '3', options: [], description: null })
})

test('workflow_dispatch with no inputs, beside a schedule list of mappings', () => {
  const yaml = `name: Bump Go
on:
  schedule:
    - cron: "0 3 * * *" # 3 AM UTC
      timezone: UTC
  workflow_dispatch:
permissions:
  contents: write
`
  assert.deepEqual(dispatchInputs(yaml), { dispatch: true, inputs: [] })
})

test('on as a word, a flow list or a block list', () => {
  assert.deepEqual(dispatchInputs('on: workflow_dispatch\njobs: {}\n'), { dispatch: true, inputs: [] })
  assert.deepEqual(dispatchInputs('on: [push, "workflow_dispatch"]\n'), { dispatch: true, inputs: [] })
  assert.deepEqual(dispatchInputs('"on":\n  - push\n  - workflow_dispatch\n'), { dispatch: true, inputs: [] })
})

test('a workflow without workflow_dispatch cannot be run by hand', () => {
  assert.deepEqual(dispatchInputs('on:\n  push:\n    branches: [main]\n  pull_request:\n'), { dispatch: false, inputs: [] })
  assert.deepEqual(dispatchInputs('on: push\n'), { dispatch: false, inputs: [] })
  assert.deepEqual(dispatchInputs('name: no trigger\n'), { dispatch: false, inputs: [] })
})

test('block scalar descriptions keep or fold their lines', () => {
  const yaml = `on:
  workflow_dispatch:
    inputs:
      notes:
        description: |
          First line
            indented
        type: string
      summary:
        description: >-
          folded
          text
`
  const { inputs } = dispatchInputs(yaml)
  assert.equal(inputs?.[0].description, 'First line\n  indented')
  assert.equal(inputs?.[1].description, 'folded text')
})

test('YAML this reader does not follow gives null inputs, still saying whether it dispatches', () => {
  const anchors = `on:
  workflow_dispatch:
    inputs:
      env: &env
        type: string
`
  assert.deepEqual(dispatchInputs(anchors), { dispatch: true, inputs: null })
  const flowMap = 'on:\n  workflow_dispatch: { inputs: { a: { type: string } } }\n'
  assert.deepEqual(dispatchInputs(flowMap), { dispatch: true, inputs: null })
  const multiline = 'on:\n  workflow_dispatch:\n    inputs:\n      a:\n        description: a plain value\n          over two lines\n'
  assert.deepEqual(dispatchInputs(multiline), { dispatch: true, inputs: null })
})

test('an unknown type reads as a string', () => {
  const { inputs } = dispatchInputs('on:\n  workflow_dispatch:\n    inputs:\n      a:\n        type: secret\n')
  assert.equal(inputs?.[0].type, 'string')
})
