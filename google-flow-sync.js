const { chromium } = require('playwright');
require('dotenv').config();
const https = require('https');

function loadAccounts() {
  const accounts = [];
  let i = 1;
  while (process.env[`ACCOUNT_${i}_EMAIL`]) {
    accounts.push({
      index:    i,
      email:    process.env[`ACCOUNT_${i}_EMAIL`],
      password: process.env[`ACCOUNT_${i}_PASSWORD`],
      toolId:   parseInt(process.env[`ACCOUNT_${i}_TOOL_ID`]),
    });
    i++;
  }
  if (accounts.length === 0) throw new Error('No accounts in .env');
  return accounts;
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function saveSessionViaAPI(toolId, cookies) {
  const payload = { toolSessions: [{ sessionId: toolId, data: cookies }] };
  console.log(`[toolId=${toolId}] Sending to API...`);
  const response = await fetch(process.env.API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'X-Sync-Api-Key': process.env.API_SECRET,
    },
    body:  JSON.stringify(payload),
    agent: httpsAgent,
  });
  const resText = await response.text();
  console.log(`[toolId=${toolId}] Status: ${response.status} | Body: ${resText}`);
  if (!response.ok) throw new Error(`API Error ${response.status}: ${resText}`);
  return JSON.parse(resText);
}

async function loginToGoogleFlow(page, context, email, password) {
  console.log(`[${email}] Loading Flow page...`);
  await page.goto('https://labs.google/fx/tools/flow', {
    waitUntil: 'domcontentloaded',
    timeout:   60000,
  });
  console.log(`Landed: ${page.url()}`);

  // Wait for React to render buttons
  await page.waitForTimeout(6000);

  const buttons = await page.$$eval('button', els => els.map(e => e.innerText.trim()).filter(Boolean));
  console.log('Buttons:', JSON.stringify(buttons));

  // Click whichever button triggers Google OAuth
  const label = buttons.find(b =>
    b.toLowerCase().includes('create') ||
    b.toLowerCase().includes('sign') ||
    b.toLowerCase().includes('get started') ||
    b.toLowerCase().includes('flow')
  );
  if (!label) throw new Error(`No sign-in button found. Buttons: ${JSON.stringify(buttons)}`);

  console.log(`Clicking: "${label}"`);
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(4000);
  console.log(`After click: ${page.url()}`);

  // Google may show an account chooser or sign-in page
  await page.waitForSelector('input[name="identifier"]', { timeout: 30000 });
  console.log('Google login page ready');

  // Human-like typing for email
  await page.click('input[name="identifier"]');
  await page.waitForTimeout(500);
  await page.type('input[name="identifier"]', email, { delay: 80 });
  await page.waitForTimeout(800);
  const emailNext = await page.$('#identifierNext');
  if (emailNext) await emailNext.click();
  else await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  await page.waitForSelector('input[name="Passwd"]', { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Human-like typing for password
  await page.click('input[name="Passwd"]');
  await page.waitForTimeout(400);
  await page.type('input[name="Passwd"]', password, { delay: 90 });
  await page.waitForTimeout(800);

  const passNext = await page.$('#passwordNext');
  console.log(`passwordNext button found: ${!!passNext}`);
  if (passNext) await passNext.click();
  else await page.keyboard.press('Enter');

  console.log('Waiting for redirect after password...');
  try {
    await page.waitForURL(url => !url.includes('accounts.google.com/v3/signin/challenge/pwd'), { timeout: 20000 });
  } catch {
    const stuck = page.url();
    if (stuck.includes('challenge/pwd')) throw new Error(`[${email}] Password rejected or CAPTCHA shown: ${stuck}`);
  }
  console.log(`After password: ${page.url()}`);

  console.log('Waiting for session-token...');
  const start = Date.now();
  let hasToken = false;
  while (Date.now() - start < 60000) {
    const curUrl = page.url();
    console.log(`URL: ${curUrl}`);
    const cookies = await context.cookies();
    hasToken = cookies.some(c => c.name === '__Secure-next-auth.session-token');
    if (hasToken) break;
    if (curUrl.includes('accounts.google.com') && (curUrl.includes('challenge') || curUrl.includes('signin'))) {
      console.log('Still on Google auth page, waiting...');
    }
    await page.waitForTimeout(3000);
  }
  if (!hasToken) throw new Error(`[${email}] session-token not found — final URL: ${page.url()}`);

  // Load Flow page to capture all labs.google cookies
  await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  console.log(`[${email}] Login complete`);
}

async function processAccount(account) {
  console.log(`\nAccount ${account.index}: ${account.email} (toolId=${account.toolId})`);

  const browser = await chromium.launch({
    headless: false,   // xvfb-run handles the display
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,800',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale:   'en-US',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    await loginToGoogleFlow(page, context, account.email, account.password);

    const allCookies  = await context.cookies();
    const flowCookies = allCookies.filter(c => c.domain.includes('labs.google'));
    console.log(`${flowCookies.length} cookies captured`);

    await saveSessionViaAPI(account.toolId, flowCookies);
    console.log(`[toolId=${account.toolId}] DB updated`);
  } finally {
    await context.close();
    await browser.close();
  }
}

(async () => {
  const accounts = loadAccounts();
  console.log(`Starting -- ${accounts.length} account(s)`);
  let passed = 0, failed = 0;
  for (const account of accounts) {
    try { await processAccount(account); passed++; }
    catch (err) { console.error(`FAILED [toolId=${account.toolId}] ${err.message}`); failed++; }
  }
  console.log(`\nDone -- ${passed} success, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
