/**
 * @file android-emulator.ts
 * @description Manages Android emulator running in the same GitHub Actions runner.
 * 
 * The emulator runs via scrcpy mirrored to the existing X11 display (DISPLAY=:99)
 * which is already exposed via noVNC + Cloudflare tunnel.
 */

import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let emulatorProcess: ChildProcess | null = null;
let scrcpyProcess: ChildProcess | null = null;
let isEmulatorRunning = false;
let emulatorStartTime: Date | null = null;

/**
 * Checks if Android SDK and emulator are available in the environment.
 */
async function checkAndroidEnvironment(): Promise<{ available: boolean; error?: string }> {
  try {
    // Check if ANDROID_HOME is set
    if (!process.env.ANDROID_HOME) {
      return { available: false, error: 'ANDROID_HOME not set' };
    }

    // Check if emulator binary exists
    await execAsync('which emulator');
    await execAsync('which adb');
    
    return { available: true };
  } catch (err) {
    return { available: false, error: 'Android SDK not installed' };
  }
}

/**
 * Creates an Android Virtual Device (AVD) if it doesn't exist.
 */
async function ensureAVDExists(): Promise<void> {
  try {
    // Check if AVD already exists
    const { stdout } = await execAsync('avdmanager list avd');
    
    if (stdout.includes('android_emulator')) {
      console.log('✅ AVD "android_emulator" already exists');
      return;
    }

    console.log('📱 Creating Android AVD...');
    
    // Create AVD with Pixel 5 profile, Android 13 (API 33)
    await execAsync(
      'echo "no" | avdmanager create avd ' +
      '--force ' +
      '--name android_emulator ' +
      '--package "system-images;android-33;google_apis;x86_64" ' +
      '--device "pixel_5" ' +
      '--abi x86_64'
    );
    
    console.log('✅ AVD created successfully');
  } catch (err) {
    throw new Error(`Failed to create AVD: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Starts the Android emulator in the background.
 * The emulator will be visible via scrcpy on the existing X11 display.
 */
export async function startAndroidEmulator(): Promise<{
  success: boolean;
  message: string;
  vncUrl?: string;
  error?: string;
}> {
  if (isEmulatorRunning) {
    return {
      success: false,
      message: 'Android emulator is already running',
      error: 'Stop the current session first with .android stop',
    };
  }

  try {
    // Check environment
    const envCheck = await checkAndroidEnvironment();
    if (!envCheck.available) {
      return {
        success: false,
        message: 'Android SDK not available',
        error: envCheck.error || 'Android SDK not installed in this environment',
      };
    }

    // Ensure AVD exists
    await ensureAVDExists();

    console.log('🚀 Starting Android emulator...');

    // Start emulator in background
    const androidHome = process.env.ANDROID_HOME;
    emulatorProcess = spawn(
      `${androidHome}/emulator/emulator`,
      [
        '-avd', 'android_emulator',
        '-no-snapshot-save',
        '-no-audio',
        '-gpu', 'swiftshader_indirect',
        '-camera-back', 'none',
        '-camera-front', 'none',
        '-memory', '4096',
        '-cores', '2',
        '-accel', 'on',
      ],
      {
        env: { ...process.env, DISPLAY: ':99' },
        detached: false,
      }
    );

    emulatorProcess.stdout?.on('data', (data) => {
      console.log('[emulator]', data.toString().trim());
    });

    emulatorProcess.stderr?.on('data', (data) => {
      console.log('[emulator]', data.toString().trim());
    });

    emulatorProcess.on('error', (err) => {
      console.error('❌ Emulator process error:', err);
      isEmulatorRunning = false;
    });

    emulatorProcess.on('exit', (code) => {
      console.log(`⚠️ Emulator exited with code ${code}`);
      isEmulatorRunning = false;
      emulatorProcess = null;
      scrcpyProcess = null;
    });

    // Wait for emulator to boot (this can take 1-2 minutes)
    console.log('⏳ Waiting for emulator to boot (this may take 1-2 minutes)...');
    
    await execAsync('adb wait-for-device shell \'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done\'', {
      timeout: 180000, // 3 minutes timeout
    });

    console.log('✅ Android emulator booted successfully!');

    // Start scrcpy to mirror the Android screen to X11 display
    console.log('🖥️ Starting scrcpy screen mirroring...');
    
    scrcpyProcess = spawn(
      'scrcpy',
      [
        '--max-size', '1280',
        '--window-title', 'Android Emulator',
        '--window-x', '50',
        '--window-y', '50',
      ],
      {
        env: { ...process.env, DISPLAY: ':99' },
        detached: false,
      }
    );

    scrcpyProcess.stdout?.on('data', (data) => {
      console.log('[scrcpy]', data.toString().trim());
    });

    scrcpyProcess.stderr?.on('data', (data) => {
      console.log('[scrcpy]', data.toString().trim());
    });

    scrcpyProcess.on('error', (err) => {
      console.error('❌ scrcpy error:', err);
    });

    isEmulatorRunning = true;
    emulatorStartTime = new Date();

    // Get the noVNC URL (already exposed via Cloudflare tunnel)
    const { getCloudflareTunnelUrl } = require('./cloudflared');
    const vncUrl = await getCloudflareTunnelUrl(6080);

    return {
      success: true,
      message: 'Android emulator started successfully',
      vncUrl: vncUrl || 'Check .url command for noVNC link',
    };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to start Android emulator:', errMsg);
    
    // Cleanup on failure
    if (emulatorProcess) {
      emulatorProcess.kill();
      emulatorProcess = null;
    }
    if (scrcpyProcess) {
      scrcpyProcess.kill();
      scrcpyProcess = null;
    }
    isEmulatorRunning = false;

    return {
      success: false,
      message: 'Failed to start Android emulator',
      error: errMsg,
    };
  }
}

/**
 * Gets the current Android emulator status.
 */
export async function getAndroidEmulatorStatus(): Promise<{
  running: boolean;
  uptime?: string;
  deviceInfo?: string;
  vncUrl?: string;
}> {
  if (!isEmulatorRunning) {
    return { running: false };
  }

  try {
    // Check if emulator is still connected
    const { stdout } = await execAsync('adb devices');
    const hasEmulator = stdout.includes('emulator-');

    if (!hasEmulator) {
      isEmulatorRunning = false;
      return { running: false };
    }

    // Calculate uptime
    let uptime = 'Unknown';
    if (emulatorStartTime) {
      const uptimeMs = Date.now() - emulatorStartTime.getTime();
      const minutes = Math.floor(uptimeMs / 60000);
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      uptime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    // Get device info
    const { stdout: androidVersion } = await execAsync('adb shell getprop ro.build.version.release');
    const { stdout: deviceModel } = await execAsync('adb shell getprop ro.product.model');

    const deviceInfo = `Android ${androidVersion.trim()} - ${deviceModel.trim()}`;

    // Get noVNC URL
    const { getCloudflareTunnelUrl } = require('./cloudflared');
    const vncUrl = await getCloudflareTunnelUrl(6080);

    return {
      running: true,
      uptime,
      deviceInfo,
      vncUrl: vncUrl || undefined,
    };

  } catch (err) {
    console.error('Error getting emulator status:', err);
    return { running: false };
  }
}

/**
 * Stops the Android emulator.
 */
export async function stopAndroidEmulator(): Promise<{
  success: boolean;
  message: string;
}> {
  if (!isEmulatorRunning) {
    return {
      success: false,
      message: 'No Android emulator is running',
    };
  }

  try {
    console.log('🛑 Stopping Android emulator...');

    // Kill scrcpy first
    if (scrcpyProcess) {
      scrcpyProcess.kill('SIGTERM');
      scrcpyProcess = null;
    }

    // Kill emulator
    if (emulatorProcess) {
      emulatorProcess.kill('SIGTERM');
      emulatorProcess = null;
    }

    // Also kill via adb
    try {
      await execAsync('adb emu kill');
    } catch {
      // Ignore errors
    }

    isEmulatorRunning = false;
    emulatorStartTime = null;

    console.log('✅ Android emulator stopped');

    return {
      success: true,
      message: 'Android emulator stopped successfully',
    };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('❌ Failed to stop emulator:', errMsg);
    return {
      success: false,
      message: `Failed to stop emulator: ${errMsg}`,
    };
  }
}

/**
 * Installs an APK file on the running emulator.
 */
export async function installApk(apkPath: string): Promise<{
  success: boolean;
  message: string;
}> {
  if (!isEmulatorRunning) {
    return {
      success: false,
      message: 'No Android emulator is running',
    };
  }

  try {
    console.log(`📦 Installing APK: ${apkPath}`);
    await execAsync(`adb install -r "${apkPath}"`);
    
    return {
      success: true,
      message: 'APK installed successfully',
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message: `Failed to install APK: ${errMsg}`,
    };
  }
}
