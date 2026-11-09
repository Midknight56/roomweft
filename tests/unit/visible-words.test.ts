import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FORBIDDEN_PHRASES = ['sandbox', 'test money', 'test card', 'nothing ships'];

const ALLOWED_LITERALS = new Set([
  'www.sandbox.paypal.com',
  'https://api-m.sandbox.paypal.com',
  'sandbox',
  'sandbox_off',
  'sandbox-note',
  'SANDBOX_TEST_CARD',
]);

const FILES = [
  'src/client/panel.ts',
  'src/client/helpers.ts',
  'src/client/main.ts',
  'src/worker.ts',
  'src/checkout/service.ts',
];

function extractQuotedLiterals(source: string): string[] {
  const literals: string[] = [];
  const regex = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    literals.push(match[2]);
  }
  return literals;
}

describe('visible payment words', () => {
  it('forbids sandbox test words in visitor strings', () => {
    const violations: { file: string; phrase: string; literal: string }[] = [];

    for (const relativePath of FILES) {
      const fullPath = resolve(process.cwd(), relativePath);
      const content = readFileSync(fullPath, 'utf8');
      const literals = extractQuotedLiterals(content);

      for (const literal of literals) {
        if (ALLOWED_LITERALS.has(literal)) continue;
        const lower = literal.toLowerCase();
        for (const phrase of FORBIDDEN_PHRASES) {
          if (lower.includes(phrase)) {
            violations.push({ file: relativePath, phrase, literal });
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
