import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, 'llms.txt'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sources = {
  B2Simulator: 'src/simulator/index.ts',
  Bucket: 'src/bucket.ts',
  B2Client: 'src/client.ts',
}
const methods = Object.fromEntries(
  Object.entries(sources).map(([name, path]) => {
    const file = ts.createSourceFile(
      path,
      readFileSync(join(root, path), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const cls = file.statements.find(
      (node) => ts.isClassDeclaration(node) && node.name?.text === name,
    )
    assert.ok(cls, `${name} must exist in ${path}`)
    return [
      name,
      new Set(
        cls.members
          .filter(ts.isMethodDeclaration)
          .filter((node) => !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword))
          .map((node) => node.name.getText(file)),
      ),
    ]
  }),
)

test('llms.txt repository links resolve inside the repository', () => {
  for (const match of text.matchAll(
    /https:\/\/github\.com\/backblaze-labs\/b2-sdk-typescript\/blob\/main\/([^\s)#]+)/g,
  )) {
    const path = resolve(root, decodeURIComponent(match[1]))
    assert.ok(
      path.startsWith(root + sep) && existsSync(path),
      `broken repository link: ${match[0]}`,
    )
  }
})

test('llms.txt code imports use exported package paths', () => {
  for (const block of text.matchAll(/```(?:ts|typescript|js|javascript)\n([\s\S]*?)```/g)) {
    for (const match of block[1].matchAll(
      /(?:from\s*|import\s*)['"](@backblaze-labs\/b2-sdk(?:\/[^'"]*)?)['"]/g,
    )) {
      const subpath = `.${match[1].slice(pkg.name.length)}`
      assert.ok(Object.hasOwn(pkg.exports, subpath), `unexported import: ${match[1]}`)
    }
  }
})

test('llms.txt client, bucket and simulator methods exist', () => {
  for (const block of text.matchAll(/```(?:ts|typescript|js|javascript)\n([\s\S]*?)```/g)) {
    const file = ts.createSourceFile('snippet.ts', block[1], ts.ScriptTarget.Latest, true)
    const variables = new Map([
      ['client', 'B2Client'],
      ['bucket', 'Bucket'],
      ['sim', 'B2Simulator'],
    ])
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        Object.hasOwn(sources, node.initializer.expression.text)
      )
        variables.set(node.name.text, node.initializer.expression.text)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const cls = variables.get(node.expression.expression.text)
        if (cls)
          assert.ok(
            methods[cls].has(node.expression.name.text),
            `${cls}.${node.expression.name.text} does not exist`,
          )
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
})
