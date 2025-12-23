/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--bg-dark)",
        panel: "var(--bg-panel)",
        primary: "var(--primary-green)",
        dim: "var(--dim-green)",
        border: "var(--border-color)",
        textMain: "var(--text-main)",
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
