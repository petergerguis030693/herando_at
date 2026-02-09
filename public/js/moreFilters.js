// /public/js/category/moreFilters.js

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector(".filter-form");
  const btn = document.getElementById("openFilterPage");

  if (!form || !btn) return;

  function serializeForm(formElement) {
    const params = new URLSearchParams();
    const formData = new FormData(formElement);

    // Normale Felder
    formData.forEach((value, key) => {
      if (value !== null && value !== "") {
        params.append(key, value);
      }
    });

    // Mehrfach-Selects explizit verarbeiten
    form.querySelectorAll("select[multiple]").forEach(sel => {
      [...sel.options].forEach(opt => {
        if (opt.selected) params.append(sel.name, opt.value);
      });
    });

    // Checkboxen per name gruppieren
    const grouped = {};
    form.querySelectorAll('input[type="checkbox"][name]').forEach(cb => {
      grouped[cb.name] ||= [];
      if (cb.checked) grouped[cb.name].push(cb.value);
    });

    Object.entries(grouped).forEach(([name, values]) => {
      values.forEach(v => params.append(name, v));
    });

    return params;
  }

  btn.addEventListener("click", () => {
    const entity = window.currentEntityRoute;
    if (!entity) {
      console.warn("moreFilters.js → Entity not found!");
      return;
    }

    // Filter sammeln
    const params = serializeForm(form);

    // hp = Seite 1 setzen
    params.set("hp", "1");

    // Weiterleiten zur großen Filterseite
    const url = `/${encodeURIComponent(entity)}/filters?${params.toString()}`;
    window.location.href = url;
  });

});
