// the map's colours, read from colors.css. canvases and deck.gl can't use css
// variables, so they ask here instead - and they ask each time they draw, so an
// edit to colors.css shows up on the next redraw

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

// the variable's value as written, ready for a canvas fillStyle
export function themeVar(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const parsed = new Map<string, RGBA>();
let probe: CanvasRenderingContext2D | undefined;

// a variable as 0-255 numbers, whatever css colour it's written as - the
// browser does the parsing, by painting it
export function themeRGBA(name: string): RGBA {
    const value = themeVar(name);
    let c = parsed.get(value);
    if (!c) {
        if (!probe) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            probe = canvas.getContext('2d', {willReadFrequently: true})!;
        }
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = '#000';
        probe.fillStyle = value || '#000';
        probe.fillRect(0, 0, 1, 1);
        const d = probe.getImageData(0, 0, 1, 1).data;
        c = [d[0], d[1], d[2], d[3]];
        parsed.set(value, c);
    }
    return c;
}

export const themeRGB = (name: string): RGB => themeRGBA(name).slice(0, 3) as RGB;

// --process-1, --process-2... for as many as colors.css has
export function processPalette(): RGB[] {
    const style = getComputedStyle(document.documentElement);
    const out: RGB[] = [];
    for (let i = 1; style.getPropertyValue(`--process-${i}`).trim(); i++) out.push(themeRGB(`--process-${i}`));
    return out.length ? out : [[200, 205, 212]];
}
