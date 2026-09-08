import test from 'node:test';
import assert from 'node:assert';
import { fitWithin, squareCrop, approxBytes, storedLength, isImageFile, fileProblem,
  MAX_FILE_BYTES, THUMB_SIDE } from '../js/photo.js';

test('fitWithin вписывает в квадрат, сохраняя пропорции', () => {
  assert.deepStrictEqual(fitWithin(4000, 3000, 1280), { w: 1280, h: 960 });
  assert.deepStrictEqual(fitWithin(3000, 4000, 1280), { w: 960, h: 1280 });
  assert.deepStrictEqual(fitWithin(1000, 1000, 500), { w: 500, h: 500 });
});

test('fitWithin не растягивает маленькие картинки', () => {
  assert.deepStrictEqual(fitWithin(640, 480, 1280), { w: 640, h: 480 });
  assert.deepStrictEqual(fitWithin(100, 40, 1280), { w: 100, h: 40 });
});

test('fitWithin переживает мусор на входе', () => {
  assert.deepStrictEqual(fitWithin(0, 0, 200), { w: 1, h: 1 });
  assert.deepStrictEqual(fitWithin(300.4, 200.6, 0), { w: 300, h: 201 });
});

test('squareCrop берёт квадрат из центра', () => {
  assert.deepStrictEqual(squareCrop(4000, 3000), { sx: 500, sy: 0, size: 3000 });
  assert.deepStrictEqual(squareCrop(300, 900), { sx: 0, sy: 300, size: 300 });
  assert.deepStrictEqual(squareCrop(500, 500), { sx: 0, sy: 0, size: 500 });
});

test('approxBytes считает вес картинки по base64-хвосту', () => {
  // 6 байт → 8 символов base64
  const six = 'data:image/jpeg;base64,' + Buffer.from('abcdef').toString('base64');
  assert.strictEqual(approxBytes(six), 6);
  const five = 'data:image/jpeg;base64,' + Buffer.from('abcde').toString('base64');
  assert.strictEqual(approxBytes(five), 5);
  assert.strictEqual(approxBytes(''), 0);
  assert.strictEqual(approxBytes('не data-uri'), 0);
});

test('storedLength меряет строку, а не картинку: в документ едет base64', () => {
  const url = 'data:image/jpeg;base64,' + Buffer.alloc(300).toString('base64');
  assert.strictEqual(storedLength(url), url.length);
  assert.ok(storedLength(url) > approxBytes(url), 'base64 длиннее самих байтов');
  assert.strictEqual(storedLength(null), 0);
});

test('isImageFile / fileProblem отсеивают не-картинки и гигантские файлы', () => {
  assert.ok(isImageFile({ type: 'image/jpeg', size: 10 }));
  assert.ok(!isImageFile({ type: 'application/pdf', size: 10 }));
  assert.strictEqual(fileProblem({ type: 'image/heic', size: 1024 }), null);
  assert.match(fileProblem({ type: 'text/plain', size: 10 }), /не картинка/);
  assert.match(fileProblem({ type: 'image/png', size: MAX_FILE_BYTES + 1 }), /Слишком большой/);
  assert.match(fileProblem(null), /не выбран/i);
});

test('аватар каталога — маленький квадрат', () => {
  assert.strictEqual(THUMB_SIDE, 160);
});
