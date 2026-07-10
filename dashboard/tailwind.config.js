const wisteria = {
  50: '#f1ecf8',
  100: '#e3d9f2',
  200: '#c6b3e5',
  300: '#aa8dd8',
  400: '#8d67cb',
  500: '#7141be',
  600: '#5a3498',
  700: '#442772',
  800: '#2d1a4c',
  900: '#170d26',
  950: '#10091b',
};

const cerulean = {
  50: '#eaf5fa',
  100: '#d5ecf6',
  200: '#acd9ec',
  300: '#82c6e3',
  400: '#59b3d9',
  500: '#2fa0d0',
  600: '#2680a6',
  700: '#1c607d',
  800: '#134053',
  900: '#09202a',
  950: '#07161d',
};

const evergreen = {
  50: '#eef6f2',
  100: '#ddeee5',
  200: '#bbddca',
  300: '#99ccb0',
  400: '#77bb96',
  500: '#55aa7b',
  600: '#448863',
  700: '#33664a',
  800: '#224431',
  900: '#112219',
  950: '#0c1811',
};

const smokyRose = {
  50: '#f4f0f1',
  100: '#e9e2e3',
  200: '#d3c5c6',
  300: '#bda8aa',
  400: '#a78b8e',
  500: '#916e71',
  600: '#74585b',
  700: '#574244',
  800: '#3a2c2d',
  900: '#1d1617',
  950: '#140f10',
};

const darkAmaranth = {
  50: '#faebed',
  100: '#f5d6db',
  200: '#eaaeb8',
  300: '#e08594',
  400: '#d55d71',
  500: '#cb344d',
  600: '#a22a3e',
  700: '#7a1f2e',
  800: '#51151f',
  900: '#290a0f',
  950: '#1c070b',
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#7141be', // wisteria-500
          dark: '#5a3498', // wisteria-600
        },
        wisteria,
        cerulean,
        evergreen,
        'smoky-rose': smokyRose,
        'dark-amaranth': darkAmaranth,

        // Map standard Tailwind colors to ensure ONLY the requested colors are used
        slate: smokyRose,
        gray: smokyRose,
        zinc: smokyRose,
        neutral: smokyRose,
        stone: smokyRose,

        red: darkAmaranth,
        rose: darkAmaranth,
        orange: darkAmaranth,

        amber: evergreen,
        yellow: evergreen,
        lime: evergreen,
        green: evergreen,
        emerald: evergreen,

        teal: cerulean,
        cyan: cerulean,
        sky: cerulean,
        blue: cerulean,

        indigo: wisteria,
        violet: wisteria,
        purple: wisteria,
        fuchsia: wisteria,
        pink: wisteria,

        surface: 'rgba(241, 236, 248, 0.04)', // wisteria-50
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};

