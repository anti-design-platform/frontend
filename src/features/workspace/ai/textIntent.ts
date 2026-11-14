export type Text2DIntent = 'text_to_2d' | 'edit_2d';

const editActionWords = new Set([
  'adjust', 'add', 'change', 'delete', 'edit', 'enlarge', 'erase', 'fix',
  'modify', 'move', 'reduce', 'remove', 'resize', 'rotate', 'scale', 'shrink',
  'update', 'bigger', 'smaller', 'larger',
  'عدل', 'عدلي', 'تعديل', 'غير', 'غيري', 'تغيير', 'ضيف', 'ضيفي', 'اضف',
  'اضيف', 'اضافة', 'احذف', 'احذفي', 'امسح', 'امسحي', 'كبر', 'كبري', 'اكبر',
  'صغر', 'صغري', 'اصغر', 'حرك', 'حركي', 'تحريك', 'لف', 'لفي', 'دور', 'دوري',
  'تدوير', 'وسع', 'وسعي', 'تصغير', 'تكبير', 'زود', 'زودي', 'قلل', 'قللي',
  'اصلح', 'اصلاح',
]);

export function classifyText2DIntent(text: string): Text2DIntent {
  const normalized = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}]+/gu) || [];

  return words.some(word => editActionWords.has(word)) ? 'edit_2d' : 'text_to_2d';
}
