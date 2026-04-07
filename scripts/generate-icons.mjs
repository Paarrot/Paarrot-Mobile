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

async function main() {
  console.log('Generating icons from:', sourceIcon);
  console.log('');
  
  console.log('=== Electron Desktop Icons ===');
  await generateElectronIcons();
  console.log('');
  
  console.log('Done!');
}

main().catch(console.error);
