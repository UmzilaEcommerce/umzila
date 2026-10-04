// Renders every product-image variant with headless Chrome → WebP (sharp).
// node render.js [filter]   — filter = substring of an output name
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const here = __dirname.replace(/\\/g, '/');
const NIMG = 'file:///C:/Users/ntand/Downloads/umzila-remote/ncekeniquads/img/';
const VEL = `file:///${here}/vel/`;
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const only = process.argv[2];

const jobs = [];
for (const m of [30, 60, 90, 120]) {
  jobs.push({ name: `nceks-ride-${m}-v2`, w: 1200, q: { k: 'ride', m, img: NIMG + `ride-${m}.webp`, logo: NIMG + 'logo.webp' } });
  jobs.push({ name: `nceks-card-${m}`, w: 960, q: { k: 'ride', ar: 'card', m, img: NIMG + `ride-${m}.webp`, logo: NIMG + 'logo.webp' } });
  jobs.push({ name: `nceks-voucher-${m}-v2`, w: 1200, q: { k: 'voucher', m, img: NIMG + `ride-${m}.webp`, logo: NIMG + 'logo.webp' } });
}
// Velaphi: each plate keeps its own photo; the label says what it is.
const vel = [
  ['6eea23e3-18b7-4e2d-a940-dfaf15a28eba', 'new_1788540494760_0', 'Plate', 'Free sides'],
  ['cb48d23a-d9dd-4b10-8033-1002c0632f2e', 'new_1790791557010_0', 'For two', 'Free sides|Serves 2'],
  ['dbb0d565-42c0-4cb2-a695-4f082271e732', 'new_1790793325457_0', '+2 wings', 'Free sides'],
  ['894556bf-afbb-49c7-be8a-bf88261dd5e6', 'new_1790793802912_0', '+3 wings', 'Free sides'],
  ['be938c34-a4ce-47ab-81fb-785bfffcf2ac', 'new_1790793923614_0', '+4 wings', 'Free sides'],
  ['92be7783-4aaf-4920-bba2-6f029e0bb441', 'new_1790794130418_0', '+6 wings', 'Free sides|Feeds a crowd']
];
for (const [id, file, t2, chips] of vel) {
  jobs.push({ name: `velaphi-${id}`, w: 1200, q: { k: 'vel', img: VEL + file + '.png', logo: VEL + 'logo.png', t2, chips } });
}

(async () => {
  for (const j of jobs) {
    if (only && !j.name.includes(only)) continue;
    const qs = Object.entries(j.q).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    const png = path.join(out, j.name + '.png');
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${j.w},1200`, '--virtual-time-budget=10000', '--allow-file-access-from-files',
      `--screenshot=${png}`, `file:///${here}/thumb.html?${qs}`], { stdio: 'ignore' });
    const webp = path.join(out, j.name + '.webp');
    await sharp(png).resize(j.w, 1200).webp({ quality: 80 }).toFile(webp);
    console.log(j.name, Math.round(fs.statSync(webp).size / 1024) + 'KB');
  }
})();
