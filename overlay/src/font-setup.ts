const cap =
  typeof window !== 'undefined'
    ? (window as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor
    : undefined;

export const isCapacitorAndroid = Boolean(
  cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'android'
);

// Stationery signatures use Caveat on all platforms (including Android WebView).
await import('@fontsource/caveat/500.css');
await import('@fontsource/caveat/600.css');
await import('@fontsource/caveat/700.css');

if (isCapacitorAndroid) {
  document.documentElement.classList.add('android-capacitor');
  document.documentElement.style.setProperty(
    '--font-secondary',
    'system-ui, Roboto, "Noto Sans", sans-serif'
  );
} else {
  await import('@fontsource-variable/inter');
}
