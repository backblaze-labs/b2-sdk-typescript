import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, '.claude/skills/use-b2-sdk/SKILL.md'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const blocks = [...text.matchAll(/```(?:ts|typescript)\s*\n([\s\S]*?)```/g)]

test('skill snippets use exported imports and type-check', () => {
  assert.ok(blocks.length > 0, 'skill must contain TypeScript examples')
  const configPath = join(root, 'examples/tsconfig.json')
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys)
  assert.ok(parsed, 'examples TypeScript configuration must load')
  for (const [index, block] of blocks.entries()) {
    const filename = join(root, 'examples', `skill-example-${index}.ts`)
    const source = ts.createSourceFile(filename, block[1], ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const path = statement.moduleSpecifier.text
        if (path.startsWith(pkg.name)) {
          assert.ok(
            Object.hasOwn(pkg.exports, `.${path.slice(pkg.name.length)}`),
            `unexported import: ${path}`,
          )
        }
      }
    }
    const host = ts.createCompilerHost(parsed.options)
    const read = host.readFile.bind(host)
    const exists = host.fileExists.bind(host)
    host.readFile = (path) => (path === filename ? block[1] : read(path))
    host.fileExists = (path) => path === filename || exists(path)
    const program = ts.createProgram([filename], parsed.options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program)
    assert.equal(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (path) => path,
        getNewLine: () => '\n',
      }),
      '',
      `snippet ${index + 1} must type-check`,
    )
  }
})
