import type { Config } from 'tailwindcss'
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: '#0A2540',
        accent: '#1E88E5',
      },
      borderRadius: {
        xl: '0.75rem',
        '2xl': '1rem'
      }
    },
  },
  plugins: [],
}
export default config
