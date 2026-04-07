/**
 * Applies mobile-specific overlay files from the overlay/ directory on top of the cinny submodule.
 *
 * This script:
 *  1. Copies config.json (root) into cinny/config.json
 *  2. Copies all source files from overlay/src/ into cinny/src/
 *  3. Copies overlay/tsconfig.json into cinny/tsconfig.json
 *  4. Merges overlay/package-additions.json dependencies into cinny/package.json
 *  5. Copies capacitor.config.json (root) into cinny/capacitor.config.json with webDir reset to "dist"
 *  6. Creates a Windows directory junction cinny/android -> root android/ so Capacitor can find it
 *
 * Run before every Android build to keep the cinny submodule clean while layering
 * the Capacitor / Android platform changes on top of it.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CINNY = join(ROOT, 'cinny');
const OVERLAY = join(ROOT, 'overlay');

/**
 * Recursively copy all files from src directory to dest directory.
 * @param {string} src
 * @param {string} dest
 */
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
      console.log(`  overlay: ${relative(ROOT, destPath)}`);
    }
  }
}

// 1. Copy config.json to cinny/config.json
console.log('[apply-overlay] Copying config.json...');
copyFileSync(join(ROOT, 'config.json'), join(CINNY, 'config.json'));
console.log(`  copied config.json -> cinny/config.json`);

// 2. Copy overlay source files into cinny/src/
console.log('[apply-overlay] Copying source files...');
copyDirRecursive(join(OVERLAY, 'src'), join(CINNY, 'src'));

// 3. Copy tsconfig.json
console.log('[apply-overlay] Copying tsconfig.json...');
copyFileSync(join(OVERLAY, 'tsconfig.json'), join(CINNY, 'tsconfig.json'));
console.log(`  overlay: cinny/tsconfig.json`);

// 4. Merge package-additions.json into cinny/package.json
console.log('[apply-overlay] Merging package dependencies...');
const cinnyPkg = JSON.parse(readFileSync(join(CINNY, 'package.json'), 'utf8'));
const additions = JSON.parse(readFileSync(join(OVERLAY, 'package-additions.json'), 'utf8'));

cinnyPkg.dependencies = {
  ...cinnyPkg.dependencies,
  ...(additions.dependencies ?? {}),
};
if (additions.devDependencies) {
  cinnyPkg.devDependencies = {
    ...cinnyPkg.devDependencies,
    ...additions.devDependencies,
  };
}

writeFileSync(join(CINNY, 'package.json'), JSON.stringify(cinnyPkg, null, 2) + '\n', 'utf8');
console.log(`  merged ${Object.keys(additions.dependencies ?? {}).length} dep(s) into cinny/package.json`);

// 5. Copy capacitor.config.json to cinny/ with webDir corrected back to "dist"
console.log('[apply-overlay] Writing cinny/capacitor.config.json...');
const rootCapConfig = JSON.parse(readFileSync(join(ROOT, 'capacitor.config.json'), 'utf8'));
const cinnyCapConfig = { ...rootCapConfig, webDir: 'dist' };
writeFileSync(join(CINNY, 'capacitor.config.json'), JSON.stringify(cinnyCapConfig, null, 2) + '\n', 'utf8');
console.log(`  wrote cinny/capacitor.config.json (webDir: "dist")`);

// 6. Create a directory junction cinny/android -> root android/ so Capacitor CLI can find it
console.log('[apply-overlay] Setting up android/ junction...');
const androidJunction = join(CINNY, 'android');
const androidTarget = resolve(ROOT, 'android');
if (!existsSync(androidJunction)) {
  try {
    execSync(`cmd /c mklink /J "${androidJunction}" "${androidTarget}"`, { stdio: 'pipe' });
    console.log(`  created junction: cinny/android -> ${androidTarget}`);
  } catch (err) {
    console.warn('  mklink /J failed, falling back to directory copy...');
    copyDirRecursive(androidTarget, androidJunction);
    console.log(`  copied android/ into cinny/android/`);
  }
} else {
  console.log(`  android/ junction already exists, skipping`);
}

console.log('[apply-overlay] Done.');
