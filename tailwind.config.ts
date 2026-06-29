import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // 工业 B2B 科技感配色
        graphite: {
          DEFAULT: "#0B0F14",
          50: "#1A1F26",
          100: "#222831",
          200: "#2D3540",
          300: "#3A4452",
        },
        steel: {
          DEFAULT: "#1E5BFF",
          light: "#3D75FF",
          dark: "#0F3FCC",
        },
        gold: {
          DEFAULT: "#D4A24C",
          light: "#E6BC6E",
          dark: "#A87B30",
        },
      },
      fontFamily: {
        sans: [
          "HarmonyOS Sans SC",
          "Manrope",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Microsoft YaHei",
          "sans-serif",
        ],
        display: ["Manrope", "HarmonyOS Sans SC", "sans-serif"],
      },
      maxWidth: {
        h5: "480px",
      },
      animation: {
        "fade-in": "fadeIn 0.4s ease-out",
        "slide-up": "slideUp 0.4s ease-out",
        "shimmer": "shimmer 1.5s infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-1000px 0" },
          "100%": { backgroundPosition: "1000px 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
