/**
 * Tailwind CSS configuration: content paths and theme extensions for the App Router UI.
 */
import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
        cp: {
          bg:            '#F6F6F3',
          surface:       '#FFFFFF',
          raised:        '#FBFBF9',
          border:        '#E4E3DD',
          'border-soft': '#EFEEE9',
          accent:        '#2563EB',
          text:          '#18181B',
          muted:         '#65656E',
          faint:         '#9A9AA2',
          primary:       '#2563EB',
          'primary-soft': '#EEF3FE',
          'primary-tint': '#F5F8FF',
          orange:        '#E67824',
          'orange-soft': '#FCF0E6',
        },
      },
      fontFamily: {
        sans: ['var(--font-hanken)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
export default config


