/**
 * Applies mobile-specific overlay files from the overlay/ directory on top of the cinny submodule.
 *
 * This script:
 *  1. Copies config.json (root) into cinny/config.json
 *  2. Copies all source files from overlay/src/ into cinny/src/
 *  3. Copies overlay/tsconfig.json into cinny/tsconfig.json
 *  4. Merges overlay/package-additions.json dependencies into cinny/package.json
 *  5. Copies capacitor.config.json (root) into cinny/capacitor.config.json with webDir reset to "dist"
 *  6. Creates a cinny/android symlink/junction -> root android/ so Capacitor can find it
 *  7. Writes android/local.properties from ANDROID_HOME env var (so it works on any machine)
 *
 * Run before every Android build to keep the cinny submodule clean while layering
 * the Capacitor / Android platform changes on top of it.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CINNY = join(ROOT, 'cinny');
const OVERLAY = join(ROOT, 'overlay');
const STASH_FLAG = join(ROOT, '.cinny-stash-pending');

// Stash any pre-existing cinny changes so the overlay applies cleanly.
// The restore-cinny script will pop them back afterwards.
const cinnyStatus = execSync('git status --porcelain', { cwd: CINNY, encoding: 'utf8' });
if (cinnyStatus.trim()) {
  console.log('[apply-overlay] Stashing pre-existing cinny changes...');
  // Ensure android/ junction is excluded from the cinny git view — otherwise
  // `git stash -u` would traverse the junction into the root android/ directory
  // and delete files there when the stash is created.
  const cinnyExclude = join(CINNY, '.git', 'info', 'exclude');
  const excludeContent = existsSync(cinnyExclude) ? readFileSync(cinnyExclude, 'utf8') : '';
  if (!excludeContent.includes('android/')) {
    writeFileSync(cinnyExclude, excludeContent + (excludeContent.endsWith('\n') || !excludeContent ? '' : '\n') + 'android/\n', 'utf8');
  }
  execSync('git stash push -u -m "pre-overlay stash"', { cwd: CINNY, stdio: 'inherit' });
  writeFileSync(STASH_FLAG, '1', 'utf8');
  console.log('[apply-overlay] Stash saved.');
} else {
  // Ensure no stale flag from a previous interrupted run
  if (existsSync(STASH_FLAG)) unlinkSync(STASH_FLAG);
}

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

// 6. Create cinny/android -> root android/ link so Capacitor CLI can find it
console.log('[apply-overlay] Setting up android/ link...');
const androidJunction = join(CINNY, 'android');
const androidTarget = resolve(ROOT, 'android');
if (!existsSync(androidJunction)) {
  if (process.platform === 'win32') {
    try {
      execSync(`cmd /c mklink /J "${androidJunction}" "${androidTarget}"`, { stdio: 'pipe' });
      console.log(`  created junction: cinny/android -> ${androidTarget}`);
    } catch (err) {
      console.warn('  mklink /J failed, falling back to directory copy...');
      copyDirRecursive(androidTarget, androidJunction);
      console.log(`  copied android/ into cinny/android/`);
    }
  } else {
    const { symlinkSync } = await import('fs');
    symlinkSync(androidTarget, androidJunction);
    console.log(`  created symlink: cinny/android -> ${androidTarget}`);
  }
} else {
  console.log(`  android/ link already exists, skipping`);
}

// 8. Sync time-based version into android/app/build.gradle
console.log('[apply-overlay] Syncing time-based version into build.gradle...');
const buildTimestampMs = Date.now();
const versionCode = Math.floor(buildTimestampMs / 1000);
const versionName = new Date(buildTimestampMs).toISOString().replace('T', '.').replaceAll(':', '').replace('Z', '');

const buildGradlePath = join(androidTarget, 'app', 'build.gradle');
let buildGradle = readFileSync(buildGradlePath, 'utf8');
buildGradle = buildGradle
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${versionName}"`);
writeFileSync(buildGradlePath, buildGradle, 'utf8');
console.log(`  versionName "${versionName}", versionCode ${versionCode}`);

// 9. Write android/local.properties with the current machine's Android SDK path
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (androidHome) {
  console.log('[apply-overlay] Writing android/local.properties...');
  const sdkDir = process.platform === 'win32'
    ? androidHome.replace(/\\/g, '\\\\')
    : androidHome;
  writeFileSync(join(androidTarget, 'local.properties'), `sdk.dir=${sdkDir}\n`, 'utf8');
  console.log(`  sdk.dir=${androidHome}`);
} else {
  console.warn('[apply-overlay] Warning: ANDROID_HOME not set, skipping local.properties update');
}

console.log('[apply-overlay] Done.');
