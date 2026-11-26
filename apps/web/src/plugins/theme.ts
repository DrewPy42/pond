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
    'error-text': '#B3261E',
    // Vuetify's own fills; without these it puts white text on them, which fails.
    info: '#2196F3',
    'on-info': brand.deepNavy,
    success: '#4CAF50',
    'on-success': brand.deepNavy,
    link: brand.linkTeal,
    'money-in': '#1B6B2F',
    'money-out': '#B3261E',
    // Chart series, checked for colour-blind separation. Red and green fail that check, so
    // charts use blue and orange.
    'chart-1': '#2A78D6',
    'chart-2': '#D9622B',
  },
  // Muted text (subtitles, field labels) is faded twice inside lists and fields: high times
  // medium. Vuetify's 0.6 medium is too faint there.
  variables: { 'high-emphasis-opacity': 0.87, 'medium-emphasis-opacity': 0.78 },
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
    'error-text': '#FF9A9A',
    // Vuetify's own fills; without these it puts white text on them, which fails.
    info: '#2196F3',
    'on-info': brand.deepNavy,
    success: '#4CAF50',
    'on-success': brand.deepNavy,
    link: '#7FD6BC',
    'money-in': '#7ED98F',
    'money-out': '#FF9A9A',
    'chart-1': '#3987E5',
    'chart-2': '#D95F28',
  },
  variables: { 'high-emphasis-opacity': 1, 'medium-emphasis-opacity': 0.7 },
}
