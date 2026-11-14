import { describe, expect, it } from 'vitest';
import { classifyText2DIntent } from './textIntent';

describe('classifyText2DIntent', () => {
  it.each([
    ['ارسملي فراشة', 'text_to_2d'],
    ['عايز اعمل فراشة جديدة', 'text_to_2d'],
    ['Draw a butterfly', 'text_to_2d'],
    ['Generate another flower', 'text_to_2d'],
    ['عدل الفراشة وخلي الجناح أكبر', 'edit_2d'],
    ['ضيف فتحات في التصميم', 'edit_2d'],
    ['كبر الشكل شوية', 'edit_2d'],
    ['Add holes to this design', 'edit_2d'],
    ['Make the drawing smaller', 'edit_2d'],
  ] as const)('routes "%s" to %s', (text, intent) => {
    expect(classifyText2DIntent(text)).toBe(intent);
  });
});
