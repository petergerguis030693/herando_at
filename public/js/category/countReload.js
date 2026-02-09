// /public/js/category/countReload.js

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector(".filter-form");
  const resultCountEl = document.querySelector("#resultCount");
  const listingContainer = document.querySelector(".listing-container");

  if (!form || !listingContainer) return;

  let abortCtrl = null;

  /* --------------------------------------------------------
   * 1) Live-Count abrufen
   * ------------------------------------------------------ */
  async function updateCountOnly() {
    const entity = window.currentEntityRoute;
    if (!entity) return;

    const params = new URLSearchParams(new FormData(form));
    const url = `/api/${entity}/count?${params.toString()}`;

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    try {
      const res = await fetch(url, { signal: abortCtrl.signal });
      const data = await res.json();

      if (data.count !== undefined && resultCountEl) {
        resultCountEl.textContent = data.count;
      }

    } catch (err) {
      if (err.name !== "AbortError") console.error("Count Error:", err);
    }
  }

  /* --------------------------------------------------------
   * 2) Produkte via AJAX laden
   * ------------------------------------------------------ */
  async function reloadResults() {
    const entity = window.currentEntityRoute;
    if (!entity) return;

    const params = new URLSearchParams(new FormData(form));
    const url = `${window.location.pathname}?${params.toString()}`;

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    try {
      const htmlRes = await fetch(url, { signal: abortCtrl.signal });
      const html = await htmlRes.text();

      const tempDOM = document.createElement("div");
      tempDOM.innerHTML = html;

      const newList = tempDOM.querySelector(".listing-container");
      const oldList = document.querySelector(".listing-container");

      if (newList && oldList) {
        oldList.innerHTML = newList.innerHTML;
      }

    } catch (err) {
      if (err.name !== "AbortError") console.error("Reload Error:", err);
    }
  }

  /* --------------------------------------------------------
   * 3) Events aus filters.js hören
   * ------------------------------------------------------ */
  document.addEventListener("filterChanged", updateCountOnly);
  document.addEventListener("filterReload", reloadResults);

  /* --------------------------------------------------------
   * 4) Direkt beim ersten Laden den Count holen
   * ------------------------------------------------------ */
  updateCountOnly();

});
