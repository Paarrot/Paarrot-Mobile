# Android App Signing Setup

## Why This Matters
Android requires apps to be signed with the same key for updates to work. Without proper signing, users cannot update your app - they must uninstall and reinstall, losing all data.

## Setup Instructions

### 1. Create a Keystore (if you don't have one)

Run this command in the `android/` directory:

```bash
keytool -genkey -v -keystore paarrot-release.keystore -alias paarrot -keyalg RSA -keysize 2048 -validity 10000
```

You'll be asked for:
- Keystore password (remember this!)
- Key password (remember this!)  
- Your name, organization, etc.

**IMPORTANT**: Back up this keystore file and remember the passwords! If you lose either, you cannot update your app.

### 2. Create keystore.properties

Copy the example file:

```bash
cp keystore.properties.example keystore.properties
```

Then edit `keystore.properties` and fill in:
- `storeFile`: path to your keystore (e.g., `paarrot-release.keystore`)
- `storePassword`: the keystore password you set
- `keyAlias`: the alias (e.g., `paarrot`)
- `keyPassword`: the key password you set

### 3. Verify

The file `keystore.properties` should be gitignored (check `.gitignore`).

### 4. Build

Now your release builds will be properly signed:

```bash
cd android
./gradlew assembleRelease
```

The signed APK will be in: `app/build/outputs/apk/release/`

## Troubleshooting

### "Updates not installing"
- You're using a different keystore than the original APK
- Solution: Use the same keystore that was used for the first release

### "keystore.properties not found"
- Normal for debug builds
- Only needed for release builds
- Create the file following step 2 above
