// Фото блюда: сжатие в браузере и пределы Firestore.
//
// Картинка живёт двумя копиями:
//   recipes/{id}.thumb          — квадратный аватар для каталога (едет со списком)
//   recipeImages/{id}.data      — большая картинка, грузится только на карточке
// Поэтому список рецептов не тащит мегабайты: в общем документе лежит
// только маленький квадрат, всё тяжёлое — отдельным документом по требованию.
//
// Чистые помощники (fitWithin/squareCrop/approxBytes) тестируются в Node,
// compressPhoto работает в браузере (canvas).

// Документ Firestore ≤ 1 МБ, и считается он по СТРОКЕ base64, а не по весу
// картинки (base64 длиннее байтов примерно на треть) — поэтому все пределы
// ниже меряются длиной data-URI, см. storedLength.
export const MAX_PHOTO_BYTES = 880 * 1024;   // ~640 КБ картинки
export const MAX_THUMB_BYTES = 40 * 1024;    // ~30 КБ квадрата в самом рецепте

// Сжимаем по убыванию: сначала пробуем крупнее и качественнее.
export const PHOTO_STEPS = [
  { side: 1280, quality: 0.82 },
  { side: 1280, quality: 0.7 },
  { side: 1024, quality: 0.7 },
  { side: 800, quality: 0.65 },
  { side: 640, quality: 0.6 },
];

export const THUMB_SIDE = 160;   // аватар в каталоге — квадрат
export const THUMB_QUALITY = 0.7;

// Больше этого в браузер не тянем: телефонное фото редко тяжелее.
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function isImageFile(file) {
  return !!file && typeof file.type === 'string' && file.type.startsWith('image/');
}

// Ошибка выбора файла человеческим языком; null — файл годится.
export function fileProblem(file) {
  if (!file) return 'Файл не выбран';
  if (!isImageFile(file)) return 'Это не картинка — нужен jpg, png или heic';
  if (file.size > MAX_FILE_BYTES) return 'Слишком большой файл (больше 25 МБ)';
  return null;
}

// Вписывает картинку в квадрат maxSide, сохраняя пропорции. Не растягивает
// маленькие: апскейл только испортил бы и раздул размер.
export function fitWithin(w, h, maxSide) {
  const width = Math.max(1, Math.round(w || 0));
  const height = Math.max(1, Math.round(h || 0));
  const longest = Math.max(width, height);
  if (!maxSide || longest <= maxSide) return { w: width, h: height };
  const k = maxSide / longest;
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

// Квадратная вырезка из центра — для аватара в каталоге.
export function squareCrop(w, h) {
  const width = Math.max(1, Math.round(w || 0));
  const height = Math.max(1, Math.round(h || 0));
  const size = Math.min(width, height);
  return { sx: Math.round((width - size) / 2), sy: Math.round((height - size) / 2), size };
}

// Сколько места data-URI займёт в документе Firestore: строка хранится как
// есть, поэтому это её длина (base64 — ASCII, байт на символ).
export function storedLength(dataUrl) {
  return String(dataUrl || '').length;
}

// Вес самой картинки в байтах (по base64-хвосту, без раскодирования).
export function approxBytes(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma < 0) return 0;
  const b64 = s.slice(comma + 1);
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad);
}

// ── Браузерная часть (canvas) ──

// Декодирует файл в рисуемый источник; imageOrientation учитывает EXIF —
// иначе фото с телефона приезжает боком.
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return { img: await createImageBitmap(file, { imageOrientation: 'from-image' }), release() {} }; }
    catch (e) { /* старый браузер или heic — пробуем через <img> */ }
  }
  const url = URL.createObjectURL(file);
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Не получилось прочитать картинку'));
    el.src = url;
  });
  return { img, release() { URL.revokeObjectURL(url); } };
}

function drawToDataUrl(img, srcW, srcH, crop, out, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.w, out.h);
  return canvas.toDataURL('image/jpeg', quality);
}

// Файл → { full, thumb }: большая картинка для карточки рецепта и квадратный
// аватар для каталога. Оба — data-URI jpeg, влезающие в документ Firestore.
export async function compressPhoto(file) {
  const problem = fileProblem(file);
  if (problem) throw new Error(problem);

  const { img, release } = await decodeImage(file);
  try {
    const srcW = img.width || img.naturalWidth;
    const srcH = img.height || img.naturalHeight;
    if (!srcW || !srcH) throw new Error('Пустая картинка');
    const whole = { sx: 0, sy: 0, sw: srcW, sh: srcH };

    let full = '';
    for (const step of PHOTO_STEPS) {
      full = drawToDataUrl(img, srcW, srcH, whole, fitWithin(srcW, srcH, step.side), step.quality);
      if (storedLength(full) <= MAX_PHOTO_BYTES) break;
    }
    if (storedLength(full) > MAX_PHOTO_BYTES) throw new Error('Картинка слишком тяжёлая — попробуй другое фото');

    const c = squareCrop(srcW, srcH);
    let thumb = drawToDataUrl(img, srcW, srcH, { sx: c.sx, sy: c.sy, sw: c.size, sh: c.size },
      { w: THUMB_SIDE, h: THUMB_SIDE }, THUMB_QUALITY);
    if (storedLength(thumb) > MAX_THUMB_BYTES) {
      thumb = drawToDataUrl(img, srcW, srcH, { sx: c.sx, sy: c.sy, sw: c.size, sh: c.size },
        { w: THUMB_SIDE, h: THUMB_SIDE }, 0.5);
    }

    return { full, thumb, width: srcW, height: srcH, bytes: approxBytes(full) };
  } finally {
    release();
  }
}
