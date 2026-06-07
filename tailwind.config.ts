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
          bg:        '#07090F',
          surface:   '#0C0F1A',
          raised:    '#131824',
          border:    '#1C2236',
          accent:    '#F59E0B',
          'accent-hi': '#FCD34D',
          text:      '#E2E8F4',
          muted:     '#7B8BAF',
          faint:     '#374058',
        },
      },
      fontFamily: {
        sans:  ['var(--font-outfit)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-dm-serif)', 'Georgia', 'serif'],
        mono:  ['var(--font-mono)', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
export default config


