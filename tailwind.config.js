/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 生活手帐风（方案 B）：纸白 + 墨色，语义色收进墨阶，印章红为唯一强调色
        // 语义色：事件=墨蓝、待办=墨绿、订阅=赭石（仅作辅助识别，不依赖颜色单独区分）
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
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          2: 'rgb(var(--surface-2) / <alpha-value>)',
        },
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        pencil: 'rgb(var(--pencil) / <alpha-value>)',
        brand: {
          DEFAULT: 'rgb(var(--brand) / <alpha-value>)',
          hover: 'rgb(var(--brand-hover) / <alpha-value>)',
        },
        // 和纸胶带 / 荧光笔
        tape: 'rgb(226 205 150 / <alpha-value>)',
        marker: 'rgb(238 206 120 / <alpha-value>)',
      },
      fontFamily: {
        // 正文：系统无衬线（手机端清晰、数字对齐）
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Noto Sans CJK SC"',
          'sans-serif',
        ],
        // 标题/手写句：手写楷体族，逐级回退（手机上命中 PingFang / Noto）
        serif: [
          '"LXGW WenKai"',
          '"Kaiti SC"',
          'KaiTi',
          '"STKaiti"',
          '"Songti SC"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        // 数字与日期：等宽 + tabular 对齐
        mono: ['ui-monospace', 'Menlo', 'Consolas', '"Noto Sans Mono CJK SC"', 'monospace'],
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '0.875rem',
      },
      boxShadow: {
        // 纸卡：极轻纸面投影 + 上一道高光边
        card: '0 1px 0 rgb(255 255 255 / .75) inset, 0 4px 12px rgb(88 72 40 / .07)',
        pop: '0 8px 32px rgb(0 0 0 / .12)',
      },
      backgroundImage: {
        // 点阵格纸
        'dot-grid': 'radial-gradient(circle, rgb(var(--line) / .5) 1px, transparent 1.15px)',
        // 手绘波浪分隔
        doodle: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='6' viewBox='0 0 24 6'%3E%3Cpath d='M0 4.5 Q 3 1.2 6 4.5 T 12 4.5 T 18 4.5 T 24 4.5' fill='none' stroke='%23C7BCA3' stroke-width='1.3' stroke-linecap='round'/%3E%3C/svg%3E\")",
      },
      backgroundSize: {
        'dot-grid': '22px 22px',
      },
    },
  },
  plugins: [],
};
