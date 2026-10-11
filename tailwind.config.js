/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 语义色：事件=蓝、待办=绿、订阅=琥珀（PRD 3.2）
        event: {
          DEFAULT: '#3b82f6',
          soft: 'rgb(59 130 246 / 0.12)',
        },
        task: {
          DEFAULT: '#10b981',
          soft: 'rgb(16 185 129 / 0.12)',
        },
        subscription: {
          DEFAULT: '#f59e0b',
          soft: 'rgb(245 158 11 / 0.12)',
        },
        surface: 'rgb(var(--surface) / <alpha-value>)',
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        brand: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
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
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      boxShadow: {
        card: '0 1px 2px rgb(0 0 0 / 0.04), 0 1px 3px rgb(0 0 0 / 0.06)',
        pop: '0 8px 32px rgb(0 0 0 / 0.12)',
      },
    },
  },
  plugins: [],
};
