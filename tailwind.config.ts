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
        page: "#0D0F10",
        surface: {
          DEFAULT: "#141719",
          elevated: "#1D2023",
        },
        canvas: {
          DEFAULT: "#F4F1EA",
          warm: "#FAF8F3",
          cool: "#EFECE5",
        },
        ink: {
          DEFAULT: "#25282B",
          soft: "#4A4D50",
          mute: "#8D9093",
          line: "rgba(20,23,25,0.10)",
        },
        industrial: {
          DEFAULT: "#25282B",
          50: "#EEE9DE",
          100: "#E3D9C5",
          400: "#C5A15A",
          500: "#A98643",
          600: "#25282B",
          700: "#141719",
        },
        brass: {
          DEFAULT: "#C5A15A",
          light: "#D9BD82",
          dark: "#A8853F",
        },
        graphite: {
          DEFAULT: "#141719",
          50: "#1D2023",
          100: "#25282B",
          200: "#34383B",
          300: "#4A4F52",
        },
        steel: {
          DEFAULT: "#1E3A5F",
          light: "#4A7BA8",
          dark: "#16293F",
        },
        gold: {
          DEFAULT: "#C5A15A",
          light: "#D9BD82",
          dark: "#A8853F",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "HarmonyOS Sans SC",
          "Segoe UI",
          "Microsoft YaHei",
          "sans-serif",
        ],
        display: [
          "Songti SC",
          "STSong",
          "Noto Serif CJK SC",
          "Georgia",
          "Times New Roman",
          "serif",
        ],
      },
      maxWidth: {
        h5: "440px",
        content: "1320px",
        "content-narrow": "1024px",
      },
      screens: {
        xs: "375px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(13,15,16,0.06)",
        "card-hover": "0 12px 30px rgba(13,15,16,0.10)",
        soft: "0 8px 24px rgba(13,15,16,0.08)",
        ring: "0 0 0 1px rgba(20,23,25,0.08)",
      },
      borderRadius: {
        "4xl": "2rem",
      },
      animation: {
        "fade-in": "fadeIn 0.35s ease-out",
        "slide-up": "slideUp 0.4s ease-out",
        shimmer: "shimmer 1.5s infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
