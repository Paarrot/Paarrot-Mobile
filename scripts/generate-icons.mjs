import sharp from 'sharp';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import png2icons from 'png2icons';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const sourceIcon = path.join(rootDir, 'appicon-square.png');

// Electron desktop icons
const electronIcons = [
  { name: '16x16.png', size: 16 },
  { name: '24x24.png', size: 24 },
  { name: '32x32.png', size: 32 },
  { name: '48x48.png', size: 48 },
  { name: '64x64.png', size: 64 },
  { name: '128x128.png', size: 128 },
  { name: '256x256.png', size: 256 },
  { name: '512x512.png', size: 512 },
  { name: '1024x1024.png', size: 1024 },
  { name: 'icon.png', size: 512 },
];

async function generateElectronIcons() {
  const iconsDir = path.join(rootDir, 'icons');
  
  // Ensure icons directory exists
  await fs.mkdir(iconsDir, { recursive: true });
  
  for (const icon of electronIcons) {
    const outputPath = path.join(iconsDir, icon.name);
    await sharp(sourceIcon)
      .resize(icon.size, icon.size)
      .png()
      .toFile(outputPath);
    console.log(`Generated: ${icon.name}`);
  }

  // Generate ICO file (Windows)
  const sourceBuffer = await fs.readFile(sourceIcon);
  const icoBuffer = png2icons.createICO(sourceBuffer, png2icons.BEZIER, 0, true, true);
  await fs.writeFile(path.join(iconsDir, 'icon.ico'), icoBuffer);
  console.log('Generated: icon.ico');

  // Generate ICNS file (macOS)
  const icnsBuffer = png2icons.createICNS(sourceBuffer, png2icons.BEZIER, 0);
  await fs.writeFile(path.join(iconsDir, 'icon.icns'), icnsBuffer);
  console.log('Generated: icon.icns');
}

/**
 * Android adaptive icon density configs.
 * Foreground canvas = 108dp equivalent. Safe zone = center 72dp (66.7%).
 * Legacy launcher icon = 48dp equivalent.
 * @type {Array<{density: string, foregroundSize: number, launcherSize: number}>}
 */
const androidDensities = [
  { density: 'mipmap-mdpi',    foregroundSize: 108, launcherSize: 48  },
  { density: 'mipmap-hdpi',    foregroundSize: 162, launcherSize: 72  },
  { density: 'mipmap-xhdpi',   foregroundSize: 216, launcherSize: 96  },
  { density: 'mipmap-xxhdpi',  foregroundSize: 324, launcherSize: 144 },
  { density: 'mipmap-xxxhdpi', foregroundSize: 432, launcherSize: 192 },
];

/**
 * Generates Android mipmap launcher icons from the source icon.
 * The foreground layer centers the content within the adaptive icon safe zone
 * (72/108dp = 66.7% of canvas), leaving transparent padding for the system mask.
 */
async function generateAndroidIcons() {
  const resDir = path.join(rootDir, 'android', 'app', 'src', 'main', 'res');

  for (const { density, foregroundSize, launcherSize } of androidDensities) {
    const dir = path.join(resDir, density);

    // Foreground layer: content occupies 72/108 of the canvas (safe zone), centered
    const contentSize = Math.round(foregroundSize * (72 / 108));
    const padding = Math.round((foregroundSize - contentSize) / 2);

    const foregroundBuffer = await sharp(sourceIcon)
      .resize(contentSize, contentSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .extend({ top: padding, bottom: padding, left: padding, right: padding, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    await fs.writeFile(path.join(dir, 'ic_launcher_foreground.png'), foregroundBuffer);
    console.log(`${density}/ic_launcher_foreground.png (${foregroundSize}x${foregroundSize}, content ${contentSize}px)`);

    // Legacy launcher icon (ic_launcher, ic_launcher_round) — plain square resize
    const legacyBuffer = await sharp(sourceIcon)
      .resize(launcherSize, launcherSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    await fs.writeFile(path.join(dir, 'ic_launcher.png'), legacyBuffer);
    await fs.writeFile(path.join(dir, 'ic_launcher_round.png'), legacyBuffer);
    console.log(`${density}/ic_launcher.png + ic_launcher_round.png (${launcherSize}x${launcherSize})`);
  }
}

async function main() {
  console.log('Generating icons from:', sourceIcon);
  console.log('');

  console.log('=== Electron Desktop Icons ===');
  await generateElectronIcons();
  console.log('');

  console.log('=== Android Mipmap Icons ===');
  await generateAndroidIcons();
  console.log('');

  console.log('Done!');
}

main().catch(console.error);
