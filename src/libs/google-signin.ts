import puppeteer from 'puppeteer-core';

/**
 * Automates Google account sign-in inside the running Chromium container.
 * Connects via CDP on the given host port (socat-bridged).
 * Returns true on success, false on failure.
 */
export async function signIntoGoogle(cdpPort: number): Promise<boolean> {
  const email = process.env.BROWSER_GOOGLE_SIGN_IN_EMAIL;
  const password = process.env.BROWSER_GOOGLE_SIGN_IN_PASSWORD;

  if (!email || !password) {
    console.log('[Google Sign-In] Email or password not provided in env — skipping.');
    return false;
  }

  try {
    console.log(`[Google Sign-In] Connecting to browser CDP on port ${cdpPort}...`);
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}` });
    const page = await browser.newPage();

    console.log('[Google Sign-In] Navigating to Google Sign-In page...');
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2' });

    // Fill email
    await page.waitForSelector('input[type="email"]', { visible: true });
    await page.type('input[type="email"]', email, { delay: 60 });
    await page.keyboard.press('Enter');

    // Wait for password field (Google has an animated transition)
    console.log('[Google Sign-In] Waiting for password field...');
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 20000 });
    await new Promise(r => setTimeout(r, 1200));

    // Fill password
    await page.type('input[type="password"]', password, { delay: 60 });
    await page.keyboard.press('Enter');

    // Wait for navigation after submit
    console.log('[Google Sign-In] Waiting for sign-in to complete...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

    // Confirm we are no longer on an accounts.google.com/signin page
    const finalUrl = page.url();
    const success = !finalUrl.includes('accounts.google.com/signin');

    if (success) {
      console.log(`[Google Sign-In] ✅ Signed in successfully. Current URL: ${finalUrl}`);
    } else {
      console.warn(`[Google Sign-In] ⚠️ Sign-in may have failed. Current URL: ${finalUrl}`);
    }

    await page.close();
    browser.disconnect();
    return success;
  } catch (error) {
    console.error('[Google Sign-In] ❌ Failed:', error);
    return false;
  }
}
