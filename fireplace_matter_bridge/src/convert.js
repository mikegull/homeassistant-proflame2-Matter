// Pure conversion helpers between Home Assistant values and Matter attribute values.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Proflame step (1..steps) -> Matter LevelControl level (1..254). */
export function stepToLevel(step, steps) {
    return clamp(Math.round((step * 254) / steps), 1, 254);
}

/** Matter level (1..254) -> step (1..steps); never 0, use on/off for that. */
export function levelToStep(level, steps) {
    return clamp(Math.round((level * steps) / 254), 1, steps);
}

/** HA brightness (0..255) <-> Matter level (1..254). */
export function brightnessToLevel(brightness) {
    return clamp(Math.round((brightness * 254) / 255), 1, 254);
}
export function levelToBrightness(level) {
    return clamp(Math.round((level * 255) / 254), 1, 255);
}

/** Fan step (0..steps) <-> Matter percent (0..100). */
export function stepToPercent(step, steps) {
    return clamp(Math.round((step * 100) / steps), 0, 100);
}
export function percentToStep(percent, steps) {
    if (!percent) return 0;
    return clamp(Math.round((percent * steps) / 100), 1, steps);
}

/** HA temperature in the HA unit -> Matter temperature (0.01 °C). */
export function haTempToMatter(value, unit) {
    const c = unit === "°F" ? ((value - 32) * 5) / 9 : value;
    return Math.round(c * 100);
}

/** Matter temperature (0.01 °C) -> HA temperature in the HA unit, rounded to `step`. */
export function matterTempToHa(value, unit, step = unit === "°F" ? 1 : 0.5) {
    const c = value / 100;
    const t = unit === "°F" ? (c * 9) / 5 + 32 : c;
    return Math.round(t / step) * step;
}

/** HA hs_color [0..360, 0..100] <-> Matter hue/saturation (0..254). */
export function hsToMatter([h, s]) {
    return { hue: clamp(Math.round((h / 360) * 254), 0, 254), saturation: clamp(Math.round((s / 100) * 254), 0, 254) };
}
export function matterToHs(hue, saturation) {
    return [Math.round((hue / 254) * 360 * 10) / 10, Math.round((saturation / 254) * 100 * 10) / 10];
}

/** HA xy_color [0..1, 0..1] <-> Matter currentX/currentY (0..65279). */
export function xyToMatter([x, y]) {
    return { x: clamp(Math.round(x * 65536), 0, 65279), y: clamp(Math.round(y * 65536), 0, 65279) };
}
export function matterToXy(x, y) {
    return [Math.round((x / 65536) * 10000) / 10000, Math.round((y / 65536) * 10000) / 10000];
}

export const kelvinToMireds = k => clamp(Math.round(1_000_000 / k), 1, 65279);
export const miredsToKelvin = m => Math.round(1_000_000 / m);

/** Matter BridgedDeviceBasicInformation.nodeLabel is limited to 32 characters. */
export function label(text) {
    return text.length <= 32 ? text : text.slice(0, 32).trimEnd();
}

/** Endpoint ids must not contain dots. */
export function endpointId(text) {
    return text.replace(/[^a-zA-Z0-9_-]/g, "_");
}
