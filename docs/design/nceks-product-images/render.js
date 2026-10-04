const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const IMG = 'file:///C:/Users/ntand/Downloads/umzila-remote/ncekeniquads/img/';
const here = __dirname.replace(/\\/g, '/');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const only = process.argv[2]; // optional: "ride-60"
(async () => {
  for (const kind of ['ride', 'voucher']) {
    for (const m of [30, 60, 90, 120]) {
      const name = `${kind}-${m}`;
      if (only && only !== name) continue;
      const url = `file:///${here}/thumb.html?k=${kind}&m=${m}&img=${encodeURIComponent(IMG + 'ride-' + m + '.webp')}&logo=${encodeURIComponent(IMG + 'logo.webp')}`;
      const png = path.join(out, name + '.png');
      execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        '--window-size=1200,1200', '--virtual-time-budget=10000', '--allow-file-access-from-files',
        `--screenshot=${png}`, url], { stdio: 'ignore' });
      const webp = path.join(out, `nceks-${name}.webp`);
      await sharp(png).resize(1200, 1200).webp({ quality: 82 }).toFile(webp);
      console.log(name, Math.round(fs.statSync(webp).size / 1024) + 'KB');
    }
  }
})();
