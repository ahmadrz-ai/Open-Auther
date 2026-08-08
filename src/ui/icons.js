/*
 * Material-style icon set.
 *
 * Hand-authored on the Material 24x24 grid, stroke-based with rounded joins to
 * match Material Symbols (Rounded). Inline SVG rather than an icon font: the
 * dashboard must work with no network access at all, and a font would be one
 * more asset to ship and cache-bust.
 */

const P = {
  home: '<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z"/>',
  hub: '<circle cx="12" cy="12" r="2.4"/><circle cx="5" cy="6" r="1.9"/><circle cx="19" cy="6" r="1.9"/><circle cx="5" cy="18" r="1.9"/><circle cx="19" cy="18" r="1.9"/><path d="m10.3 10.6-3.7-3.2M13.7 10.6l3.7-3.2M10.3 13.4l-3.7 3.2M13.7 13.4l3.7 3.2"/>',
  key: '<circle cx="8" cy="12" r="3.4"/><path d="M11.4 12H20M17.5 12v3M14.5 12v2.2"/>',
  personAdd: '<circle cx="10" cy="8" r="3.4"/><path d="M4 20c0-3.1 2.7-5.2 6-5.2 1.2 0 2.3.3 3.2.8M18 14v6M15 17h6"/>',
  link: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1.2 1.2"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0L6 13a3.5 3.5 0 0 0 5 5l1.2-1.2"/>',
  monitor: '<path d="M4 19V5M4 19h16"/><path d="m7 15 3.2-4.2 3 2.4L18 7"/>',
  logs: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>',
  health: '<path d="M3 12h4l2-5 3 10 2.5-6 1.5 3h5"/>',
  runtime: '<rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5"/>',
  compress: '<path d="M12 3v6M9.5 6.5 12 9l2.5-2.5M12 21v-6M9.5 17.5 12 15l2.5 2.5M4 12h16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M18 6l-1.4 1.4M7.4 16.6 6 18M18 18l-1.4-1.4M7.4 7.4 6 6"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M6.5 7l.8 12a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1l.8-12M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="m14.5 6.5 3 3"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  close: '<path d="M6 6 18 18M18 6 6 18"/>',
  warning: '<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 16.8v.2"/>',
  error: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 15.8v.2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  logout: '<path d="M14 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8"/><path d="M17 8.5 20.5 12 17 15.5M20.5 12H10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m15.5 15.5 4 4"/>',
  bolt: '<path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12z"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4-3 7-7 8.5C8 19 5 16 5 12V6z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  cloud: '<path d="M7.5 18.5A4 4 0 0 1 7 10.6a5 5 0 0 1 9.6-1.1A3.8 3.8 0 0 1 17 18.5z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  external: '<path d="M14 5h5v5"/><path d="M19 5 11 13"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>',
  chat: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M8.5 9.5h7M8.5 12.5h4"/>',
  // Assistant avatar. Deliberately simple: `hub` has nine elements and turns to
  // mush below about 18px.
  spark: '<path d="M12 4c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6z"/>',
  eye: '<path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  eyeOff: '<path d="M4 4 20 20"/><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.4 4.2M6.3 7.8A17 17 0 0 0 2.5 12S6 19 12 19a9.4 9.4 0 0 0 3.3-.6"/><path d="M9.6 9.9a3 3 0 0 0 4.3 4.2"/>',
};

/**
 * Render an icon. `size` is the rendered box; the path grid is always 24.
 * Filled icons (play, bolt, home) still read correctly with a stroke because
 * they are drawn as closed shapes.
 */
export function icon(name, size = 20, extraClass = "") {
  const body = P[name] ?? P.hub;
  return (
    `<svg class="icon ${extraClass}" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
    `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

export const ICON_NAMES = Object.keys(P);
