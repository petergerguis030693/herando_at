// public/js/buyer.js

document.addEventListener('DOMContentLoaded', () => {
  console.log('[Wishlist Debug] DOM geladen');

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
        const res = await fetch(`/buyer/wishlist/${route}/${id}`);
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
        card.innerHTML = `
          <div class="imageBild">
            <div class="bild">
                          <a href="/${route}/${id}/${encodeURIComponent(item.title)}">
              <img src="${item.mainpictureUrl}" 
                   alt="${item.title}" loading="lazy">
            </div>
          </div>
          <div class="informationSection pt-2">
            <div class="productInfo">

                <h5 class="mb-1" style="width: 400px">${item.title}</h5>
              </a>
              <p class="productPrice mb-2">${item.priceFormatted}</p>
            </div>
          </div>
        `;
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
