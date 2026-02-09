let currentIndex = 0;

function startSlider() {
  const slides = document.querySelectorAll(".slide");
  const totalSlides = slides.length;

  setInterval(() => {
    // Aktuelles Bild ausblenden
    slides[currentIndex].classList.remove("active");

    // Zum nächsten Bild wechseln
    currentIndex = (currentIndex + 1) % totalSlides;

    // Nächstes Bild einblenden
    slides[currentIndex].classList.add("active");
  }, 6000); // Alle 6 Sekunden wechseln
}

document.addEventListener("DOMContentLoaded", startSlider);

const container = document.getElementById("marken-container");
const prevButton = document.getElementById("prev");
const nextButton = document.getElementById("next");

let currentOffset = 0; // Aktueller Offset-Wert in Pixeln
const slideAmount = 200; // Verschiebung um 200px pro Klick

function updateSlider() {
    items.forEach((item, index) => {
        if (index >= cIndex && index < cIndex + visibleItems) {
            item.style.opacity = '1';
            item.style.transform = 'translateX(0)';
        } else if (index < cIndex) {
            item.style.opacity = '0';
            item.style.transform = 'translateX(-100%)';
        } else {
            item.style.opacity = '0';
            item.style.transform = 'translateX(100%)';
        }
    });
}



nextButton.addEventListener("click", () => {
  const maxOffset = -(container.scrollWidth - container.offsetWidth);
  if (currentOffset > maxOffset) {
    currentOffset -= slideAmount;
    if (currentOffset < maxOffset) currentOffset = maxOffset; // Begrenzung
    updateSlider();
  }
});

prevButton.addEventListener("click", () => {
  if (currentOffset < 0) {
    currentOffset += slideAmount;
    if (currentOffset > 0) currentOffset = 0; // Begrenzung
    updateSlider();
  }
});

let translateX = 0; // Verschiebungswert

prevButton.addEventListener("click", () => {
  translateX += 100; // Nach links verschieben
  container.style.transform = `translateX(${translateX}px)`;
});

nextButton.addEventListener("click", () => {
  translateX -= 100; // Nach rechts verschieben
  container.style.transform = `translateX(${translateX}px)`;
});

const heartIcon = document.getElementById("heart");

// Lade den gespeicherten Status aus dem localStorage
if (heartIcon) {
  const isHeartActive = localStorage.getItem("heartActive") === "true";
  if (isHeartActive) {
    heartIcon.classList.add("active"); // Aktivieren, wenn im Speicher gespeichert
  }

  // Füge ein Klick-Event hinzu
  heartIcon.addEventListener("click", () => {
    heartIcon.classList.toggle("active"); // Status umschalten

    // Speichere den aktuellen Status im localStorage
    const heartStatus = heartIcon.classList.contains("active");
    localStorage.setItem("heartActive", heartStatus); // Speichern
  });
} else {
  console.error('Herz-Element mit der ID "heart" wurde nicht gefunden.');
}


function setupSliderById(sliderId) {
  const section = document.querySelector(`#${sliderId}`);
  if (!section) {
      console.warn(`Section mit ID "${sliderId}" wurde nicht gefunden.`);
      return;
  }

  const track = section.querySelector('.sliderTrack');
  const cards = section.querySelectorAll('.productCard');
  const leftArrow = section.querySelector('.sliderArrow.left');
  const rightArrow = section.querySelector('.sliderArrow.right');

  if (!track || !leftArrow || !rightArrow) {
      console.warn(`Fehlende Elemente in Slider "${sliderId}".`);
      return;
  }

  let cI = 0; // Startposition für diesen Slider
  const cardWidth = 400 + 100; // Breite eines Produkts inkl. Abstand
  const visibleCards = 5; // Anzahl der sichtbaren Karten
  const maxIndex = Math.max(cards.length - visibleCards, 0);

  // Funktion zum Nach-links-Sliden
  leftArrow.addEventListener('click', () => {
      if (cI > 0) {
          cI--;
          updateSliderPosition();
      }
  });

  // Funktion zum Nach-rechts-Sliden
  rightArrow.addEventListener('click', () => {
      if (cI < maxIndex) {
          cI++;
          updateSliderPosition();
      }
  });

  function updateSliderPosition() {
      const translateX = -(cI * cardWidth);
      track.style.transform = `translateX(${translateX}px)`;
  }
}

// Initialisiere Slider
['slider1', 'slider2', 'slider3', 'slider4'].forEach(setupSliderById);



