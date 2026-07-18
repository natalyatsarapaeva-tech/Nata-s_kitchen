import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escHtml, normalizeIngName, slugify,
  parseLeadingNumber, parseFractionInput, formatScaledNumber, scaleAmount
} from '../js/utils.js';

test('escHtml экранирует опасные символы', () => {
  assert.equal(escHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escHtml(`"a" & 'b'`), '&quot;a&quot; &amp; &#39;b&#39;');
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
});

test('normalizeIngName: регистр, пунктуация, пробелы, ё', () => {
  assert.equal(normalizeIngName('Оливковое  масло (extra)'), 'оливковое масло extra');
  assert.equal(normalizeIngName('Свёкла'), 'свёкла');
  assert.equal(normalizeIngName('  Помидоры! '), 'помидоры');
  assert.equal(normalizeIngName(''), '');
});

test('slugify: кириллица с ё, обрезка дефисов, суффикс-таймстамп', () => {
  const s = slugify('Тыквенный суп!');
  assert.match(s, /^тыквенный-суп-\d+$/);
  const sYo = slugify('Свёкла — запечённая');
  assert.match(sYo, /^свёкла-запечённая-\d+$/);
});

test('parseLeadingNumber: целые, десятичные, дроби, юникод-дроби, префиксы', () => {
  assert.deepEqual(parseLeadingNumber('200 г'), { num: 200, rest: ' г', prefix: '' });
  assert.equal(parseLeadingNumber('1,5 ч. л.').num, 1.5);
  assert.equal(parseLeadingNumber('2/3 стакана').num, 2 / 3);
  assert.equal(parseLeadingNumber('1 1/2 стакана').num, 1.5);
  assert.equal(parseLeadingNumber('½ ч. л.').num, 0.5);
  assert.equal(parseLeadingNumber('1 ½ стакана').num, 1.5);
  assert.equal(parseLeadingNumber('1½').num, 1.5);
  assert.equal(parseLeadingNumber('по 1 ч. л.').prefix, 'по ');
  assert.equal(parseLeadingNumber('по 1 ч. л.').num, 1);
  assert.equal(parseLeadingNumber('щепотка'), null);
  assert.equal(parseLeadingNumber(''), null);
  assert.equal(parseLeadingNumber(null), null);
});

test('parseFractionInput: множитель из свободного ввода', () => {
  assert.equal(parseFractionInput('1/3'), 1 / 3);
  assert.equal(parseFractionInput('0.5'), 0.5);
  assert.equal(parseFractionInput('0,5'), 0.5);
  assert.equal(parseFractionInput('½'), 0.5);
  assert.equal(parseFractionInput('2'), 2);
  assert.equal(parseFractionInput('abc'), null);
  assert.equal(parseFractionInput('-1'), null);
  assert.equal(parseFractionInput('0'), null);
});

test('formatScaledNumber: красивые дроби и округление', () => {
  assert.equal(formatScaledNumber(0.5), '½');
  assert.equal(formatScaledNumber(1.5), '1 ½');
  assert.equal(formatScaledNumber(2), '2');
  assert.equal(formatScaledNumber(1 / 3), '⅓');
  assert.equal(formatScaledNumber(0.7), '⅔');  // близкие значения прилипают к красивой дроби
  assert.equal(formatScaledNumber(2.43), '2.4'); // вдали от дробей — десятичное

});

test('scaleAmount: масштабирование строк количества', () => {
  assert.equal(scaleAmount('200 г', 2), '400 г');
  assert.equal(scaleAmount('½ ч. л.', 2), '1 ч. л.');
  assert.equal(scaleAmount('1,5 ч. л.', 2), '3 ч. л.');
  assert.equal(scaleAmount('1/2 стакана', 3), '1 ½ стакана');
  assert.equal(scaleAmount('2 ст. л.', 0.5), '1 ст. л.');
  assert.equal(scaleAmount('по 1 ч. л.', 2), 'по 2 ч. л.');
  // немасштабируемое возвращается как есть
  assert.equal(scaleAmount('по вкусу', 2), 'по вкусу');
  assert.equal(scaleAmount('щепотка', 3), 'щепотка');
  // множитель 1 — без изменений (в т.ч. тот же объект строки)
  assert.equal(scaleAmount('200 г', 1), '200 г');
  assert.equal(scaleAmount('', 2), '');
});

test('parseJsonLoose: markdown-заборы и текст вокруг JSON', async () => {
  const { parseJsonLoose } = await import('../js/utils.js');
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Вот рецепт:\n{"a":{"b":2}}\nПриятного!'), { a: { b: 2 } });
  assert.throws(() => parseJsonLoose('не json'));
});
