(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var modal = document.getElementById('settingsModal');
    var openBtn = document.getElementById('settingsButton');
    var closeBtn = document.getElementById('closeModal');
    var cancelBtn = document.getElementById('cancelBtn');
    var saveBtn = document.getElementById('saveBtn');

    if (openBtn && modal) {
      openBtn.addEventListener('click', function () { modal.classList.remove('d-none'); });
    }
    if (closeBtn && modal) {
      closeBtn.addEventListener('click', function () { modal.classList.add('d-none'); });
    }
    if (cancelBtn && modal) {
      cancelBtn.addEventListener('click', function () { modal.classList.add('d-none'); });
    }

    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) modal.classList.add('d-none');
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var lang = document.getElementById('languageSelect').value;
        var currency = document.getElementById('currencySelect').value;
        var country = document.getElementById('countrySelect').value;
        window.location.href = '/lang/' + lang + '?currency=' + encodeURIComponent(currency) + '&country=' + encodeURIComponent(country);
      });
    }
  });

  window.addEventListener('load', function () {
    var loader = document.getElementById('page-loader');
    if (!loader) return;
    loader.style.opacity = '0';
    setTimeout(function () {
      loader.remove();
    }, 300);
  });
})();
