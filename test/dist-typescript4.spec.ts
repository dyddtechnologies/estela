/**
 * Built-package check: the emitted declarations must stay parseable by TypeScript 4.9, the oldest
 * compiler consumers of this package use (ms-asg-core pins 4.9.5). skipLibCheck does not hide a
 * syntax error in a .d.ts, so one TS 5-only construct breaks `tsc` for every consumer on 4.x, even
 * those that never touch the feature, because the barrel loads the shared declaration chunk.
 *
 * A second compiler cannot be a devDependency here (its `tsc` bin would shadow TS 5's), so the
 * repo's compiler walks the emitted AST and rejects the constructs TS 4.9 cannot parse or resolve:
 * `const` type parameters (5.0) and the global `NoInfer` (5.4). The dist was also checked by hand
 * with tsc 4.9.5 (`--skipLibCheck`): it parses, and a consumer of defineStateMachine type-checks.
 * Skipped when dist has not been built (`npm run verify` always builds before it tests).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

const root = join(__dirname, '..');
const dist = join(root, 'dist');
const built = ['index.d.ts', 'testing/index.d.ts'].every((file) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed paths under dist
  existsSync(join(dist, file)),
);
const d = built ? describe : describe.skip;

function declarationFiles(dir: string): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks dist only
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return declarationFiles(path);
    return /\.d\.[mc]?ts$/.test(entry.name) ? [path] : [];
  });
}

/** Names of locally declared types, so a package type that happens to be called NoInfer is fine. */
function localTypeNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

/** TS 5-only constructs in one source text, as "line: construct" strings. */
function ts5OnlySyntax(fileName: string, text: string): string[] {
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const local = localTypeNames(file);
  const found: string[] = [];
  const at = (node: ts.Node, what: string): void => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push(`${line + 1}: ${what}`);
  };
  const visit = (node: ts.Node): void => {
    const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
    if (
      ts.isTypeParameterDeclaration(node) &&
      modifiers.some((m) => m.kind === ts.SyntaxKind.ConstKeyword)
    ) {
      at(node, 'const type parameter (TS 5.0)');
    }
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      node.typeName.text === 'NoInfer' &&
      !local.has('NoInfer')
    ) {
      at(node, 'NoInfer (TS 5.4)');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('ts5OnlySyntax', () => {
  it('flags the constructs TS 4.9 cannot handle and nothing else', () => {
    const source = [
      'export declare function a<const M>(m: M): M;',
      'export declare function b<T>(x: NoInfer<T>): T;',
      'export declare function c<in out T, U extends readonly string[]>(x: T, u: U): void;',
      'type NoInferLocal<T> = [T][T extends unknown ? 0 : never];',
    ].join('\n');
    expect(ts5OnlySyntax('x.d.ts', source)).toEqual([
      '1: const type parameter (TS 5.0)',
      '2: NoInfer (TS 5.4)',
    ]);
  });
});

d('dist: declarations parseable by TypeScript 4.9', () => {
  it('emits no TS 5-only syntax in any .d.ts', () => {
    const files = declarationFiles(dist);
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((path) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- files under dist
      ts5OnlySyntax(path, readFileSync(path, 'utf8')).map(
        (hit) => `${relative(root, path)}:${hit}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
