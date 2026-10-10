import { describe, expect, it } from 'vitest';
import { redactHtmlSecrets } from '../html-secret-redaction.js';

describe('secret rich text redaction', () => {
  it.each([
    '<section class="secret"><section>nested secret</section>SECRET_TAIL</section>',
    '<section CLASS=secret>SECRET_TAIL</section>',
    '<section class="other se&#99;ret">SECRET_TAIL</section>',
    '<template><section class=secret>SECRET_TAIL</section></template>',
    '<section class=secret><section class=secret>nested secret</section>SECRET_TAIL</section>',
  ])('removes complete secret subtrees: %s', (secret) => {
    const output = redactHtmlSecrets(`**Visible**\n${secret}\n<p>After</p>`);
    expect(output).not.toContain('SECRET_TAIL');
    expect(output).not.toContain('nested secret');
    expect(output).toContain('**Visible**\n');
    expect(output).toContain('\n<p>After</p>');
  });

  it('redacts an unclosed secret through the end of the source', () => {
    expect(redactHtmlSecrets('<p>Visible</p><section class=secret>SECRET_TAIL')).toBe(
      '<p>Visible</p>',
    );
  });

  it('preserves visible HTML and Markdown source exactly', () => {
    const source =
      '**Heading**\n<p CLASS="secretary">&amp; visible</p>\n[link](https://example.test)';
    expect(redactHtmlSecrets(source)).toBe(source);
  });

  it('fails closed for excessive source size, depth, or node count', () => {
    expect(() => redactHtmlSecrets('x'.repeat(4 * 1024 * 1024 + 1))).toThrow('source size');
    expect(() => redactHtmlSecrets('<div>'.repeat(4097))).toThrow('nesting depth');
    expect(() => redactHtmlSecrets('<i></i>'.repeat(100_001))).toThrow('node count');
  });
});
