<script>
document.addEventListener("DOMContentLoaded", () => {

  const heroContent = {
    "/yachts": {
      img: "/assets/yachten.jpg",
      caption: "Luxury Yachts",
      text: "Discover luxury yachts & superyachts worldwide."
    },
    "/cars": {
      img: "/assets/cars.jpg",
      caption: "Luxury Cars",
      text: "Explore exclusive cars and supercars worldwide."
    },
    "/watches": {
      img: "/assets/watches.jpg",
      caption: "Luxury Watches",
      text: "Timeless elegance with exclusive watches."
    },
    "/properties": {
      img: "/assets/properties.jpg",
      caption: "Luxury Properties",
      text: "Find your dream property around the world."
    },
    "/lifestyles": {
      img: "/assets/lifestyle.jpg",
      caption: "Luxury Lifestyle",
      text: "Experience the world of luxury lifestyle."
    }
  };

  const path = window.location.pathname;

  for (const key in heroContent) {
    if (path.startsWith(key)) {
      const heroImage = document.getElementById("heroImage");
      const heroCaption = document.getElementById("heroCaption");
      const heroText = document.getElementById("heroText");

      heroImage.src = heroContent[key].img;
      heroCaption.textContent = heroContent[key].caption;
      heroText.textContent = heroContent[key].text;

      break;
    }
  }
});
</script>