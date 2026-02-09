document.addEventListener("DOMContentLoaded", function () {
  // Finde alle Sections mit Carousels
  var sections = document.querySelectorAll(".my-prod-section");

  sections.forEach(function (section) {
    // Innerhalb der aktuellen Section:
    // Der Template-Container mit allen Produktkarten – er bleibt verborgen (d-none)
    var allProdsContainer = section.querySelector(".myAllProducts");
    // Wichtig: Wir klonen die Produktkarten, ohne den Container sichtbar zu machen.
    var allProds = allProdsContainer.children;
    var prods = Array.from(allProds);

    // Carousel-Elemente innerhalb der Section
    var slidesCont = section.querySelector(".my-carousel-slides");
    var dotsCont = section.querySelector(".my-carousel-nav-dots");

    // Gruppengröße je nach Viewport
    var groupSize;
    var winWidth = window.innerWidth;
    if (winWidth >= 1024) {         // Desktop: 4 Karten pro Slide
      groupSize = 4;
    } else if (winWidth >= 768) {     // Tablet: 2 Karten pro Slide
      groupSize = 2;
    } else {                        // Mobile: 1 Karte pro Slide
      groupSize = 1;
    }

    var slideCount = Math.ceil(prods.length / groupSize);
    var currentSlide = 0;

    // Erstelle die Slides und die Dots
    for (var i = 0; i < slideCount; i++) {
      var slideEl = document.createElement("div");
      slideEl.classList.add("my-carousel-slide");

      // Füge in diesem Slide bis zu groupSize Karten ein
      for (var j = i * groupSize; j < (i + 1) * groupSize && j < prods.length; j++) {
        slideEl.appendChild(prods[j].cloneNode(true));
      }
      slidesCont.appendChild(slideEl);

      // Erzeuge einen Dot (nur für Desktop-Navigation)
      var dotEl = document.createElement("button");
      dotEl.setAttribute("data-slide", i);
      if (i === 0) {
        dotEl.classList.add("active");
      }
      dotEl.addEventListener("click", function () {
        currentSlide = parseInt(this.getAttribute("data-slide"));
        updateMyCarousel();
      });
      dotsCont.appendChild(dotEl);
    }

    function updateMyCarousel() {
      var offset = -currentSlide * 100; // Jede Slide hat 100% Breite
      slidesCont.style.transform = "translateX(" + offset + "%)";

      // Update der Dots
      var dots = dotsCont.querySelectorAll("button");
      dots.forEach(function (dot, idx) {
        if (idx === currentSlide) {
          dot.classList.add("active");
        } else {
          dot.classList.remove("active");
        }
      });
    }

    // Pfeil-Navigation
    var prevBtn = section.querySelector(".my-carousel-prev");
    var nextBtn = section.querySelector(".my-carousel-next");

    prevBtn.addEventListener("click", function () {
      currentSlide = (currentSlide - 1 + slideCount) % slideCount;
      updateMyCarousel();
    });

    nextBtn.addEventListener("click", function () {
      currentSlide = (currentSlide + 1) % slideCount;
      updateMyCarousel();
    });
  });
});

