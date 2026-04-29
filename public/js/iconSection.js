document.addEventListener("DOMContentLoaded", () => {

  const route = (location.pathname.split("/").filter(Boolean)[0] || "").toLowerCase();
  const ITEM  = window.HERANDO_ITEM || {};  // item-Daten werden im EJS gesetzt

  console.log("🔥 iconSection geladen, route =", route);
  console.log("📦 ITEM:", ITEM);

  const I18N = window.I18N || {};
  const LC = I18N.carLabels || {};
  const LW = I18N.watchLabels || {};
  const LP = I18N.propertyLabels || {};
  const LY = I18N.yachtLabels || {};

  const norm = s => (s ?? "").toString().trim().toLowerCase();

  // Spec-Fallbacks (Deutsch)
  const fallbackCar = {
    model: "modell",
    mileage: "kilometerstand",
    transmission: "getriebe",
    firstReg: "erstzulassung",
    fuel: "kraftstoff",
    power: "leistung",
    color: "farbe"
  };

  const iconCol = (icon, label, value) => {
    if (!value) return "";
    return `
      <div class="col">
        <div class="d-flex align-items-start gap-3">
          <i class="bi bi-${icon} icon-xl text-muted"></i>
          <div>
            <div class="small text-muted">${label}</div>
            <div class="fw-semibold">${value}</div>
          </div>
        </div>
      </div>
    `;
  };

  const brandTile = (brand, label) => {
    if (!brand) return "";
    const seo = (ITEM.brand_seoname || "").toString().trim();
    const slug = seo
      ? seo.split("/").filter(Boolean).pop()
      : brand.toLowerCase().replace(/\s+/g, "-");
    const logo = slug ? `/images/cms/brands/${encodeURIComponent(slug)}.jpg` : "";
    return `
      <div class="col">
        <div class="d-flex align-items-center">
          <img src="${logo}" alt="${brand}" width="38" height="38" onerror="this.style.display='none'"
               style="height:38px;width:auto;margin-right:.6rem;">
          <div>
            <div class="small text-muted">${label}</div>
            <div class="fw-semibold">${brand}</div>
          </div>
        </div>
      </div>
    `;
  };

  const renderGrid = cols => {
    const html = cols.filter(Boolean).join("");
    if (!html) return;

    const target = document.getElementById("iconsSection");
    if (!target) return console.warn("⚠️ iconsSection fehlt im DOM!");

    target.innerHTML = `
      <div class="${route}-specs card border-0 mb-4">
        <div class="container py-3" style="max-width:1500px;">
          <div class="row g-3 justify-content-center row-cols-2 row-cols-sm-3 row-cols-md-4 row-cols-lg-6">
            ${html}
          </div>
        </div>
      </div>
    `;
  };

  // -----------------------------------------
  // ✔ CARS
  // -----------------------------------------
  if (route === "cars") {
    const cols = [
      brandTile(ITEM.brandName, "Marke"),
      iconCol("badge-ad",     LC.model || "Modell", ITEM.modelName),
      iconCol("speedometer",  LC.mileage || "Kilometer", ITEM.mileage),
      iconCol("gear",         LC.transmission || "Getriebe", ITEM.transmission),
      iconCol("calendar3",    LC.firstReg || "EZ", ITEM.firstregistration),
      iconCol("fuel-pump",    LC.fuel || "Treibstoff", ITEM.fuel),
      iconCol("tachometer",   LC.power || "Leistung", ITEM.power),
      iconCol("palette",      LC.color || "Farbe", ITEM.exterior_color)
    ];

    return renderGrid(cols);
  }

  // -----------------------------------------
  // ✔ WATCHES
  // -----------------------------------------
  if (route === "watches") {
    const cols = [
      brandTile(ITEM.brandName, LW.brand || "Marke"),
      iconCol("watch", LW.model || "Modell", ITEM.modelName),
      iconCol("hash", LW.reference || "Referenz", ITEM.reference),
      iconCol("cpu", LW.movement || "Werk", ITEM.movement),
      iconCol("rulers", LW.diameter || "Durchmesser", ITEM.diameter ? ITEM.diameter + " mm" : ""),
      iconCol("drop", LW.waterproof || "Wasser", ITEM.waterproof ? ITEM.waterproof + " ATM" : "")
    ];

    return renderGrid(cols);
  }

  // -----------------------------------------
  // ✔ PROPERTIES
  // -----------------------------------------
  if (route === "properties") {
    const cols = [
      iconCol("geo-alt", LP.location || "Ort", ITEM.location),
      iconCol("house", LP.type || "Typ", ITEM.type),
      iconCol("aspect-ratio", LP.living || "Wohnfläche", ITEM.living),
      iconCol("grid", LP.rooms || "Zimmer", ITEM.rooms),
      iconCol("calendar3", LP.built || "Baujahr", ITEM.built)
    ];

    return renderGrid(cols);
  }

  // -----------------------------------------
  // ✔ YACHTS
  // -----------------------------------------
  if (route === "yachts") {
    const cols = [
      brandTile(ITEM.brandName, LY.brand || "Marke"),
      iconCol("rulers", LY.length || "Länge", ITEM.length),
      iconCol("arrows-expand", LY.beam || "Breite", ITEM.beam),
      iconCol("water", LY.draft || "Tiefgang", ITEM.draft),
      iconCol("gear-wide", LY.engines || "Motor", ITEM.engines),
      iconCol("calendar3", LY.year || "Baujahr", ITEM.year)
    ];

    return renderGrid(cols);
  }

});
