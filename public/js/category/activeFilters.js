// /public/js/category/activeFilters.js

document.addEventListener("DOMContentLoaded", () => {
  const container = document.querySelector(".active-filters");
  if (!container) return;

  const entity = window.currentEntityRoute;
  if (!entity) return;

  const queryString = window.location.search.substring(1);

  // API: übersetzte Filter holen
  fetch(`/api/${entity}/translate-filters?${queryString}`)
    .then(res => res.json())
    .then(data => {
      container.innerHTML = ""; // Reset

      Object.entries(data).forEach(([key, label]) => {
        // Technische Parameter ignorieren
        if (["hp", "page", "limit", "sort", "view"].includes(key)) return;

        // Leere oder Null-Filter ignorieren
        if (!label || label === "" || label === "0") return;

        // URL ohne diesen Filter generieren
        const url = new URL(window.location.href);
        url.searchParams.delete(key);

        // Tag erstellen
        const tag = document.createElement("a");
        tag.href = url.toString();
        tag.className = "filter-tag";
        tag.innerHTML = `${label} <span class="x">×</span>`;

        container.appendChild(tag);
      });
    })
    .catch(err => console.error("activeFilters.js ERROR:", err));
});
