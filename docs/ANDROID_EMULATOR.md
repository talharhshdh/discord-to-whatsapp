# 📱 Android Emulator Feature

The Discord-WhatsApp Bridge now includes a full Android 13 emulator that runs directly in your GitHub Actions runner and is accessible via your browser through noVNC.

## 🎯 Overview

- **Android Version**: Android 13 (API 33)
- **Device Profile**: Google Pixel 5
- **Access Method**: noVNC (browser-based VNC client)
- **Startup Time**: 2-3 minutes
- **Session Duration**: Same as your GitHub Actions session (5 hours by default)

## 🚀 Quick Start

### Via WhatsApp

Send these commands to your bot:

```
.android start    # Start the emulator (takes 2-3 minutes)
.android status   # Check if emulator is running
.android stop     # Stop the emulator
```

### Via Dashboard

1. Open your dashboard URL (sent to WhatsApp on bot startup)
2. Navigate to the **📱 Android** section
3. Click **▶️ Start Emulator**
4. Wait 2-3 minutes for boot
5. Access via the noVNC link (also available via `.url` command)

## 🔧 How It Works

### Architecture

```
GitHub Actions Runner
├── Xvfb (Virtual Display :99)
│   ├── Fluxbox (Window Manager)
│   ├── Android Emulator (AVD)
│   └── scrcpy (Screen Mirroring)
├── x11vnc (VNC Server on :5900)
├── websockify (WebSocket proxy on :6080)
├── noVNC (Web VNC Client)
└── Cloudflare Tunnel (Public HTTPS URL)
```

### Components

1. **Android Emulator**: Runs the actual Android system using KVM acceleration
2. **scrcpy**: Mirrors the Android screen to the X11 display
3. **noVNC**: Provides browser-based access to the virtual display
4. **Cloudflare Tunnel**: Exposes noVNC publicly with HTTPS

## 📋 Features

✅ Full Android 13 system with Google APIs  
✅ Hardware acceleration (KVM) for smooth performance  
✅ 4GB RAM, 2 CPU cores allocated  
✅ Touch and keyboard support in browser  
✅ ADB access for app installation  
✅ Screen mirroring via scrcpy  
✅ Persistent during GitHub Actions session  

## 🎮 Usage Examples

### Install an APK

While the emulator is running, you can install APKs via ADB:

```bash
# In the GitHub Actions runner (via terminal or SSH)
adb devices
adb install -r /path/to/app.apk
```

### Take Screenshots

```bash
adb shell screencap -p /sdcard/screenshot.png
adb pull /sdcard/screenshot.png
```

### Run Shell Commands

```bash
adb shell
# Now you're in the Android shell
pm list packages
am start -n com.android.settings/.Settings
```

### Access via Browser

1. Get the noVNC URL:
   - Send `.url` command in WhatsApp
   - Or check the dashboard **🔗 Live URLs** section
2. Open the URL in your browser
3. You'll see the Android emulator screen
4. Click and interact just like a real device

## ⚙️ Configuration

### Emulator Specs

The emulator is configured in `src/libs/android-emulator.ts`:

```typescript
{
  avd: 'android_emulator',
  memory: '4096',      // 4GB RAM
  cores: '2',          // 2 CPU cores
  gpu: 'swiftshader_indirect',
  accel: 'on'          // KVM acceleration
}
```

### AVD Profile

- **Device**: Pixel 5
- **System Image**: `system-images;android-33;google_apis;x86_64`
- **ABI**: x86_64 (for KVM acceleration)

### Modify Settings

To change the Android version or device profile, edit `.github/workflows/run-bridge.yml`:

```yaml
- name: Install Android Emulator and System Image
  run: |
    # Change android-33 to android-34 for Android 14
    sdkmanager --install "system-images;android-33;google_apis;x86_64"
```

And update `src/libs/android-emulator.ts`:

```typescript
await execAsync(
  'echo "no" | avdmanager create avd ' +
  '--force ' +
  '--name android_emulator ' +
  '--package "system-images;android-33;google_apis;x86_64" ' +
  '--device "pixel_5"'  // Change to "pixel_6" or other device
);
```

## 🐛 Troubleshooting

### Emulator Won't Start

**Error**: `Android SDK not available`

**Solution**: The Android SDK setup in the GitHub Actions workflow may have failed. Check the workflow logs:

```yaml
- name: Setup Android SDK (optional - for .android command)
  uses: android-actions/setup-android@v3
  continue-on-error: true
```

The `continue-on-error: true` means the bot will still run even if Android setup fails. Remove this line if you want Android to be mandatory.

### Emulator is Slow

**Cause**: KVM acceleration may not be available in the GitHub Actions runner.

**Solution**: GitHub Actions runners have KVM enabled, but if performance is poor:

1. Check KVM is enabled:
   ```bash
   ls -la /dev/kvm
   ```

2. Reduce emulator resources in `android-emulator.ts`:
   ```typescript
   '-memory', '2048',  // Reduce from 4096 to 2048
   '-cores', '1',      // Reduce from 2 to 1
   ```

### Can't See Android Screen in noVNC

**Cause**: scrcpy may not have started properly.

**Solution**: Check the logs in GitHub Actions. The scrcpy process should show:

```
[scrcpy] scrcpy 2.x <https://github.com/Genymobile/scrcpy>
[scrcpy] INFO: Connected to device
```

If scrcpy fails, the emulator is still running but not visible. Restart with `.android stop` then `.android start`.

### Emulator Stops Unexpectedly

**Cause**: The emulator process may have crashed or been killed.

**Solution**: Check the status with `.android status`. If it shows as not running, restart with `.android start`.

## 🔒 Security Notes

- The noVNC URL is publicly accessible via Cloudflare Tunnel
- Anyone with the URL can access your Android emulator
- The URL changes every session (unless using a named tunnel)
- Consider adding authentication if using a named tunnel
- The emulator has no persistent storage - everything is reset on restart

## 📊 Performance

### Startup Time
- **Cold start**: ~2-3 minutes (includes AVD creation + boot)
- **Warm start**: ~1-2 minutes (AVD already exists)

### Resource Usage
- **RAM**: ~4GB allocated to emulator
- **CPU**: 2 cores allocated
- **Disk**: ~8GB for system image + AVD

### Limitations
- GitHub Actions runners have 7GB RAM total, so 4GB for emulator leaves 3GB for the bot
- Session duration is limited to 6 hours maximum
- No GPU acceleration (uses software rendering)

## 🎯 Use Cases

### App Testing
- Test Android apps without a physical device
- Automated UI testing with Appium
- Screenshot testing across different Android versions

### Automation
- Run Android automation scripts
- Test WhatsApp Business API integrations
- Automate social media apps

### Development
- Debug Android apps remotely
- Test APKs before release
- Reproduce user-reported bugs

### Remote Access
- Access Android apps from anywhere
- Use Android-only apps on any device
- Share Android screen with team members

## 🔗 Related Commands

- `.url` - Get all live URLs including noVNC
- `.terminal` - Start a web terminal (can run adb commands)
- `.vscode` - Start VSCode server (can edit Android project files)

## 📚 Additional Resources

- [Android Emulator Documentation](https://developer.android.com/studio/run/emulator)
- [scrcpy GitHub](https://github.com/Genymobile/scrcpy)
- [noVNC GitHub](https://github.com/novnc/noVNC)
- [ADB Commands Cheat Sheet](https://developer.android.com/studio/command-line/adb)
