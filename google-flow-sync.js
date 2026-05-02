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

  await page.fill('input[name="identifier"]', email);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2000);

  await page.waitForSelector('input[name="Passwd"]', { timeout: 15000 });
  await page.fill('input[name="Passwd"]', password);
  await page.keyboard.press('Enter');

  console.log('Waiting for session-token...');
  const start = Date.now();
  let hasToken = false;
  while (Date.now() - start < 60000) {
    console.log(`URL: ${page.url()}`);
    const cookies = await context.cookies();
    hasToken = cookies.some(c => c.name === '__Secure-next-auth.session-token');
    if (hasToken) break;
    await page.waitForTimeout(2000);
  }
  if (!hasToken) throw new Error(`[${email}] session-token not found`);

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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport:  { width: 1280, height: 800 },
    locale:    'en-US',
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
