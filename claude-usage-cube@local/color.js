// Percent -> cube color. Pure, no GNOME imports, so it can be tested with plain gjs.

export const STOPS = [
    [0, [0x22, 0x8b, 0x22]],   // forest green #228b22
    [30, [0x22, 0x8b, 0x22]],  // ...held flat up to 30 %
    [50, [0xf6, 0xd3, 0x2d]],  // yellow #f6d32d
    [75, [0xff, 0x78, 0x00]],  // orange #ff7800
    [90, [0xe0, 0x1b, 0x24]],  // red    #e01b24
];

export const UNKNOWN_COLOR = '#77767b'; // grey for unknown / error states

function hex(rgb) {
    return `#${rgb.map(c => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

const UNKNOWN_RGB = [0x77, 0x76, 0x7b];

// [r, g, b], 0-255, not rounded.
export function percentToRgb(percent) {
    if (typeof percent !== 'number' || !Number.isFinite(percent))
        return UNKNOWN_RGB;

    const p = Math.min(Math.max(percent, 0), 100);
    for (let i = 1; i < STOPS.length; i++) {
        const [p1, c1] = STOPS[i];
        if (p <= p1) {
            const [p0, c0] = STOPS[i - 1];
            const t = (p - p0) / (p1 - p0);
            return c0.map((c, k) => c + (c1[k] - c) * t);
        }
    }
    return STOPS[STOPS.length - 1][1];
}

export function percentToColor(percent) {
    return hex(percentToRgb(percent));
}
