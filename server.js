const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let sseClients = [];

function sendStatus(message, type = 'info', progress = null) {
  const data = { message, type, progress, timestamp: new Date().toISOString() };
  console.log(`[${type.toUpperCase()}] ${message}`);
  sseClients.forEach(res => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  });
}

app.get('/status-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

app.get('/', (req, res) => res.json({ status: 'MithMill Smartlead Connector running' }));

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Launch browser ────────────────────────────────────────────────────────────
async function launchBrowser() {
  return await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
      '--disable-extensions',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

// ── Login to Smartlead ────────────────────────────────────────────────────────
async function loginSmartlead(page, email, password) {
  sendStatus('Logging in to Smartlead...', 'info');
  await page.goto('https://app.smartlead.ai/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  const url = page.url();
  if (url.includes('app.smartlead.ai') && !url.includes('login')) {
    sendStatus('✓ Already logged in to Smartlead', 'success'); return;
  }

  // Fill email
  for (const sel of ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="mail" i]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, email, { delay: 80 });
      break;
    } catch (e) {}
  }
  await delay(300);

  // Fill password
  for (const sel of ['input[type="password"]', 'input[name="password"]']) {
    try {
      await page.waitForSelector(sel, { visible: true, timeout: 4000 });
      await page.click(sel, { clickCount: 3 });
      await page.type(sel, password, { delay: 80 });
      break;
    } catch (e) {}
  }
  await delay(300);

  // Click login button
  let submitted = false;
  for (const txt of ['Log in', 'Login', 'Sign in', 'Sign In']) {
    try {
      const btns = await page.$x(`//button[contains(., '${txt}')]`);
      if (btns.length > 0) { await btns[0].click(); submitted = true; break; }
    } catch (e) {}
  }
  if (!submitted) {
    try { const b = await page.$('button[type="submit"]'); if (b) { await b.click(); submitted = true; } } catch (e) {}
  }
  if (!submitted) await page.keyboard.press('Enter');

  await delay(5000);
  try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 }); } catch (e) {}

  const finalUrl = page.url();
  console.log('Smartlead login URL:', finalUrl);
  if (finalUrl.includes('app.smartlead.ai') && !finalUrl.includes('login')) {
    sendStatus('✓ Logged in to Smartlead', 'success'); return;
  }
  throw new Error(`Smartlead login failed. URL: ${finalUrl}`);
}

// ── Get list of already connected emails ──────────────────────────────────────
async function getExistingEmails(page) {
  try {
    const emails = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr, [data-email], .email-row'));
      return rows.map(r => r.getAttribute('data-email') || r.querySelector('td')?.textContent?.trim() || '').filter(Boolean);
    });
    console.log('Existing emails:', emails);
    return emails.map(e => e.toLowerCase());
  } catch (e) {
    console.log('Could not get existing emails:', e.message);
    return [];
  }
}

// ── Connect one mailbox via Google OAuth ──────────────────────────────────────
async function connectMailbox(browser, page, email, password) {
  // Step 1: Go to email accounts page
  await page.goto('https://app.smartlead.ai/app/email-accounts/emails', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2500);

  // Check if email already connected
  const pageText = await page.evaluate(() => document.body.innerText.toLowerCase());
  if (pageText.includes(email.toLowerCase())) {
    sendStatus(`⏭ Skipping ${email} — already connected`, 'warn');
    return 'skipped';
  }

  // Step 2: Click "Connect Mailbox" button
  sendStatus(`Opening Connect Mailbox for ${email}...`, 'info');
  const connectClicked = await clickByText(page, ['Connect Mailbox', 'Connect mailbox', 'ct Mailbox', 'Add Account', 'Connect Account'], 10000);
  if (!connectClicked) throw new Error('Could not find "Connect Mailbox" button');
  await delay(2000);

  // Step 3: Select "Smartlead's Infrastructure" radio
  sendStatus('Selecting Smartlead Infrastructure...', 'info');
  const infraSelected = await page.evaluate(() => {
    // Find the Smartlead's Infrastructure option and click it
    const all = Array.from(document.querySelectorAll('*')).filter(el =>
      el.offsetParent !== null &&
      el.textContent.trim().includes("Smartlead's Infrastructure") &&
      el.children.length <= 5
    );
    if (all.length > 0) {
      // Click the radio button inside it or the element itself
      const radio = all[0].querySelector('input[type="radio"]') || all[0];
      radio.click();
      return { ok: true, text: all[0].textContent.trim().substring(0, 50) };
    }
    // Try clicking radio buttons — second one is Smartlead's Infrastructure
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(r => r.offsetParent !== null);
    if (radios.length >= 2) { radios[1].click(); return { ok: true, fallback: true }; }
    if (radios.length === 1) { radios[0].click(); return { ok: true, only: true }; }
    return { ok: false };
  });
  console.log('Infra selection:', JSON.stringify(infraSelected));
  await delay(1500);

  // Step 4: Click "Google OAuth" provider button
  sendStatus('Clicking Google OAuth...', 'info');
  const googleClicked = await clickByText(page, ['Google OAuth', 'Google Oauth', 'Google', 'Gmail'], 8000);
  if (!googleClicked) throw new Error('Could not find Google OAuth button');
  await delay(2000);

  // Step 5: Handle Google OAuth popup
  sendStatus(`Filling Google credentials for ${email}...`, 'info');
  await handleGoogleOAuthPopup(browser, page, email, password);

  return 'connected';
}

// ── Click element by one of several possible texts ───────────────────────────
async function clickByText(page, texts, timeout = 8000) {
  if (typeof texts === 'string') texts = [texts];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate((texts) => {
      for (const text of texts) {
        const els = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
          .filter(el => el.offsetParent !== null && el.textContent.trim().includes(text));
        if (els.length > 0) {
          // Prefer exact match
          const exact = els.find(el => el.textContent.trim() === text);
          (exact || els[0]).click();
          return { ok: true, text: (exact || els[0]).textContent.trim().substring(0, 40) };
        }
      }
      return { ok: false };
    }, texts);
    if (clicked.ok) {
      console.log('Clicked:', clicked.text);
      return true;
    }
    await delay(500);
  }
  return false;
}

// ── Handle Google OAuth popup ─────────────────────────────────────────────────
async function handleGoogleOAuthPopup(browser, page, email, password) {
  // Wait for a new tab/popup to open
  let popup = null;

  // Listen for new page
  const popupPromise = new Promise((resolve) => {
    browser.once('targetcreated', async target => {
      const newPage = await target.page();
      resolve(newPage);
    });
  });

  // Also check if it opened in same tab (some OAuth flows redirect in place)
  const currentUrl = page.url();
  popup = await Promise.race([
    popupPromise,
    new Promise(resolve => setTimeout(() => resolve(null), 5000))
  ]);

  if (!popup) {
    // Check if current page navigated to Google
    await delay(2000);
    const newUrl = page.url();
    if (newUrl.includes('google') || newUrl.includes('accounts')) {
      popup = page;
      console.log('OAuth opened in same tab');
    } else {
      throw new Error('Google OAuth window did not open');
    }
  }

  // Wait for Google login page to load
  try { await popup.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }); } catch (e) {}
  await delay(2000);

  console.log('OAuth popup URL:', popup.url());

  // Fill email
  for (const sel of ['input[type="email"]', '#identifierId', 'input[name="identifier"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 6000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, email, { delay: 80 });
      await popup.keyboard.press('Enter');
      await delay(2500);
      break;
    } catch (e) {}
  }

  // Fill password
  for (const sel of ['input[type="password"]', 'input[name="Passwd"]']) {
    try {
      await popup.waitForSelector(sel, { visible: true, timeout: 8000 });
      await popup.click(sel, { clickCount: 3 });
      await popup.type(sel, password, { delay: 80 });
      await popup.keyboard.press('Enter');
      await delay(3000);
      break;
    } catch (e) {}
  }

  // Click Allow/Continue if shown
  await delay(2000);
  try {
    const allowBtns = await popup.$x('//button[contains(., "Allow")] | //button[contains(., "Continue")] | //button[contains(., "Confirm")]');
    if (allowBtns.length > 0) {
      await allowBtns[0].click();
      await delay(2000);
    }
  } catch (e) {}

  // Close popup if it's separate from main page
  if (popup !== page) {
    try { await popup.close(); } catch (e) {}
  }

  await delay(2000);
  sendStatus(`✓ Google OAuth completed for ${email}`, 'success');
}

// ── /run ─────────────────────────────────────────────────────────────────────
app.post('/run', async (req, res) => {
  const { users, smartleadEmail, smartleadPassword } = req.body;
  if (!users?.length)       return res.status(400).json({ error: 'No users provided' });
  if (!smartleadEmail)      return res.status(400).json({ error: 'Smartlead email required' });
  if (!smartleadPassword)   return res.status(400).json({ error: 'Smartlead password required' });

  res.json({ ok: true, total: users.length });

  (async () => {
    let browser;
    try {
      sendStatus('Launching browser...', 'info', 0);
      browser = await launchBrowser();
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      // Block images/fonts to save memory
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
      });

      // Login to Smartlead
      await loginSmartlead(page, smartleadEmail, smartleadPassword);

      // Connect each mailbox
      let connected = 0, skipped = 0, failed = 0;
      for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const fullEmail = user.email;
        const pct = Math.round(5 + (i / users.length) * 93);
        sendStatus(`[${i + 1}/${users.length}] Connecting: ${fullEmail}`, 'info', pct);

        try {
          const result = await connectMailbox(browser, page, fullEmail, user.password);
          if (result === 'skipped') {
            skipped++;
            sendStatus(`⏭ Skipped: ${fullEmail} (already exists)`, 'warn', pct);
          } else {
            connected++;
            sendStatus(`✓ Connected: ${fullEmail}`, 'success', pct + 1);
          }
        } catch (e) {
          failed++;
          sendStatus(`✗ Failed: ${fullEmail} — ${e.message}`, 'error', pct);
          console.error('Connect error:', e.stack);
        }

        if (global.gc) global.gc();
      }

      sendStatus(`🎉 Done! Connected: ${connected} | Skipped: ${skipped} | Failed: ${failed}`, 'success', 100);

    } catch (e) {
      sendStatus(`❌ Fatal error: ${e.message}`, 'error');
      console.error('Fatal:', e.stack);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  })();
});

const PORT = process.env.PORT || 3457;
app.listen(PORT, () => console.log(`\n✅ MithMill Smartlead Connector running on port ${PORT}\n`));
