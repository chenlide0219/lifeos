/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 语义色：事件=蓝、待办=绿、订阅=琥珀（PRD 3.2）
        event: {
          DEFAULT: 'rgb(var(--event) / <alpha-value>)',
          soft: 'rgb(var(--event) / 0.10)',
        },
        task: {
          DEFAULT: 'rgb(var(--task) / <alpha-value>)',
          soft: 'rgb(var(--task) / 0.10)',
        },
        subscription: {
          DEFAULT: 'rgb(var(--subscription) / <alpha-value>)',
          soft: 'rgb(var(--subscription) / 0.10)',
        },
        surface: 'rgb(var(--surface) / <alpha-value>)',
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          hover: 'rgb(var(--brand-hover) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
      },
      borderRadius: {
        xl: '0.625rem',
        '2xl': '0.875rem',
      },
      boxShadow: {
        card: '0 2px 6px rgb(20 35 28 / 0.025)',
        pop: '0 8px 32px rgb(0 0 0 / 0.12)',
      },
    },
  },
  plugins: [],
};
