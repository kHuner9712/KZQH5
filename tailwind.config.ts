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
        // 暖白 / 米白 / 浅灰主调（高端 B2B 产品目录）
        canvas: {
          DEFAULT: "#F7F6F3", // 暖白页面底
          warm: "#FAF8F4", // 卡片暖底
          cool: "#F2F4F7", // 浅灰冷底
        },
        ink: {
          DEFAULT: "#1A1D21", // 主文字深墨
          soft: "#4A5158",   // 次级文字
          mute: "#8A8F96",   // 辅助文字
          line: "#E8E6E1",   // 浅暖分隔线
        },
        // 工业蓝点缀（CTA / 强调）
        industrial: {
          DEFAULT: "#1E3A5F", // 深工业蓝
          50: "#EAF0F7",
          100: "#D5E2EF",
          400: "#4A7BA8",
          500: "#2E5E8A",
          600: "#1E3A5F",
          700: "#16293F",
        },
        // 金色点缀（品牌 / 主推）
        brass: {
          DEFAULT: "#B08542",
          light: "#D4B373",
          dark: "#8A6630",
        },
        // —— 向后兼容旧配色（后台仍在使用，勿删） ——
        graphite: {
          DEFAULT: "#1A1D21",
          50: "#2A2E33",
          100: "#222831",
          200: "#2D3540",
          300: "#3A4452",
        },
        steel: {
          DEFAULT: "#1E3A5F",
          light: "#4A7BA8",
          dark: "#16293F",
        },
        gold: {
          DEFAULT: "#B08542",
          light: "#D4B373",
          dark: "#8A6630",
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
      },
      boxShadow: {
        card: "0 1px 3px rgba(26,29,33,0.04), 0 1px 2px rgba(26,29,33,0.06)",
        "card-hover": "0 8px 24px rgba(26,29,33,0.08), 0 2px 6px rgba(26,29,33,0.04)",
        soft: "0 4px 16px rgba(26,29,33,0.05)",
        ring: "0 0 0 1px rgba(26,29,33,0.05)",
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
