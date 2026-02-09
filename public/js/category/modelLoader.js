// /public/js/category/modelLoader.js

document.addEventListener("DOMContentLoaded", () => {
  const brandSelect = document.getElementById("fBrand");
  const modelSelect = document.getElementById("fModel");

  if (!brandSelect || !modelSelect) return;

  brandSelect.addEventListener("change", async () => {
    const brandId = brandSelect.value;

    // Reset der Modelle
    modelSelect.innerHTML = `<option value="">Beliebig</option>`;
    modelSelect.disabled = true;

    if (!brandId) return;

    // Entity aus globalem JS (scripts.ejs)
    const entity = window.currentEntityRoute;
    if (!entity) return;

    try {
      const res = await fetch(`/api/${entity}/models?brand=${brandId}`);
      if (!res.ok) throw new Error("Server error: " + res.status);

      const models = await res.json();

      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name;
        modelSelect.appendChild(opt);
      });

      modelSelect.disabled = models.length === 0;

    } catch (err) {
      console.error("🔥 modelLoader.js ERROR:", err);
    }
  });
});
