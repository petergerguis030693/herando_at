document.addEventListener("DOMContentLoaded", () => {
  const heroContent = {
    "/yachts": {
      img: "/assets/yachten.jpg",
      caption: "Luxury Yachts",
      text: "Discover luxury yachts & superyachts worldwide."
    },
    "/cars": {
      img: "/assets/cars.jpg",
      caption: "Luxury Cars",
      text: "Explore exclusive cars and supercars worldwide."
    },
    "/watches": {
      img: "/assets/watches.jpg",
      caption: "Luxury Watches",
      text: "Timeless elegance with exclusive watches."
    },
    "/properties": {
      img: "/assets/properties.jpg",
      caption: "Luxury Properties",
      text: "Find your dream property around the world."
    },
    "/lifestyles": {
      img: "/assets/lifestyle.jpg",
      caption: "Luxury Lifestyle",
      text: "Experience the world of luxury lifestyle."
    }
  };

  const path = window.location.pathname;

  for (const key in heroContent) {
    if (path.startsWith(key)) {
      const heroImage = document.getElementById("heroImage");
      const heroCaption = document.getElementById("heroCaption");
      const heroText = document.getElementById("heroText");

      if (heroImage) heroImage.src = heroContent[key].img;
      if (heroCaption) heroCaption.textContent = heroContent[key].caption;
      if (heroText) heroText.textContent = heroContent[key].text;

      break; // erstes Match reicht
    }
  }
});

(function () {
  const form = document.getElementById('quickFilters');
  if (!form) return;

  const route = window.currentEntityRoute || '';

  function ensureOption(select, val, labelFn) {
    if (!val) return;
    const exists = Array.from(select.options).some(o => String(o.value) === String(val));
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = String(val);
      opt.textContent = labelFn ? labelFn(val) : String(val);
      opt.selected = true;
      select.appendChild(opt);
    }
  }

  function fillSelect(id, steps, selected, labelFn) {
    const el = form.querySelector(id);
    if (!el) return;
    steps.forEach(v => {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = labelFn ? labelFn(v) : String(v);
      if (String(selected || '') === String(v)) opt.selected = true;
      el.appendChild(opt);
    });
    ensureOption(el, selected, labelFn);
  }

  const qp = new URLSearchParams(location.search);

  // Preis-Stufen je Route
  const priceSelected = qp.get('priceMax') || '';
  const priceStepsByRoute = {
    cars: [1000, 2500, 5000, 10000, 15000, 20000, 30000, 50000, 75000, 100000, 150000, 200000, 300000, 500000],
    watches: [500, 1000, 2500, 5000, 10000, 20000, 50000, 100000, 250000, 500000],
    yachts: [25000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000],
    properties: [50000, 100000, 250000, 500000, 750000, 1000000, 2000000, 5000000, 10000000],
    lifestyles: [1000, 2500, 5000, 10000, 25000, 50000, 100000]
  };
  fillSelect('#fPriceMax', priceStepsByRoute[route] || priceStepsByRoute.cars, priceSelected, v => v.toLocaleString('de-DE') + ' €');

  // Properties: Fläche/Zimmer/Bäder Stufen
  if (route === 'properties') {
    fillSelect('#fLivingAreaMin',
      [50, 75, 100, 150, 200, 300, 500, 750, 1000],
      qp.get('livingAreaMin') || qp.get('areaMin'),
      v => `${v} m²`);
    fillSelect('#fRoomsMin', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], qp.get('roomsMin'), v => `${v}+`);
    fillSelect('#fBathsMin', [1, 2, 3, 4, 5, 6], qp.get('bathroomsMin'), v => `${v}+`);
  }

  // Yachts: Länge
  if (route === 'yachts') {
    fillSelect('#fLengthMax', [8, 10, 12, 15, 18, 20, 24, 30, 40, 50, 70, 100], qp.get('lengthMax'), v => `${v} m`);
  }

if (['cars', 'watches', 'yachts'].includes(route)) {
  const brand = form.querySelector('#fBrand');
  if (brand) {
    brand.addEventListener('change', () => {
      const model = form.querySelector('#fModel');
      if (model) {
        model.value = "";
        model.dispatchEvent(new Event('change'));
      }
    });
  }
}


  // Cars: Elektro-Sync
  if (route === 'cars') {
    const elec = form.querySelector('#onlyElectric');
    const hiddenFuel = form.querySelector('#hiddenFuel');
    const fuels = window.filtersFuels || [];
    const electric = fuels.find(f => String(f.name).toLowerCase().includes('elektr'));
    const elecId = electric ? electric.id : '';

    const urlFuelAll = qp.getAll('fuel');
    if (elecId && urlFuelAll.includes(String(elecId))) elec.checked = true;

    const syncFuel = () => hiddenFuel.value = (elec.checked && elecId) ? elecId : '';
    elec && elec.addEventListener('change', syncFuel);
    syncFuel();
  }

      // Cars: Oldtimer-Sync (20+ Jahre)
if (route === 'cars') {
  const old = form.querySelector('#onlyOldtimer');
  const hiddenOld = form.querySelector('#hiddenOldtimer');

  if (!old || !hiddenOld) return;

  const qpOnlyOldtimer = qp.get('onlyOldtimer');
  if (qpOnlyOldtimer === '1') old.checked = true;

  const syncOld = () => {
    hiddenOld.value = old.checked ? '1' : '';
  };

  old.addEventListener('change', syncOld);
  syncOld();
}



  // Button "Mehr Filter"
  const btnMore = document.getElementById('openFilterPage');
  if (btnMore) {
    btnMore.addEventListener('click', () => {
      const params = new URLSearchParams(new FormData(form));
      const base = location.pathname.replace(/\/$/, '');
      location.href = `${base}/filters?${params.toString()}`;
    });
  }
})();

// Scroll Buttons
document.addEventListener('DOMContentLoaded', () => {
  const container = document.querySelector('.product-container');
  const btnLeft = document.querySelector('.scroll-btn.left');
  const btnRight = document.querySelector('.scroll-btn.right');
  if (!container || !btnLeft || !btnRight) return;

  btnLeft.addEventListener('click', () =>
    container.scrollBy({ left: -400, behavior: 'smooth' })
  );
  btnRight.addEventListener('click', () =>
    container.scrollBy({ left: 400, behavior: 'smooth' })
  );
}); 


(function () {
  const params = new URLSearchParams(window.location.search);
  const current = parseInt(params.get('hp') || '1', 10);
  const limit = parseInt(params.get('limit') || window.paginationLimit || 10, 10);

  params.delete('hp');
  params.delete('limit');

  const extraQS = params.toString() ? '&' + params.toString() : '';
  const total = window.totalPages || 1;
  const blockSize = 5;
  const blockIdx = Math.floor((current - 1) / blockSize);
  const start = blockIdx * blockSize + 1;
  const end = Math.min(start + blockSize - 1, total);

  const container = document.getElementById('pagination');
  if (!container) return;

  let html = '';

  const mkLink = (page, label, cls = 'page-link') =>
    `<a href="?hp=${page}&limit=${limit}${extraQS}" class="${cls}">${label}</a>`;
  const mkSpan = (label, cls) =>
    `<span class="${cls}">${label}</span>`;

  html += current > 1
    ? mkLink(current - 1, '❮', 'btn-nav')
    : mkSpan('❮', 'btn-nav disabled');

  if (start > 1) {
    html += mkLink(start - 1, '«', 'page-link');
  }

  for (let p = start; p <= end; p++) {
    html += (p === current)
      ? mkSpan(p, 'page-current')
      : mkLink(p, p, 'page-link');
  }

  if (end < total) {
    html += mkLink(end + 1, '»', 'page-link');
  }

  html += current < total
    ? mkLink(current + 1, '❯', 'btn-nav')
    : mkSpan('❯', 'btn-nav disabled');

  container.innerHTML = html;
})();

$(function () {
  $('.filter-select').select2({
    placeholder: 'Filter auswählen',
    allowClear: true,
    width: 'resolve'
  });

  $('.filter-select.auto-submit').on('change', function () {
    if (this.form) {
      this.form.submit();
    }
  });
});


(function () {
if (!/^\/watches(\/|$)/.test(window.location.pathname)) return;

  function styleBildImgs() {
    document.querySelectorAll('.bild img').forEach(img => {
      img.style.width          = '350px';
      img.style.height         = '410px';
      img.style.objectFit      = 'cover';
      img.style.objectPosition = 'top';
      img.style.display        = 'block';
      img.style.margin         = '0 auto';

      const cardLink = img.closest('a');
      if (cardLink) {
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => {
          window.location.href = cardLink.href;
        });
      }
    });
  }

  function styleProductItemImgs() {
    document.querySelectorAll('.product-item img').forEach(img => {
      img.style.height = '265px';
    });
  }

  function styleProductItems() {
    document.querySelectorAll('.product-item').forEach(item => {
      item.style.height = '350px';
      item.style.width = '294px';
    });
  }

  function init() {
    styleBildImgs();
    styleProductItemImgs();
    styleProductItems();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }
})();

(function () {
if (!/^\/cars(\/|$)/.test(window.location.pathname)) return;

  function init() {
    document.querySelectorAll('.bild img').forEach(img => {
      // Standard-Styles (Desktop ab 1024px)
      img.style.width          = '400px';
      img.style.height         = '280px';
      img.style.objectFit      = 'cover';
      img.style.objectPosition = 'top';
      img.style.display        = 'block';
      img.style.margin         = '0 auto';

      // Überschreiben für Mobile/Tablet (0–1023px)
      if (window.innerWidth <= 1023) {
        img.style.width          = 'auto';
        img.style.height         = 'auto';
        img.style.objectFit      = 'cover';   // kannst du auch "contain" setzen
        img.style.objectPosition = 'center';
      }

      // Klick → Link im neuen Tab öffnen
      const cardLink = img.closest('a');
      if (cardLink) {
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => {
          window.location.href = cardLink.href;
        });
      }
    });

    // Entfernt alle H1 auf /cars
    document.querySelectorAll('h1').forEach(h1 => h1.remove());
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }

  // Falls jemand das Fenster resized → Bilder neu anpassen
  window.addEventListener('resize', init);
})();


(function () {
  if (!/^\/yachts(\/|$)/.test(window.location.pathname)) return;

  function init() {
    document.querySelectorAll('.bild img').forEach(img => {
      img.style.width          = '400px';
      img.style.height         = '300px';
      img.style.objectPosition = 'top';
      img.style.display        = 'block';
      img.style.margin         = '0 auto';

      const cardLink = img.closest('a');
      if (!cardLink) return;

      img.style.cursor = 'pointer';
      img.addEventListener('click', () => {
        window.location.href = cardLink.href;
      });
    });

    // Entfernt alle H1 auf /yachts
    document.querySelectorAll('h1').forEach(h1 => h1.remove());
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }
})();

(function () {
if (!/^\/properties(\/|$)/.test(window.location.pathname)) return;

  function init() {
    document.querySelectorAll('.bild img').forEach(img => {
      img.style.width          = '400px';
      img.style.height         = '300px';
      img.style.objectFit      = 'cover';
      img.style.borderRadius   = '10px';
      img.style.margin         = '0 auto';

      const cardLink = img.closest('a');
      if (!cardLink) return;

      img.style.cursor = 'pointer';
      img.addEventListener('click', () => {
        window.location.href = cardLink.href;
      });
    });

    // Entfernt alle H1 auf /yachts
    document.querySelectorAll('h1').forEach(h1 => h1.remove());
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }
})();

(function () {
  if (!/^\/lifestyles(\/|$)/.test(window.location.pathname)) return;

  function init() {
    document.querySelectorAll('.bild img').forEach(img => {
      // 1) Basis-Styling
      img.style.width          = '350px';
      img.style.height         = '420px';
      img.style.objectPosition = 'center';
      img.style.display        = 'block';
      img.style.margin         = '0 auto';
      
      img.style.imageRendering = 'optimizeQuality';
      img.style.filter = 'contrast(1.02) brightness(1.01) saturate(1.05)';
      img.style.backfaceVisibility = 'hidden'; 
      img.style.transform = 'translateZ(0)'; 

      const cardLink = img.closest('a');
      if (!cardLink) return;

      img.style.cursor = 'pointer';
      img.addEventListener('click', () => {
        window.location.href = cardLink.href;
      });
    });
  }

  if (document.readyState === 'loading') {
    window.addEventListener('load', init);
  } else {
    init();
  }
})();

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.filter-select-container').forEach(container => {
    const btn = container.querySelector('.filter-select-toggle');
    if (!btn) return;

    btn.addEventListener('click', () => {
      container.classList.toggle('open');
    });

    document.addEventListener('click', e => {
      if (!container.contains(e.target)) {
        container.classList.remove('open');
      }
    });
  });
});

$(function () {
  // Init Select2
  $('.filter-select').select2({
    placeholder: 'Filter auswählen',
    allowClear: true,
    width: 'resolve'
  });

  // Models Select
  const modelSelect = $('select[name="model"]').prop('disabled', true);

  $('select[data-dynamic="model"]')
    .on('change select2:select select2:unselect', function () {
      const brands = $(this).val() || [];
      if (!brands.length) {
        modelSelect.empty().prop('disabled', true).trigger('change.select2');
        return;
      }
      const basePath = window.location.pathname.split('/').slice(0, 2).join('/');
      $.ajax({
        url: `${basePath}/api/models`,
        data: { brand: brands },
        traditional: true,
        dataType: 'json'
      })
        .done(models => {
          modelSelect.empty();
          models.forEach(m => {
            modelSelect.append($('<option>').val(m.id).text(m.name));
          });
          modelSelect.prop('disabled', false).trigger('change.select2');
        })
        .fail((xhr, status, err) => {
          console.error('❌ AJAX-Fehler /api/models:', status, err);
        });
    });

  // Year Select (für Yachten)
  const yearSelect = $('select[name="yearMin"]'); // NICHT disabled setzen
  $('select[data-dynamic="year"]')
    .on('change select2:select select2:unselect', function () {
      const types = $(this).val() || [];
      yearSelect.empty();
      if (!types.length) {
        return;
      }
      const basePath = window.location.pathname.split('/').slice(0, 2).join('/');
      $.ajax({
        url: `${basePath}/api/yachtYears`,
        data: { type: types },
        traditional: true,
        dataType: 'json'
      })
        .done(years => {
          years.forEach(y => {
            yearSelect.append($('<option>').val(y).text(y));
          });
        })
        .fail((xhr, status, err) => {
          console.error('❌ AJAX-Fehler /api/yachtYears:', status, err);
        });
    });
});

document.addEventListener('DOMContentLoaded', () => {
  const marker = '</h1>';
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.includes(marker)) {
      node.nodeValue = node.nodeValue
        .replace(new RegExp(marker, 'gi'), '')
        .trim();
    }
  }
});

