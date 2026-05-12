# Paarrot 

Paarrot is a Matrix client focusing primarily on simple, elegant and secure interface. The desktop app is built with Electron and based on Cinny.
 
## Download

Installers for Windows and Linux can be downloaded from [releases](http://synbox.ruv.wtf:8418/litruv/cinny-desktop/releases).
 
Operating System | Download
---|---
Windows (x64) | <a href='http://synbox.ruv.wtf:8418/litruv/cinny-desktop/releases'>Get it on Windows</a>
Linux (AppImage) | <a href='http://synbox.ruv.wtf:8418/litruv/cinny-desktop/releases'>Get it on Linux</a>

### Linux Installation

For the best AppImage experience, we recommend using [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) which automatically integrates AppImages into your system.

## Local development

To setup development locally run the following commands:
* `git clone --recursive http://synbox.ruv.wtf:8418/litruv/cinny-desktop.git`
* `cd cinny-desktop/cinny`
* `npm ci`
* `cd ..`
* `npm ci`

To build the app locally, run:
* `npm run build`

To start local dev server, run:
* `npm run dev`

## Android build (Capacitor)

Paarrot now supports building an Android app package using Capacitor.

Prerequisites:
* Android Studio installed
* Android SDK + platform tools configured
* Java 17 (recommended for recent Android Gradle toolchains)

Build and sync Android project:
* `npm run android:prepare`

Open Android Studio project:
* `npm run android:open`

Build debug APK from terminal:
* `npm run android:apk`

Build release APK from terminal:
* `npm run android:apk:release`

Build release AAB from terminal:
* `npm run android:aab`

Artifacts are generated under:
* `cinny/android/app/build/outputs/apk/`
* `cinny/android/app/build/outputs/bundle/`
