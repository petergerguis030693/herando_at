// /public/js/category/lifestyleSubLoader.js

document.addEventListener("DOMContentLoaded", () => {
  const mainSelect = document.getElementById("fLifeType");
  const subSelect = document.getElementById("fLifeSub");

  // Nur auf Lifestyle-Seiten aktiv
  if (!mainSelect || !subSelect) return;

  // Reset Funktion
  function resetSubcategories() {
    subSelect.innerHTML = `<option value="">Beliebig</option>`;
    subSelect.disabled = true;
  }

  // Init-Reset falls es keine Daten gibt
  resetSubcategories();

  mainSelect.addEventListener("change", async () => {
    const mainId = mainSelect.value;

    resetSubcategories();

    // Keine Auswahl → kein API-Call
    if (!mainId) return;

    try {
      const res = await fetch(`/api/lifestyle-subcategories?brand_id=${mainId}`);
      if (!res.ok) throw new Error("Server responded with " + res.status);

      const data = await res.json();

      // Optionen einfügen
      data.forEach(sub => {
        const opt = document.createElement("option");
        opt.value = sub.id;
        opt.textContent = sub.name;
        subSelect.appendChild(opt);
      });

      subSelect.disabled = data.length === 0;

    } catch (err) {
      console.error("🔥 lifestyleSubLoader.js ERROR:", err);
    }
  });
});
