import type { ThemeDefinition } from 'vuetify'

/**
 * WibbitWorks palette. Contrast rule (WCAG AA, 4.5:1): green and teal are accents, never text
 * on light backgrounds and never with white text. Buttons use navy text on green. Links use
 * dark teal. Money colors are darker variants; always pair them with a sign or icon.
 */
export const brand = {
  froggyGreen: '#6CC24A',
  lilypadTeal: '#3FBF9D',
  deepNavy: '#1C2B39',
  softLemon: '#FEE191',
  cloudGray: '#F5F5F5',
  red: '#E85A5A', // brand accent: icons/borders only; navy text on it is 4.15:1
  errorFill: '#EE6F6F', // lightened so navy text passes 4.5:1
  linkTeal: '#1B7560',
} as const

export const pondLight: ThemeDefinition = {
  dark: false,
  colors: {
    background: brand.cloudGray,
    surface: '#FFFFFF',
    'on-background': brand.deepNavy,
    'on-surface': brand.deepNavy,
    primary: brand.froggyGreen,
    'on-primary': brand.deepNavy,
    secondary: brand.lilypadTeal,
    'on-secondary': brand.deepNavy,
    warning: brand.softLemon,
    'on-warning': brand.deepNavy,
    error: brand.errorFill,
    'on-error': brand.deepNavy,
    link: brand.linkTeal,
    'money-in': '#1B6B2F',
    'money-out': '#B3261E',
  },
}

export const pondDark: ThemeDefinition = {
  dark: true,
  colors: {
    background: '#141F29',
    surface: brand.deepNavy,
    'on-background': brand.cloudGray,
    'on-surface': brand.cloudGray,
    primary: brand.froggyGreen,
    'on-primary': brand.deepNavy,
    secondary: brand.lilypadTeal,
    'on-secondary': brand.deepNavy,
    warning: brand.softLemon,
    'on-warning': brand.deepNavy,
    error: brand.errorFill,
    'on-error': brand.deepNavy,
    link: '#7FD6BC',
    'money-in': '#7ED98F',
    'money-out': '#FF9A9A',
  },
}
