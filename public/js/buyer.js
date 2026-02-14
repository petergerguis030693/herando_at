// public/js/buyer.js

document.addEventListener('DOMContentLoaded', () => {
  console.log('[Wishlist Debug] DOM geladen');
  const ALLOWED_ROUTES = new Set(['cars', 'watches', 'properties', 'yachts', 'lifestyles']);

  // 1) Zeige alle vorhandenen Storage-Keys
  console.log('[Wishlist Debug] alle localStorage-Keys =', Object.keys(localStorage));

  // 2) Section und Grid finden
  const section = document.getElementById('wishlistSection');
  if (!section) {
    console.log('[Wishlist Debug] Keine wishlistSection gefunden – Skript stoppt');
    return;
  }
  console.log('[Wishlist Debug] wishlistSection gefunden');
  section.style.display = 'block';

  const grid = document.getElementById('wishlistGrid');
  if (!grid) {
    console.log('[Wishlist Debug] Kein wishlistGrid gefunden – Skript stoppt');
    return;
  }

  // 3) Rohdaten aus localStorage auslesen (richtiger Key!)
  const raw = localStorage.getItem('herandoBookmarks');
  console.log('[Wishlist Debug] raw localStorage.herandoBookmarks =', raw);

  // 4) JSON parsen
  let wishlist;
  try {
    wishlist = JSON.parse(raw || '[]');
    console.log('[Wishlist Debug] geparstes wishlist-Array =', wishlist);
  } catch (e) {
    console.error('[Wishlist Debug] JSON.parse Fehler:', e);
    return;
  }

  // 5) Validierung
  if (!Array.isArray(wishlist)) {
    console.warn('[Wishlist Debug] wishlist ist kein Array');
    return;
  }
  if (wishlist.length === 0) {
    console.log('[Wishlist Debug] wishlist ist leer');
    return;
  }
  console.log(`[Wishlist Debug] wishlist Länge: ${wishlist.length}`);

  // 6) Einträge laden und rendern
  ;(async () => {
    for (const [index, { route, id }] of wishlist.entries()) {
      console.log(`[Wishlist Debug] lade Eintrag #${index}: route=${route}, id=${id}`);
      try {
        const safeRoute = String(route || '').toLowerCase();
        const safeId = Number.parseInt(id, 10);
        if (!ALLOWED_ROUTES.has(safeRoute) || !Number.isInteger(safeId) || safeId <= 0) {
          console.warn('[Wishlist Debug] Ungültiger Bookmark-Eintrag übersprungen:', { route, id });
          continue;
        }

        const res = await fetch(`/buyer/wishlist/${encodeURIComponent(safeRoute)}/${safeId}`);
        console.log(`[Wishlist Debug] fetch-Status für ${route}/${id} =`, res.status);
        if (!res.ok) {
          console.warn(`[Wishlist Debug] Item nicht gefunden: ${route}/${id}`);
          continue;
        }
        const item = await res.json();
        console.log('[Wishlist Debug] JSON-Antwort item =', item);

        // Card-Element erstellen
        const card = document.createElement('div');
        card.className = 'cardPeter mb-4 me-4';

        const imageWrap = document.createElement('div');
        imageWrap.className = 'imageBild';

        const imageInner = document.createElement('div');
        imageInner.className = 'bild';

        const link = document.createElement('a');
        link.href = `/${safeRoute}/${safeId}/${encodeURIComponent(String(item.title || 'inserat'))}`;

        const img = document.createElement('img');
        img.src = String(item.mainpictureUrl || '/assets/herando-weblogo.png');
        img.alt = String(item.title || '');
        img.loading = 'lazy';

        link.appendChild(img);
        imageInner.appendChild(link);
        imageWrap.appendChild(imageInner);

        const infoWrap = document.createElement('div');
        infoWrap.className = 'informationSection pt-2';

        const productInfo = document.createElement('div');
        productInfo.className = 'productInfo';

        const titleEl = document.createElement('h5');
        titleEl.className = 'mb-1';
        titleEl.style.width = '400px';
        titleEl.textContent = String(item.title || '');

        const priceEl = document.createElement('p');
        priceEl.className = 'productPrice mb-2';
        priceEl.textContent = String(item.priceFormatted || '');

        productInfo.appendChild(titleEl);
        productInfo.appendChild(priceEl);
        infoWrap.appendChild(productInfo);

        card.appendChild(imageWrap);
        card.appendChild(infoWrap);
        grid.appendChild(card);

      } catch (err) {
        console.error('[Wishlist Debug] Fehler beim Laden von Wishlist-Item', route, id, err);
      }
    }

    // Optional: Scroll-Buttons
    const btnL = document.querySelector('.scroll-btn.left');
    const btnR = document.querySelector('.scroll-btn.right');
    if (btnL && btnR) {
      btnL.addEventListener('click', () =>
        grid.scrollBy({ left: -200, behavior: 'smooth' })
      );
      btnR.addEventListener('click', () =>
        grid.scrollBy({ left: +200, behavior: 'smooth' })
      );
    }
  })();
});
