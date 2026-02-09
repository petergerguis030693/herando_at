// /public/js/category/slider.js

document.addEventListener("DOMContentLoaded", () => {
  const track = document.querySelector(".slider-track");
  const btnLeft = document.querySelector(".scroll-btn.left");
  const btnRight = document.querySelector(".scroll-btn.right");

  if (!track || !btnLeft || !btnRight) return;

  /**
   * Ermittelt Breite einer Karte +
   * deren rechten margin.
   */
  function getCardWidth() {
    const card = track.querySelector(".product-item");
    if (!card) return 350;

    const style = window.getComputedStyle(card);
    const marginRight = parseInt(style.marginRight) || 20;

    return card.offsetWidth + marginRight;
  }

  /**
   * Nach rechts scrollen
   */
  btnRight.addEventListener("click", () => {
    track.scrollBy({
      left: getCardWidth(),
      behavior: "smooth"
    });
  });

  /**
   * Nach links scrollen
   */
  btnLeft.addEventListener("click", () => {
    track.scrollBy({
      left: -getCardWidth(),
      behavior: "smooth"
    });
  });

});
