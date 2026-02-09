// /public/js/category/filters.js

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector(".filter-form");
  if (!form) return;

  // Events sollen countReload.js und (optional) reloadResults.js triggern
  const EVENT_FILTER_CHANGED = "filterChanged";

  let debounceTimer = null;

  // Allgemeiner Event-Handler für jedes Filterfeld
  function handleFilterEvent() {
    clearTimeout(debounceTimer);

    // Sofortiger Count-Update (spezialisierter Listener in countReload.js)
    document.dispatchEvent(new CustomEvent(EVENT_FILTER_CHANGED));

    // Reload erst nach kurzer Pause (damit nicht jeder Tastendruck lädt)
    debounceTimer = setTimeout(() => {
      document.dispatchEvent(new Event("filterReload"));
    }, 400);
  }

  // Alle Input-Elemente holen
  const inputs = form.querySelectorAll("input, select");

  inputs.forEach(input => {
    // bei Änderung sofort Event auslösen
    input.addEventListener("change", handleFilterEvent);

    // bei Texteingaben – mit Verzögerung
    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      document.dispatchEvent(new CustomEvent(EVENT_FILTER_CHANGED));

      debounceTimer = setTimeout(() => {
        document.dispatchEvent(new Event("filterReload"));
      }, 600);
    });
  });

});
