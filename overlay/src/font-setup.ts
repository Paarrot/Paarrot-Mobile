const cap =
  typeof window !== 'undefined'
    ? (window as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor
    : undefined;

export const isCapacitorAndroid = Boolean(
  cap?.isNativePlatform?.() && cap?.getPlatform?.() === 'android'
);

if (isCapacitorAndroid) {
  document.documentElement.classList.add('android-capacitor');
  document.documentElement.style.setProperty(
    '--font-secondary',
    'system-ui, Roboto, "Noto Sans", sans-serif'
  );
} else {
  await import('@fontsource-variable/inter');
}
