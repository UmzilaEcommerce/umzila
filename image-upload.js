// Shared photo upload for the seller dashboard and admin (docs/systems/site-speed.md).
// Phone photos are 1–3 MB PNG/JPEGs; the site shows them at card size. Before
// uploading, the browser shrinks each photo to WebP:
//   <base>.w1280.webp  full image (product photos)   — banners .w1600, logos .w512
//   <base>.w480.webp   card thumbnail (product photos only; script.js thumbUrl
//                      derives it from the .w1280 name)
// Files get a unique name (caller passes a timestamped base; never overwritten)
// and a 1-year cache.
// If the browser can't make WebP (old Safari), a GIF/video, or anything fails,
// the original file is uploaded exactly as before — an upload never breaks.
(function () {
  var SIZES = { product: 1280, banner: 1600, logo: 512 }, THUMB = 480, YEAR = '31536000';

  function encode(bitmap, max, quality) {
    var scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    var w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale));
    var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, w, h);
    return new Promise(function (resolve) {
      canvas.toBlob(function (b) { resolve(b && b.type === 'image/webp' ? b : null); }, 'image/webp', quality);
    });
  }

  // -> { full: Blob, thumb: Blob|null } or null when this file should go up untouched.
  async function optimize(file, kind) {
    try {
      if (!file || !/^image\/(png|jpe?g|webp|heic|heif|bmp)$/i.test(file.type || '')) return null;
      if (typeof createImageBitmap !== 'function') return null;
      var bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      var full = await encode(bmp, SIZES[kind] || SIZES.product, 0.8);
      var thumb = kind === 'product' ? await encode(bmp, THUMB, 0.74) : null;
      if (bmp.close) bmp.close();
      if (!full || (kind === 'product' && !thumb)) return null;
      // Already a small WebP? keep the original bytes.
      if (file.type === 'image/webp' && file.size <= full.size) full = file;
      return { full: full, thumb: thumb };
    } catch (e) { return null; }
  }

  // storage = supabase client .storage; base = path WITHOUT extension, unique per upload.
  // Resolves to { path, publicUrl } of the image to store in the database, or throws the upload error.
  async function upload(storage, bucket, base, file, kind) {
    kind = kind || 'product';
    var opt = await optimize(file, kind);
    var path, res;
    if (opt) {
      path = base + '.w' + (SIZES[kind] || SIZES.product) + '.webp';
      if (opt.thumb) {
        res = await storage.from(bucket).upload(base + '.w' + THUMB + '.webp', opt.thumb, { upsert: false, contentType: 'image/webp', cacheControl: YEAR });
        if (res.error) opt = null; // thumbnail failed: fall back to the plain upload below
      }
      if (opt) res = await storage.from(bucket).upload(path, opt.full, { upsert: false, contentType: 'image/webp', cacheControl: YEAR });
    }
    if (!opt) {
      var ext = ((file.name || '').split('.').pop() || 'jpg').toLowerCase();
      path = base + '.' + ext;
      res = await storage.from(bucket).upload(path, file, { upsert: false, contentType: file.type || undefined, cacheControl: YEAR });
    }
    if (res.error) throw res.error;
    var pub = storage.from(bucket).getPublicUrl(res.data.path || path);
    return { path: res.data.path || path, publicUrl: pub && pub.data && pub.data.publicUrl };
  }

  window.umzilaImages = { optimize: optimize, upload: upload };
})();
