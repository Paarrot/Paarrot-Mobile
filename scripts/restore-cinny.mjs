/**
 * Restores the cinny submodule to its pre-build state after an Android build.
 *
 * This script:
 *  1. Reverts all tracked file changes made by apply-overlay (git checkout)
 *  2. Removes untracked overlay files (capacitor.config.json)
 *  3. Removes the cinny/android junction
 *  4. Pops the pre-overlay git stash if apply-overlay saved one
 */

import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CINNY = join(ROOT, 'cinny');
const STASH_FLAG = join(ROOT, '.cinny-stash-pending');

// 1. Revert all tracked overlay modifications
console.log('[restore-cinny] Reverting tracked changes...');
execSync('git checkout -- .', { cwd: CINNY, stdio: 'inherit' });

// Restore android/capacitor.settings.gradle patched by apply-overlay
console.log('[restore-cinny] Restoring android/capacitor.settings.gradle...');
try {
  execSync('git checkout -- android/capacitor.settings.gradle', { cwd: ROOT, stdio: 'inherit' });
  console.log('[restore-cinny] Restored android/capacitor.settings.gradle');
} catch {
  console.warn('[restore-cinny] Could not restore capacitor.settings.gradle (may not be modified)');
}

// 2. Remove untracked capacitor.config.json written by the overlay
const capConfig = join(CINNY, 'capacitor.config.json');
if (existsSync(capConfig)) {
  unlinkSync(capConfig);
  console.log('[restore-cinny] Removed cinny/capacitor.config.json');
}

// 3. Remove the android link (junction on Windows, symlink on Linux)
const androidJunction = join(CINNY, 'android');
if (existsSync(androidJunction)) {
  try {
    if (process.platform === 'win32') {
      execSync(`cmd /c rmdir "${androidJunction}"`, { stdio: 'pipe' });
    } else {
      unlinkSync(androidJunction);
    }
    console.log('[restore-cinny] Removed cinny/android link');
  } catch (err) {
    console.warn('[restore-cinny] Could not remove android link:', err.message);
  }
}

// 4. Pop stash if apply-overlay saved one
if (existsSync(STASH_FLAG)) {
  console.log('[restore-cinny] Popping pre-overlay stash...');
  try {
    execSync('git stash pop', { cwd: CINNY, stdio: 'inherit' });
    console.log('[restore-cinny] Stash restored.');
  } catch (err) {
    console.warn('[restore-cinny] Stash pop failed (may have conflicts):', err.message);
  }
  unlinkSync(STASH_FLAG);
}

console.log('[restore-cinny] Done. cinny submodule is clean.');
