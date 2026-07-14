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
        // KZQ public-site design tokens: premium graphite + restrained warm gold.
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
          soft: "#5B5F62",
          mute: "#8D9093",
          line: "rgba(20,23,25,0.10)",
        },
        // Legacy semantic palette retained for existing public/admin screens.
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
          dark: "#8C6B30",
        },
        // —— 向后兼容旧配色（后台仍在使用，勿删） ——
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
          dark: "#8C6B30",
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
        display: ["Manrope", "PingFang SC", "HarmonyOS Sans SC", "sans-serif"],
      },
      maxWidth: {
        h5: "440px",
        // 响应式内容容器宽度
        content: "1360px", // desktop B2B catalog content width
        "content-narrow": "1024px", // 窄内容（如关于页正文）
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
        '4xl': '2rem',
      },
      animation: {
        "fade-in": "fadeIn 0.35s ease-out",
        "slide-up": "slideUp 0.4s ease-out",
        "shimmer": "shimmer 1.5s infinite",
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
