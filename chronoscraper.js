
// Zusätzliche Bibliotheken
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const puppeteer = puppeteerExtra;
const axios = require('axios');
const cheerio = require('cheerio');

const IMAGE_DIR = '/media/herando/chrono24';
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

const LISTING_WAIT_MS = 15000;
const DETAIL_AFTER_SCROLL_MS = 3000;
const COLLECT_CONCURRENCY = 60; // Batch-Größe Detailseiten

const DOWNLOAD_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.chrono24.de/',
  'Connection': 'keep-alive'
};

const customerIds = [
  10003, 10011, 10012, 10023, 10059, 10161, 10183, 10210, 10217,
  10221, 10325, 10474, 10534, 10583, 10649, 10797, 10901, 10979, 11014,
  11261, 11453, 11749, 11891, 11960, 12145, 12307, 12464, 12497, 12601,
  13073, 13747, 13841, 13889, 13957, 14000, 14028, 14103, 14294, 14365,
  14445, 14761, 14918, 14927, 14950, 14991, 15048, 15118, 15185, 15215,
  15831, 15885, 16195, 16407, 16412, 16440, 16494, 16662, 16696, 16781,
  16822, 17032, 17086, 17185, 17310, 17454, 17745, 18050, 18109, 18127,
  18664, 18995, 19053, 19121, 19201, 19243, 19515, 19699, 19718, 19793,
  19821, 20405, 20877
];

// ============================
// HELPERS
// ============================

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function generateUrl(customerId, page) {
  let url = `https://www.chrono24.de/search/index.htm?customerId=${customerId}&dosearch=true&pageSize=120&showpage=1&sortorder=5`;
  if (page > 1) url += `&showpage=${page}`;
  return url;
}

async function navigateWithRetries(page, url, options = { waitUntil: 'networkidle2', timeout: 60000 }, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🌐 Navigate to ${url} (attempt ${attempt}/${retries})`);
      await page.goto(url, options);
      return;
    } catch (error) {
      console.warn(`⚠️ Error navigating to ${url}: ${error.message}`);
      if (attempt === retries && options.waitUntil === 'networkidle2') {
        console.log(`↻ Last retry with waitUntil: 'load' → ${url}`);
        await page.goto(url, { ...options, waitUntil: 'load' });
        return;
      }
      await delay(2000);
    }
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const dist = 100;
      const timer = setInterval(() => {
        window.scrollBy(0, dist);
        total += dist;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

async function downloadImageDirect(imageUrl, savePath) {
  if (fs.existsSync(savePath)) {
    console.log(`🟡 Image already exists, skipping: ${savePath}`);
    return;
  }
  try {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
      timeout: 30000,
      headers: DOWNLOAD_HEADERS,
      validateStatus: s => s >= 200 && s < 400
    });
    fs.writeFileSync(savePath, res.data);
    console.log(`✅ Saved image: ${savePath}`);
  } catch (err) {
    console.error(`❌ HTTP download error ${imageUrl}: ${err?.response?.status || err.message}`);
  }
}

function normalizeToZoom(u) {
  if (!u) return '';
  u = u.replace(/Square\d+/i, 'Zoom').replace(/Square/i, 'Zoom');
  u = u.replace(/-ExtraLarge\./i, '-Zoom.');
  return u;
}

async function extractDetailZoomUrls(page) {
  await autoScroll(page);
  await delay(DETAIL_AFTER_SCROLL_MS);

  const html = await page.content();
  const $ = cheerio.load(html);
  const out = new Set();
  const $root = $('.listing-image-gallery');

  $root.find('.zoomable-image.js-listing-image-gallery-image').each((_, el) => {
    const u = $(el).attr('data-zoom-image') || '';
    if (/-Zoom\.(jpe?g|png|webp|gif)$/i.test(u)) out.add(u);
  });

  $root.find('img.js-listing-image-gallery-image, img.js-original-image').each((_, img) => {
    let u = $(img).attr('src') || $(img).attr('data-original') || '';
    if (!u) return;
    u = u.replace(/-ExtraLarge\.(jpe?g|png|webp|gif)$/i, '-Zoom.$1');
    if (/\/images\/uhren\/.+-Zoom\.(jpe?g|png|webp|gif)$/i.test(u)) out.add(u);
  });

  $root.find('.js-thumbnail-carousel img').each((_, img) => {
    let u = $(img).attr('data-original') || $(img).attr('src') || '';
    if (!u) return;
    u = u.replace(/-Square\d+\.(jpe?g|png|webp|gif)$/i, '-Zoom.$1')
         .replace(/-Square\.(jpe?g|png|webp|gif)$/i, '-Zoom.$1');
    if (/\/images\/uhren\/.+-Zoom\.(jpe?g|png|webp|gif)$/i.test(u)) out.add(u);
  });

  return Array.from(out);
}

// ============================
// MAIN SCRAPER
// ============================

(async () => {
  console.log('🚀 Starting Chrono24 scraper...');

  for (const customerId of customerIds) {
    console.log(`=== Processing customer ${customerId} ===`);

    for (let pageNum = 1; pageNum <= 1; pageNum++) {
      const listUrl = generateUrl(customerId, pageNum);
      let browser = null;

      try {
        console.log(`>>> NEW BROWSER for customer ${customerId}, page ${pageNum}`);
        browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
          protocolTimeout: 120000
        });

        const page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' });

        await navigateWithRetries(page, listUrl);
        await delay(LISTING_WAIT_MS);

        let listings = [];
        try {
          await page.waitForSelector('a.rcard', { timeout: 10000 });
          listings = await page.$$eval('a.rcard', cards =>
            cards.map(card => {
              let href = card.getAttribute('href') || '';
              if (href.startsWith('/')) href = 'https://www.chrono24.de' + href;
              return { href };
            })
          );
        } catch {
          console.log(`⚠️ No listings on page ${pageNum} for customer ${customerId}.`);
          await page.close();
          await browser.close().catch(() => {});
          break;
        }
        await page.close();
        console.log(`📄 Found ${listings.length} listings on page ${pageNum}`);

        for (let i = 0; i < listings.length; i += COLLECT_CONCURRENCY) {
          const batch = listings.slice(i, i + COLLECT_CONCURRENCY);
          console.log(`🧩 Process batch ${i / COLLECT_CONCURRENCY + 1} (${batch.length} items)`);

          await Promise.all(batch.map(async listing => {
            const detailPage = await browser.newPage();
            try {
              const id = listing.href.match(/id(\d+)/)?.[1] || 'unknown';
              const folder = path.join(IMAGE_DIR, id);
              if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

              await detailPage.setUserAgent(USER_AGENT);
              await detailPage.setExtraHTTPHeaders({
                'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                'Referer': 'https://www.chrono24.de/'
              });

              console.log(`🔎 Navigating detail ${listing.href}`);
              await navigateWithRetries(detailPage, listing.href);

              const zoomUrls = await extractDetailZoomUrls(detailPage);
              console.log(`📸 Collected ${zoomUrls.length} Zoom images for ${listing.href}`);

              const candidates = zoomUrls.map(u => {
                try {
                  const filename = path.basename(new URL(u).pathname);
                  return { url: u, filename };
                } catch {
                  return null;
                }
              }).filter(Boolean);

              const missing = candidates.filter(c => !fs.existsSync(path.join(folder, c.filename)));

              if (missing.length === 0) {
                console.log(`🟢 All images exist for ${id}. Skipping.`);
              } else {
                console.log(`⬇️ Downloading ${missing.length}/${candidates.length} images for ${id}`);
                for (const c of missing) {
                  const savePath = path.join(folder, c.filename);
                  await downloadImageDirect(c.url, savePath);
                }
              }
            } catch (err) {
              console.error(`❌ Detail error for ${listing.href}: ${err.message}`);
            } finally {
              try { await detailPage.close(); } catch {}
            }
          }));

          await delay(1500 + Math.floor(Math.random() * 800));
        }

        await browser.close().catch(() => {});
        console.log(`✅ Browser closed for customer ${customerId}, page ${pageNum}`);
        await delay(2000);

      } catch (fatal) {
        console.error(`💣 Fatal page error for customer ${customerId}, page ${pageNum}: ${fatal.message}`);
        if (browser) {
          try { await browser.close(); } catch {}
          console.log(`(Closed browser after fatal page error)`);
        }
        await delay(2000);
      }
    }

    console.log(`=== Finished customer ${customerId} ===`);
    await delay(4000);
  }

  console.log('🎉 Scraping finished for all customers');
})();
