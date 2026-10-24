import { describe, expect, it } from 'vitest';
import css from '../../styles.css?raw';
import { OTHER, OTHER_COLOR, categoryColor } from '../charts';

/** The custom properties set in the first rule matching `selector`. */
function tokens(selector: string): Record<string, string> {
  const body = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('chart colors', () => {
  const light = tokens(':root');
  const dark = { ...light, ...tokens(":root[data-theme='dark']") };
  const slots = ['Rent', 'Groceries', 'Dining', 'Transport', 'Shopping', 'Utilities', 'Entertainment', 'Health', OTHER]
    .map((c) => categoryColor(c).match(/^var\((--[\w-]+)\)$/)?.[1]);

  it('come from theme tokens', () => {
    expect(categoryColor('Unknown')).toBe(OTHER_COLOR);
    for (const t of slots) expect(light[t!], t).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('stand out from the card surface in dark mode', () => {
    for (const t of slots) expect(contrast(dark[t!], dark['--color-surface']), t).toBeGreaterThanOrEqual(3);
  });
});
